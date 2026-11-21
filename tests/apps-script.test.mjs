import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { connector, connectorAddress } from "../transport.mjs";

const source = readFileSync(new URL("../connector/apps-script/Code.gs", import.meta.url), "utf8");
const folder = "fixture_root";
const nested = "fixture_nested";
const note = "fixture_markdown";
const noteRoute = "folders/" + folder + "/notes/" + note;
const code = "c".repeat(64);
const initial = "# Plan X CAS fixture\n\nТестовая правка\n";
const folderType = "application/vnd.google-apps.folder";
const md5 = (value) => createHash("md5").update(value).digest("hex");
function fakeResponse(data, status = 200) {
  const text = typeof data === "string" ? data : JSON.stringify(data);
  return { getContent: () => [...Buffer.from(text)], getContentText: () => text, getResponseCode: () => status };
}

function fakePilot() {
  let revision = 1;
  let markdown = initial;
  let moved = false;
  let puts = 0;
  let calls = 0;
  const config = {
    PLANX_ACCESS_CODE: code,
    PLANX_PILOT_FOLDER_ID: folder,
    PLANX_PILOT_NOTE_ID: note,
    PLANX_PILOT_WRITES: "yes",
  };
  const context = {
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => config[key] }) },
    CacheService: { getScriptCache: () => ({ get: () => "synthetic-token" }) },
    ContentService: {
      MimeType: { JSON: "json" },
      createTextOutput: body => ({ setMimeType: () => body }),
    },
    Utilities: {
      base64EncodeWebSafe: value => Buffer.from(value).toString("base64url"),
      computeHmacSha256Signature: (value, key) => createHmac("sha256", key).update(value).digest(),
      computeDigest: (name, bytes) => [...createHash(name).update(Buffer.from(bytes)).digest()],
      DigestAlgorithm: { MD5: "md5" },
      newBlob: value => ({ getBytes: () => [...Buffer.from(value)] }),
      getUuid: () => "synthetic-uuid",
    },
    UrlFetchApp: {
      fetch(address, options) {
        calls++;
        const url = new URL(address);
        const id = url.pathname.split("/").at(-1);
        const etag = '"' + revision + '"';
        if (options.method === "put") {
          assert.equal(id, note);
          assert.equal(options.headers["If-Match"], etag);
          puts++;
          markdown = options.payload.split("\r\n\r\n").at(-1).split("\r\n--planx-")[0];
          revision++;
          return fakeResponse({ id });
        }
        if (id === folder) return fakeResponse({ id, mimeType: folderType, name: "Пилот", trashed: false });
        if (id === nested) return fakeResponse({ id, mimeType: folderType, name: "Вложенная", parents: [folder], trashed: false });
        if (id !== note) return fakeResponse({ error: "outside" }, 404);
        if (url.pathname.includes("/v2/")) return fakeResponse({ id, version: String(revision), etag });
        if (url.searchParams.get("alt") === "media") return fakeResponse(markdown);
        return fakeResponse({
          id, parents: [moved ? "different_root" : nested], name: "planx-cas-fixture.md",
          version: String(revision), md5Checksum: md5(markdown), mimeType: "text/markdown",
          trashed: false, capabilities: { canModifyContent: true },
        });
      },
    },
  };
  runInNewContext(source, context);
  return {
    post: (route, method, payload, token) => JSON.parse(context.doPost({
      postData: { contents: JSON.stringify({ route, method, payload, token }) },
    })),
    move: () => { moved = true; },
    get calls() { return calls; },
    get puts() { return puts; },
  };
}

test("Apps Script pilot only reads its fixture and rejects stale or out-of-folder saves", () => {
  const pilot = fakePilot();
  assert.equal(pilot.post(noteRoute, "GET").status, 401);
  assert.equal(pilot.post("session", "POST", { code: "incorrect" }).status, 401);
  const login = pilot.post("session", "POST", { code });
  assert.equal(login.status, 200);
  const token = login.data.token;
  assert.equal(pilot.post(noteRoute + "-other", "GET", undefined, token).status, 404);
  assert.equal(pilot.calls, 0);

  const tree = pilot.post("folders/" + folder + "/tree", "GET", undefined, token).data;
  assert.deepEqual(tree.at(-1).path, ["Вложенная", "planx-cas-fixture.md"]);
  const read = pilot.post(noteRoute, "GET", undefined, token);
  assert.deepEqual(read.data, { markdown: initial, editable: true, version: '"1"' });
  const reply = pilot.post(noteRoute, "PUT", { markdown: initial + "\nЕщё строка\n", version: '"1"' }, token);
  assert.deepEqual(reply, { status: 200, data: { saved: true } });
  assert.match(pilot.post(noteRoute, "GET", undefined, token).data.markdown, /Ещё строка/);
  assert.equal(pilot.post(noteRoute, "PUT", { markdown: initial, version: '"1"' }, token).status, 409);
  pilot.move();
  assert.equal(pilot.post(noteRoute, "PUT", { markdown: initial, version: '"2"' }, token).status, 404);
  assert.equal(pilot.puts, 1);
});

test("Apps Script transport sends a simple CORS request and preserves application conflicts", async () => {
  const endpoint = "https://script.google.com/macros/s/fixture_deployment_xxxxxxxxxx/exec";
  assert.equal(connectorAddress(endpoint), endpoint);
  assert.throws(() => connectorAddress(endpoint.replace("script.google.com", "script.google.com.example.org")));
  const pilot = fakePilot();
  let token;
  const app = connector(endpoint, () => token, (url, options) => {
    assert.equal(url, endpoint);
    assert.equal(options.method, "POST");
    assert.equal(options.redirect, "follow");
    assert.equal(options.credentials, "omit");
    assert.deepEqual(options.headers, { "Content-Type": "text/plain;charset=UTF-8" });
    const { route, method, payload, token: session } = JSON.parse(options.body);
    return Response.json(pilot.post(route, method, payload, session));
  });
  token = (await app.login(code)).token;
  assert.equal((await app.folders())[0].id, folder);
  await assert.rejects(app.save(folder, note, { markdown: initial, version: '"0"' }), { code: "conflict" });
});
