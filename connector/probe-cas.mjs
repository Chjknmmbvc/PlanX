import { randomUUID } from "node:crypto";
import { vaultFromEnvironment } from "./server.mjs";

const env = process.env;
if (env.PLANX_SYNTHETIC_CAS_TEST !== "yes") throw new Error("Use an isolated synthetic test folder");
const vault = vaultFromEnvironment(env, true);
const files = await vault.tree(env.PLANX_FOLDER_ID);
const fixture = files.find((file) => file.id === env.PLANX_CAS_FIXTURE_ID &&
  file.type === "note" && /^planx-cas-fixture[-\w]*\.md$/i.test(file.name));
if (!fixture) throw new Error("A dedicated planx-cas-fixture.md in the configured folder is required");
const mime = env.PLANX_CAS_FIXTURE_MIME || "text/markdown";
const run = randomUUID();
const original = await vault.read(fixture.id);
if (!original.markdown.startsWith("# Plan X CAS fixture")) throw new Error("Fixture marker missing");
const text = (phase) => "# Plan X CAS fixture\n\nSynthetic test " + run + " " + phase + "\n";
await vault.save(fixture.id, { markdown: text("first"), version: original.version });
const first = await vault.read(fixture.id);
if (first.markdown !== text("first") || first.version === original.version) throw new Error("Same-ID readback failed");
const stale = await Promise.allSettled([vault.replaceIfMatch(fixture.id, text("stale"), original.version, mime)]);
if (stale[0].status !== "rejected" || stale[0].reason.code !== "conflict" ||
    (await vault.read(fixture.id)).markdown !== text("first")) throw new Error("Stale provider condition failed");
const race = await Promise.allSettled(["A", "B"].map((phase) =>
  vault.replaceIfMatch(fixture.id, text(phase), first.version, mime)));
const winner = race.findIndex((result) => result.status === "fulfilled");
const loser = race.find((result) => result.status === "rejected");
if (winner < 0 || loser?.reason.code !== "conflict" ||
    (await vault.read(fixture.id)).markdown !== text(["A", "B"][winner])) throw new Error("Concurrent provider condition failed");
console.log("Same-ID readback, stale provider rejection and two simultaneous attempts passed.");
