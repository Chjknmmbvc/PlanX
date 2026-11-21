export class ConnectionError extends Error {
  constructor(code) { super(code); this.code = code; }
}

function isAppsScript(url) {
  return url.origin === "https://script.google.com" &&
    /^\/macros\/s\/[A-Za-z0-9_-]{20,200}\/exec$/.test(url.pathname);
}

export function connectorAddress(address) {
  const url = new URL(address.trim());
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(loopback && url.protocol === "http:")) ||
      url.username || url.password || url.search || url.hash || (url.pathname !== "/" && !isAppsScript(url))) {
    throw new ConnectionError("address");
  }
  return isAppsScript(url) ? url.href : url.origin;
}

export function connector(address, getSession, request = fetch) {
  const endpoint = connectorAddress(address);
  const appsScript = isAppsScript(new URL(endpoint));
  async function call(path, method = "GET", payload, authenticated = true) {
    const bearer = authenticated && getSession();
    if (authenticated && !bearer) throw new ConnectionError("auth");
    const errorCode = method === "PUT" ? "unknown" : "network";
    const headers = { Accept: "application/json" };
    if (bearer) headers.Authorization = "Bearer " + bearer;
    if (payload) headers["Content-Type"] = "application/json";
    let reply;
    try {
      reply = appsScript ? await request(endpoint, {
        method: "POST", headers: { "Content-Type": "text/plain;charset=UTF-8" },
        body: JSON.stringify({ route: path, method, token: bearer || undefined, payload }),
        credentials: "omit", redirect: "follow", signal: AbortSignal.timeout(30000),
      }) : await request(endpoint + "/v1/" + path, {
        method, headers, body: payload && JSON.stringify(payload),
        credentials: "omit", redirect: "error", cache: "no-store",
        signal: AbortSignal.timeout(30000),
      });
    } catch {
      throw new ConnectionError(errorCode);
    }
    let result;
    try { result = await reply.json(); } catch {
      throw new ConnectionError(errorCode);
    }
    if (appsScript) {
      if (!reply.ok || !result || !Number.isInteger(result.status)) throw new ConnectionError(errorCode);
      if (result.status !== 200) throw new ConnectionError(result.data?.error || errorCode);
      return result.data;
    }
    if (!reply.ok) throw new ConnectionError(result.error || (method === "PUT" ? "unknown" : "provider"));
    return result;
  }
  const path = (folder, id) => "folders/" + encodeURIComponent(folder) +
    "/notes/" + encodeURIComponent(id);
  return {
    login: (code) => call("session", "POST", { code }, false),
    folders: () => call("folders"),
    tree: (folder) => call("folders/" + encodeURIComponent(folder) + "/tree"),
    read: (folder, id) => call(path(folder, id)),
    save: (folder, id, draft) => call(path(folder, id), "PUT", draft),
  };
}
