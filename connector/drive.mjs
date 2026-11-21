import { createHash, randomUUID } from "node:crypto";

const v3 = "https://www.googleapis.com/drive/v3/files";
const v2 = "https://www.googleapis.com/drive/v2/files";
const upload = "https://www.googleapis.com/upload/drive/v2/files";
const fields = "id,name,mimeType,parents,trashed,version,md5Checksum,capabilities(canModifyContent)";
const listFields = "id,name,mimeType,parents,trashed,version,modifiedTime";
const folderMime = "application/vnd.google-apps.folder";
const noteMimes = new Set(["text/markdown", "text/plain", "application/octet-stream", "text/x-markdown"]);

export const maxNoteBytes = 256 * 1024;
export const validId = (id) => typeof id === "string" && /^[A-Za-z0-9_-]{8,150}$/.test(id);
const strongEtag = (value) => typeof value === "string" && /^"[\x21\x23-\x7e]{1,300}"$/.test(value);
const isFolder = (item) => item.mimeType === folderMime;
const isNote = (item) => typeof item.name === "string" && /\.md$/i.test(item.name) && noteMimes.has(item.mimeType);

export class DriveError extends Error {
  constructor(code, status) { super(code); this.code = code; this.status = status; }
}

async function readText(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let text = "", bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      bytes += value.length;
      if (bytes > maxNoteBytes) throw new DriveError("too_large", 413);
      text += decoder.decode(value, { stream: true });
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export function driveVault({ rootId, getToken, request = fetch, atomicWrites = false }) {
  if (!validId(rootId)) throw new Error("Invalid configured folder");
  async function call(base, id, query, options = {}) {
    const url = new URL(base + (id ? "/" + encodeURIComponent(id) : ""));
    url.search = new URLSearchParams({ ...query, supportsAllDrives: "true" });
    const token = await getToken();
    let result;
    const writing = options.method === "PUT";
    try {
      result = await request(url, {
        ...options, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(20000),
        headers: { ...options.headers, Authorization: "Bearer " + token },
      });
    } catch {
      throw new DriveError(writing ? "unknown" : "provider", 503);
    }
    if (result.ok) return result;
    await result.body?.cancel().catch(() => {});
    if (result.status === 401) throw new DriveError("drive_auth", 503);
    if (result.status === 404) throw new DriveError("outside", 404);
    if (result.status === 409 || result.status === 412) throw new DriveError("conflict", 409);
    if (result.status === 403) throw new DriveError("drive_access", 403);
    throw new DriveError(writing ? "unknown" : "provider", 503);
  }

  function checkId(id) {
    if (!validId(id)) throw new DriveError("outside", 404);
  }

  async function meta(id) {
    checkId(id);
    const value = await (await call(v3, id, { fields })).json();
    if (value.id !== id || value.trashed !== false) throw new DriveError("outside", 404);
    return value;
  }

  async function folder(id) {
    if (id !== rootId) throw new DriveError("outside", 404);
    const root = await meta(id);
    if (!isFolder(root)) throw new DriveError("outside", 404);
    return { id, name: root.name, writable: atomicWrites };
  }

  async function noteInFolder(id) {
    const item = await meta(id);
    if (!isNote(item) || item.id === rootId) throw new DriveError("outside", 404);
    let parent = item.parents?.length === 1 ? item.parents[0] : null;
    const visited = new Set([id]);
    for (let depth = 0; depth <= 100 && parent && !visited.has(parent); depth++) {
      const ancestor = await meta(parent);
      if (!isFolder(ancestor)) break;
      if (parent === rootId) return item;
      visited.add(parent);
      parent = ancestor.parents?.length === 1 ? ancestor.parents[0] : null;
    }
    throw new DriveError("outside", 404);
  }

  async function tree(id) {
    await folder(id);
    const entries = [];
    const found = new Set([id]);
    const queue = [{ id, path: [] }];
    let offset = 0;
    while (offset < queue.length) {
      const batch = queue.slice(offset, offset + 5);
      offset += batch.length;
      await Promise.all(batch.map(async (parent) => {
        let pageToken = "";
        const pages = new Set();
        do {
          if (pages.has(pageToken)) throw new DriveError("provider", 503);
          pages.add(pageToken);
          const query = {
            q: "'" + parent.id + "' in parents and trashed = false",
            pageSize: "1000", spaces: "drive", includeItemsFromAllDrives: "true",
            fields: "nextPageToken,incompleteSearch,files(" + listFields + ")",
          };
          if (pageToken) query.pageToken = pageToken;
          const page = await (await call(v3, "", query)).json();
          if (page.incompleteSearch) throw new DriveError("provider", 503);
          for (const item of page.files || []) {
            if (!validId(item.id) || found.has(item.id) || item.trashed !== false ||
                item.parents?.length !== 1 || item.parents[0] !== parent.id || !(isFolder(item) || isNote(item))) continue;
            const entry = {
              id: item.id, parent: parent.id, name: item.name,
              path: [...parent.path, item.name], type: isFolder(item) ? "folder" : "note",
              modifiedTime: item.modifiedTime, version: item.version,
            };
            found.add(entry.id);
            entries.push(entry);
            if (entry.type === "folder") queue.push(entry);
            if (entries.length > 20000 || entry.path.length > 101) throw new DriveError("too_large", 413);
          }
          pageToken = page.nextPageToken || "";
        } while (pageToken);
      }));
    }
    return entries;
  }

  async function validator(item) {
    const info = await (await call(v2, item.id, { fields: "id,etag,version" })).json();
    if (info.id !== item.id || info.version !== item.version) throw new DriveError("conflict", 409);
    return strongEtag(info.etag) ? info.etag : null;
  }

  async function read(id) {
    const before = await noteInFolder(id);
    const tag = atomicWrites ? await validator(before) : null;
    const markdown = await readText(await call(v3, id, { alt: "media" }));
    const after = await noteInFolder(id);
    const checksum = after.md5Checksum;
    if (before.version !== after.version ||
        (checksum && checksum !== createHash("md5").update(markdown).digest("hex"))) {
      throw new DriveError("conflict", 409);
    }
    const editable = !!tag && !!checksum && after.capabilities?.canModifyContent === true;
    return { markdown, version: tag || after.version, editable };
  }

  async function replaceIfMatch(id, markdown, version, mimeType) {
    if (!atomicWrites || !strongEtag(version)) throw new DriveError("read_only", 403);
    checkId(id);
    if (typeof markdown !== "string" || Buffer.byteLength(markdown) > maxNoteBytes) {
      throw new DriveError("too_large", 413);
    }
    if (!noteMimes.has(mimeType)) throw new DriveError("outside", 404);
    const boundary = "planx-" + randomUUID();
    const body = "--" + boundary + "\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{}\r\n" +
      "--" + boundary + "\r\nContent-Type: " + mimeType + "\r\n\r\n" +
      markdown + "\r\n--" + boundary + "--\r\n";
    const response = await call(upload, id, { uploadType: "multipart", fields: "id" }, {
      method: "PUT", headers: { "Content-Type": "multipart/related; boundary=" + boundary, "If-Match": version }, body,
    });
    try {
      if ((await response.json()).id !== id) throw new Error("Unexpected file ID");
    } catch {
      throw new DriveError("unknown", 503);
    }
  }

  async function save(id, { markdown, version }) {
    if (!atomicWrites || !strongEtag(version)) throw new DriveError("read_only", 403);
    const current = await noteInFolder(id);
    if (!current.md5Checksum || current.capabilities?.canModifyContent !== true) throw new DriveError("read_only", 403);
    if (await validator(current) !== version) throw new DriveError("conflict", 409);
    await replaceIfMatch(id, markdown, version, current.mimeType);
  }

  return { folder, tree, read, save, replaceIfMatch };
}
