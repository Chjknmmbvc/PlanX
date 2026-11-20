import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { driveVault } from "../connector/drive.mjs";
import { createHandler } from "../connector/server.mjs";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";

const rootId = "isolated_root";
const inner = "nested_folder";
const doc = "fixture_note";
const folder = (id, name, parent) => ({
  id, name, parents: [parent], mimeType: "application/vnd.google-apps.folder", trashed: false, version: "1",
});
function fakeDrive({ atomicWrites = true, staleMedia = false, hasChecksum = true } = {}) {
  let version = 1;
  let text = "# Fictional";
  const requests = [];
  const files = [
    folder(rootId, "Тест", "parent_root"),
    folder(inner, "Подпапка", rootId),
    folder("nested_two", "Вторая", inner),
    { id: "shortcut_that_points_outside", name: "Shortcut.md", mimeType: "application/vnd.google-apps.shortcut", parents: [rootId], trashed: false },
    { id: "outside_note", name: "Outside.md", mimeType: "text/markdown", parents: ["other_root"], trashed: false },
    folder("other_root", "Другой диск", "parent_root"),
  ];
  function data() {
    return [...files, { id: doc, name: "Fixture.md", mimeType: "text/markdown", parents: ["nested_two"],
      trashed: false, version: String(version), capabilities: { canModifyContent: true },
      md5Checksum: hasChecksum ? createHash("md5").update(text).digest("hex") : undefined }];
  }
  const etag = () => '"fixture-' + version + '"';
  const vault = driveVault({ rootId, atomicWrites, getToken: async () => "mock", request: async (url, options) => {
    requests.push({ url, options });
    const id = url.pathname.split("/").at(-1);
    if (id === "files") {
      const parent = url.searchParams.get("q").split("'")[1];
      const list = data().filter((entry) => entry.parents.includes(parent));
      return Response.json(url.searchParams.has("pageToken")
        ? { files: list.slice(1) } : { files: list.slice(0, 1), nextPageToken: list.length > 1 ? "next" : "" });
    }
    const item = data().find((file) => file.id === id);
    if (!item) return new Response("", { status: 404 });
    if (options.method === "PUT") {
      if (options.headers["If-Match"] !== etag()) return new Response("", { status: 412 });
      text = options.body.split("\r\n\r\n")[2].split("\r\n--planx-")[0];
      version++;
      return Response.json({ id });
    }
    if (url.searchParams.get("alt") === "media") return new Response(staleMedia ? "# Predecessor" : text);
    if (url.pathname.includes("/v2/")) return Response.json({ id, version: item.version, etag: etag() });
    return Response.json(item);
  } });
  return { vault, requests };
}

test("walks nested and paginated folders, rejecting shortcuts and outside file reads", async () => {
  const { vault, requests } = fakeDrive();
  const entries = await vault.tree(rootId);
  assert.deepEqual(entries.map((file) => file.id), [inner, "nested_two", doc]);
  assert.deepEqual(entries.at(-1).path, ["Подпапка", "Вторая", "Fixture.md"]);
  await assert.rejects(vault.tree("other_root"), { code: "outside" });
  await assert.rejects(vault.read("outside_note"), { code: "outside" });
  assert.equal(requests.some(({ url }) => url.pathname.endsWith("/outside_note") && url.searchParams.has("alt")), false);
});

test("conditionally writes the same ID and never retries a failed compare", async () => {
  const { vault, requests } = fakeDrive();
  const base = await vault.read(doc);
  await vault.save(doc, { markdown: "# First", version: base.version });
  assert.equal((await vault.read(doc)).markdown, "# First");
  await assert.rejects(vault.save(doc, { markdown: "# Stale", version: base.version }), { code: "conflict" });
  const writes = requests.filter(({ options }) => options.method === "PUT");
  assert.equal(writes.length, 1);
  assert.match(writes[0].url.pathname, /\/upload\/drive\/v2\/files\/fixture_note$/);
  assert.equal(writes[0].options.headers["If-Match"], base.version);
  assert.equal(await vault.read(doc).then(({ markdown }) => markdown), "# First");
});

test("concurrent attempts with one predecessor get one winner on an emulated provider", async () => {
  const { vault } = fakeDrive();
  const { version } = await vault.read(doc);
  const writes = await Promise.allSettled(["A", "B"].map((markdown) => vault.save(doc, { version, markdown })));
  const win = writes.map((entry) => entry.status).indexOf("fulfilled");
  assert.ok(win >= 0);
  assert.equal(writes[1 - win].reason.code, "conflict");
  assert.equal((await vault.read(doc)).markdown, ["A", "B"][win]);
});

test("writes are unavailable until provider behavior has been checked", async () => {
  const { vault, requests } = fakeDrive({ atomicWrites: false });
  const snapshot = await vault.read(doc);
  assert.equal(snapshot.editable, false);
  await assert.rejects(vault.save(doc, snapshot), { code: "read_only" });
  assert.equal(requests.some(({ options }) => options.method === "PUT"), false);
});

test("rejects stale media and never edits against an unverified snapshot", async () => {
  const stale = fakeDrive({ staleMedia: true });
  await assert.rejects(stale.vault.read(doc), { code: "conflict" });
  const unverified = fakeDrive({ hasChecksum: false });
  const snapshot = await unverified.vault.read(doc);
  assert.equal(snapshot.markdown, "# Fictional");
  assert.equal(snapshot.editable, false);
  await assert.rejects(unverified.vault.save(doc, snapshot), { code: "read_only" });
  assert.equal(unverified.requests.some(({ options }) => options.method === "PUT"), false);
});

test("HTTP handler restricts origin and folder, and expires its session", async () => {
  const { vault } = fakeDrive();
  let now = Date.now();
  const origin = "https://example.invalid";
  const code = "11".repeat(32);
  const handler = createHandler({ vault, origin, folderId: rootId, accessCode: code, now: () => now });
  async function call(url, { method = "GET", token, data, host = origin } = {}) {
    const request = Object.assign(Readable.from(data ? [Buffer.from(JSON.stringify(data))] : []), {
      url, method, headers: { origin: host, "content-type": "application/json",
        ...(token ? { authorization: "Bearer " + token } : {}) },
    });
    const response = Object.assign(new EventEmitter(), {
      setHeader() {}, writeHead(status) { this.status = status; },
      end(value) { this.data = JSON.parse(value); },
    });
    await handler(request, response);
    return response;
  }
  assert.equal((await call("/v1/folders")).status, 401);
  const login = await call("/v1/session", { method: "POST", data: { code } });
  assert.equal(login.status, 200);
  const { token } = login.data;
  assert.equal((await call("/v1/folders", { token, host: "https://elsewhere.invalid" })).status, 403);
  assert.equal((await call("/v1/folders/other_root/tree", { token })).status, 404);
  assert.equal((await call("/v1/folders", { token })).data[0].id, rootId);
  now = login.data.expiresAt;
  assert.equal((await call("/v1/folders", { token })).status, 401);
});
