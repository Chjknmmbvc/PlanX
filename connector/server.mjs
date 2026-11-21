import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { driveVault, DriveError, maxNoteBytes, validId } from "./drive.mjs";
import { serviceAccountToken } from "./google-auth.mjs";

const lifetime = 12 * 60 * 60 * 1000;

async function readJson(request, limit) {
  if (!/^application\/json(?:;|$)/i.test(request.headers["content-type"] || "")) {
    throw new DriveError("request", 415);
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    length += chunk.length;
    if (length > limit) {
      request.resume();
      throw new DriveError("too_large", 413);
    }
    chunks.push(chunk);
  }
  try {
    const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (data && typeof data === "object" && !Array.isArray(data)) return data;
  } catch {}
  throw new DriveError("request", 400);
}

export function createHandler({ vault, folderId, origin, accessCode, now = Date.now }) {
  if (new URL(origin).origin !== origin || !validId(folderId) ||
      typeof accessCode !== "string" || !/^[A-Fa-f0-9]{64}$/.test(accessCode)) {
    throw new Error("Configure one folder, origin and a 32-byte hex access code");
  }
  const setStatus = (response, status, data) => {
    response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(data));
  };
  const hmac = (value) => createHmac("sha256", accessCode).update(value).digest("base64url");
  const same = (a, b) => {
    const x = Buffer.from(a), y = Buffer.from(b);
    return x.length === y.length && timingSafeEqual(x, y);
  };
  const validSession = (authorization) => {
    const parts = authorization?.match(/^Bearer (\d{13})\.([A-Za-z0-9_-]{43})$/);
    return !!parts && Number(parts[1]) > now() && same(parts[2], hmac("session:" + parts[1]));
  };
  return async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Vary", "Origin");
    const remoteOrigin = request.headers.origin;
    if (remoteOrigin !== undefined && remoteOrigin !== origin) return setStatus(response, 403, { error: "origin" });
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }
    const { method, url } = request;
    try {
      if (url === "/v1/session" && method === "POST") {
        const { code } = await readJson(request, 1024);
        if (typeof code !== "string" || !same(hmac("code:" + code), hmac("code:" + accessCode))) {
          throw new DriveError("auth", 401);
        }
        const expiresAt = now() + lifetime;
        return setStatus(response, 200, { expiresAt, token: expiresAt + "." + hmac("session:" + expiresAt) });
      }
      if (!validSession(request.headers.authorization)) throw new DriveError("auth", 401);
      if (url === "/v1/folders" && method === "GET") return setStatus(response, 200, [await vault.folder(folderId)]);
      const prefix = "/v1/folders/" + folderId + "/";
      if (!url?.startsWith(prefix)) throw new DriveError("outside", 404);
      const target = url.slice(prefix.length);
      if (target === "tree" && method === "GET") return setStatus(response, 200, await vault.tree(folderId));
      const note = target.match(/^notes\/([A-Za-z0-9_-]{8,150})$/);
      if (!note) throw new DriveError("outside", 404);
      if (method === "GET") return setStatus(response, 200, await vault.read(note[1]));
      if (method === "PUT") {
        const draft = await readJson(request, maxNoteBytes * 6 + 4096);
        await vault.save(note[1], draft);
        return setStatus(response, 200, { saved: true });
      }
      throw new DriveError("request", 405);
    } catch (error) {
      const known = error instanceof DriveError;
      if (!response.headersSent) {
        setStatus(response, known ? error.status : 503, {
          error: known ? error.code : method === "PUT" ? "unknown" : "provider",
        });
      }
    }
  };
}

export function vaultFromEnvironment(env, atomicWrites = false) {
  const getToken = serviceAccountToken({
    credentialPath: env.PLANX_SERVICE_ACCOUNT_FILE,
    serviceAccount: env.PLANX_SIGNING_SERVICE_ACCOUNT,
  });
  return driveVault({ rootId: env.PLANX_FOLDER_ID, getToken, atomicWrites });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = process.env;
  const vault = vaultFromEnvironment(env, env.PLANX_CAS_PILOT_VERIFIED === "yes");
  const handler = createHandler({
    vault, folderId: env.PLANX_FOLDER_ID, origin: env.PLANX_WEB_ORIGIN, accessCode: env.PLANX_ACCESS_CODE,
  });
  const server = createServer(handler);
  server.requestTimeout = 40000;
  server.listen(Number(env.PORT || 8787), env.PLANX_BIND || "127.0.0.1");
}
