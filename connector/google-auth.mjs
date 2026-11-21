import { createSign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { DriveError } from "./drive.mjs";

const endpoint = "https://oauth2.googleapis.com/token";
const driveScope = "https://www.googleapis.com/auth/drive";
const metadata = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";

const encode = (object) => Buffer.from(JSON.stringify(object)).toString("base64url");

async function json(url, options) {
  const result = await fetch(url, { ...options, redirect: "error", signal: AbortSignal.timeout(12000) });
  if (!result.ok) throw new Error("Google authorization request failed");
  return result.json();
}

export function serviceAccountToken({ credentialPath, serviceAccount }) {
  if (!!credentialPath === !!serviceAccount) throw new Error("Configure one service account signing method");
  let cached, renewing;
  async function refresh() {
    const credentials = credentialPath ? JSON.parse(await readFile(credentialPath, "utf8")) : null;
    if (credentials && credentials.type !== "service_account") throw new Error("Expected a service account");
    const email = credentials?.client_email || serviceAccount;
    if (!/^[a-z0-9._+-]+@[a-z0-9.-]+\.iam\.gserviceaccount\.com$/i.test(email)) {
      throw new Error("Invalid service account");
    }
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      iss: email, scope: driveScope, aud: endpoint, iat: now, exp: now + 3600,
    };
    let assertion;
    if (credentials) {
      const unsigned = encode({ alg: "RS256", typ: "JWT", kid: credentials.private_key_id }) + "." + encode(claims);
      const signature = createSign("RSA-SHA256").update(unsigned).sign(credentials.private_key, "base64url");
      assertion = unsigned + "." + signature;
    } else {
      const runtime = await json(metadata, { headers: { "Metadata-Flavor": "Google" } });
      const signed = await json("https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/" +
        encodeURIComponent(email) + ":signJwt", {
        method: "POST", body: JSON.stringify({ payload: JSON.stringify(claims) }),
        headers: { Authorization: "Bearer " + runtime.access_token, "Content-Type": "application/json" },
      });
      assertion = signed.signedJwt;
    }
    const auth = await json(endpoint, {
      method: "POST", body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion,
      }),
    });
    if (!auth.access_token || !Number(auth.expires_in)) throw new Error("Google token missing");
    cached = { token: auth.access_token, expiresAt: Date.now() + Number(auth.expires_in) * 1000 };
    return cached.token;
  }
  return async () => {
    if (cached?.expiresAt > Date.now() + 60000) return cached.token;
    renewing ||= refresh().catch(() => { throw new DriveError("drive_auth", 503); })
      .finally(() => { renewing = null; });
    return renewing;
  };
}
