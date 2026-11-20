export class ConnectionError extends Error {
  constructor(code) { super(code); this.code = code; }
}

export function connectorAddress(address) {
  const url = new URL(address.trim());
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(loopback && url.protocol === "http:")) ||
      url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new ConnectionError("address");
  }
  return url.origin;
}

export function connector(address, getSession, request = fetch) {
  const origin = connectorAddress(address);
  async function call(path, method = "GET", payload, authenticated = true) {
    const bearer = authenticated && getSession();
    if (authenticated && !bearer) throw new ConnectionError("auth");
    const headers = { Accept: "application/json" };
    if (bearer) headers.Authorization = "Bearer " + bearer;
    if (payload) headers["Content-Type"] = "application/json";
    let reply;
    try {
      reply = await request(origin + "/v1/" + path, {
        method, headers, body: payload && JSON.stringify(payload),
        credentials: "omit", redirect: "error", cache: "no-store",
        signal: AbortSignal.timeout(30000),
      });
    } catch {
      throw new ConnectionError(method === "PUT" ? "unknown" : "network");
    }
    let result;
    try { result = await reply.json(); } catch {
      throw new ConnectionError(method === "PUT" ? "unknown" : "network");
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
