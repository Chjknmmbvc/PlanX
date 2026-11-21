const folderMime = "application/vnd.google-apps.folder";
const fixtureName = "planx-cas-fixture.md";
const fixtureHeader = "# Plan X CAS fixture";
const maxBytes = 256 * 1024;
const sessionLifetime = 12 * 60 * 60 * 1000;
const driveV3 = "https://www.googleapis.com/drive/v3/files/";
const driveV2 = "https://www.googleapis.com/drive/v2/files/";
const driveUpload = "https://www.googleapis.com/upload/drive/v2/files/";

function doPost(event) {
  try {
    const input = event?.postData?.contents;
    if (typeof input !== "string" || input.length > maxBytes * 6 + 4096) fail_(413, "too_large");
    let request;
    try { request = JSON.parse(input); } catch { fail_(400, "request"); }
    if (!request || typeof request !== "object" || Array.isArray(request)) fail_(400, "request");

    const properties = PropertiesService.getScriptProperties();
    const code = properties.getProperty("PLANX_ACCESS_CODE");
    if (!/^[a-fA-F0-9]{64}$/.test(code || "")) fail_(503, "connector_config");
    if (request.route === "session" && request.method === "POST") {
      if (!same_(request.payload?.code, code)) fail_(401, "auth");
      const expiresAt = Date.now() + sessionLifetime;
      return reply_(200, { token: expiresAt + "." + signature_(expiresAt, code), expiresAt });
    }

    const auth = typeof request.token === "string" && /^(\d{13})\.([A-Za-z0-9_-]{43})$/.exec(request.token);
    if (!auth || Number(auth[1]) <= Date.now() || !same_(auth[2], signature_(auth[1], code))) fail_(401, "auth");

    const root = properties.getProperty("PLANX_PILOT_FOLDER_ID");
    const id = properties.getProperty("PLANX_PILOT_NOTE_ID");
    if (![root, id].every(value => value && /^[A-Za-z0-9_-]{8,150}$/.test(value))) {
      fail_(503, "connector_config");
    }
    const writable = properties.getProperty("PLANX_PILOT_WRITES") === "yes";
    const get = request.method === "GET";
    const noteRoute = "folders/" + root + "/notes/" + id;
    const reading = get && request.route === noteRoute;
    const writing = request.method === "PUT" && request.route === noteRoute;
    const listing = get && request.route === "folders";
    const tree = get && request.route === "folders/" + root + "/tree";
    if (!(reading || writing || listing || tree)) fail_(404, "outside");
    if (writing && !writable) fail_(403, "read_only");

    const token = driveToken_(properties);
    if (listing) {
      const folder = metadata_(root, token);
      if (folder.mimeType !== folderMime) fail_(404, "outside");
      return reply_(200, [{ id: root, name: folder.name, writable }]);
    }
    const before = fixture_(id, root, token);
    if (tree) return reply_(200, before.entries);

    const tag = writable ? validator_(before.item, token) : null;
    const content = readFixture_(before.item, token);
    const after = fixture_(id, root, token).item;
    if (before.item.version !== after.version ||
        (after.md5Checksum && after.md5Checksum !== content.checksum)) fail_(409, "conflict");

    const editable = writable && !!tag && !!after.md5Checksum && after.capabilities?.canModifyContent === true;
    if (reading) return reply_(200, { markdown: content.markdown, editable, version: tag || after.version });
    if (!editable) fail_(403, "read_only");
    const draft = request.payload;
    if (draft?.version !== tag) fail_(409, "conflict");
    if (typeof draft.markdown !== "string" || !isSynthetic_(draft.markdown)) fail_(400, "request");
    if (Utilities.newBlob(draft.markdown).getBytes().length > maxBytes) fail_(413, "too_large");

    const boundary = "planx-" + Utilities.getUuid();
    const payload = "--" + boundary + "\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{}\r\n" +
      "--" + boundary + "\r\nContent-Type: " + after.mimeType + "\r\n\r\n" +
      draft.markdown + "\r\n--" + boundary + "--\r\n";
    const result = json_(fetchDrive_(driveUpload, id, { uploadType: "multipart", fields: "id" }, token, {
      method: "put", contentType: "multipart/related; boundary=" + boundary, payload,
      headers: { "If-Match": tag },
    }), "unknown");
    if (result.id !== id) fail_(503, "unknown");
    return reply_(200, { saved: true });
  } catch (error) {
    return reply_(error.status || 503, { error: error.code || "provider" });
  }
}

function fail_(status, code) {
  const error = new Error(code);
  error.status = status;
  error.code = code;
  throw error;
}

function reply_(status, data) {
  return ContentService.createTextOutput(JSON.stringify({ status, data })).setMimeType(ContentService.MimeType.JSON);
}

function same_(left, right) {
  if (typeof left !== "string" || left.length !== right.length) return false;
  let different = 0;
  for (let index = 0; index < right.length; index++) different |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return different === 0;
}

function base64url_(value) {
  return Utilities.base64EncodeWebSafe(value).replace(/=+$/, "");
}

function signature_(expiresAt, code) {
  return base64url_(Utilities.computeHmacSha256Signature("session:" + expiresAt, code));
}

function driveToken_(properties) {
  try {
    const cache = CacheService.getScriptCache();
    const cached = cache.get("planx-drive-token-v1");
    if (cached) return cached;
    const key = JSON.parse(properties.getProperty("PLANX_SERVICE_ACCOUNT_JSON") || "null");
    if (key?.type !== "service_account" ||
        !/^[a-z0-9._+-]+@[a-z0-9.-]+\.iam\.gserviceaccount\.com$/i.test(key.client_email || "")) {
      throw new Error("auth");
    }
    const endpoint = "https://oauth2.googleapis.com/token";
    const iat = Math.floor(Date.now() / 1000);
    const claims = { iss: key.client_email, scope: "https://www.googleapis.com/auth/drive", aud: endpoint, iat, exp: iat + 3600 };
    const unsigned = base64url_(JSON.stringify({ alg: "RS256", typ: "JWT", kid: key.private_key_id })) +
      "." + base64url_(JSON.stringify(claims));
    const assertion = unsigned + "." + base64url_(Utilities.computeRsaSha256Signature(unsigned, key.private_key));
    const response = UrlFetchApp.fetch(endpoint, {
      method: "post", followRedirects: false, muteHttpExceptions: true,
      payload: { grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion },
    });
    if (response.getResponseCode() !== 200) throw new Error("auth");
    const data = JSON.parse(response.getContentText());
    if (typeof data.access_token !== "string" || !(data.expires_in > 60)) throw new Error("auth");
    cache.put("planx-drive-token-v1", data.access_token, Math.min(3300, data.expires_in - 60));
    return data.access_token;
  } catch {
    fail_(503, "drive_auth");
  }
}

function fetchDrive_(base, id, params, token, options = {}) {
  const query = Object.entries({ ...params, supportsAllDrives: "true" }).map(
    ([name, value]) => encodeURIComponent(name) + "=" + encodeURIComponent(value)
  ).join("&");
  const writing = options.method === "put";
  let response;
  try {
    response = UrlFetchApp.fetch(base + encodeURIComponent(id) + "?" + query, {
      ...options, followRedirects: false, muteHttpExceptions: true,
      headers: { ...options.headers, Authorization: "Bearer " + token },
    });
  } catch { fail_(503, writing ? "unknown" : "provider"); }
  const status = response.getResponseCode();
  if (status >= 200 && status < 300) return response;
  if (status === 401) fail_(503, "drive_auth");
  if (status === 403) fail_(403, "drive_access");
  if (status === 404) fail_(404, "outside");
  if (status === 409 || status === 412) fail_(409, "conflict");
  fail_(503, writing ? "unknown" : "provider");
}

function json_(response, code = "provider") {
  try { return JSON.parse(response.getContentText("UTF-8")); } catch { fail_(503, code); }
}

function metadata_(id, token) {
  const fields = "id,name,mimeType,parents,trashed,version,md5Checksum,modifiedTime,capabilities(canModifyContent)";
  const value = json_(fetchDrive_(driveV3, id, { fields }, token));
  if (value.id !== id || value.trashed !== false) fail_(404, "outside");
  return value;
}

function fixture_(id, root, token) {
  const item = metadata_(id, token);
  if (item.name !== fixtureName ||
      !["text/markdown", "text/x-markdown", "text/plain", "application/octet-stream"].includes(item.mimeType)) {
    fail_(404, "outside");
  }
  const parents = [];
  const visited = new Set([id]);
  let current = item;
  while (current.parents?.length === 1 && parents.length < 100) {
    const parentId = current.parents[0];
    if (visited.has(parentId)) break;
    visited.add(parentId);
    current = metadata_(parentId, token);
    if (current.mimeType !== folderMime) break;
    if (parentId === root) {
      const entries = [];
      const path = [];
      for (const node of parents.reverse().concat(item)) {
        path.push(node.name);
        entries.push({
          id: node.id, parent: node.parents[0], name: node.name, path: path.slice(),
          type: node.id === id ? "note" : "folder", version: node.version, modifiedTime: node.modifiedTime,
        });
      }
      return { item, entries };
    }
    parents.push(current);
  }
  fail_(404, "outside");
}

function validator_(item, token) {
  const value = json_(fetchDrive_(driveV2, item.id, { fields: "id,etag,version" }, token));
  if (value.id !== item.id || value.version !== item.version) fail_(409, "conflict");
  return typeof value.etag === "string" && /^"[\x21\x23-\x7e]{1,300}"$/.test(value.etag) ? value.etag : null;
}

function isSynthetic_(markdown) {
  return markdown.startsWith(fixtureHeader + "\n") || markdown.startsWith(fixtureHeader + "\r\n");
}

function readFixture_(item, token) {
  const response = fetchDrive_(driveV3, item.id, { alt: "media" }, token);
  const bytes = response.getContent();
  if (bytes.length > maxBytes) fail_(413, "too_large");
  const markdown = response.getContentText("UTF-8");
  if (!isSynthetic_(markdown)) fail_(404, "outside");
  const checksum = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, bytes)
    .map(value => (value & 255).toString(16).padStart(2, "0")).join("");
  const encoded = Utilities.newBlob(markdown).getBytes();
  if (encoded.length !== bytes.length || encoded.some((value, index) => value !== bytes[index])) fail_(409, "conflict");
  return { markdown, checksum };
}
