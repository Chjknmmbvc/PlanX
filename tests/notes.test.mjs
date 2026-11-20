import { test } from "node:test";
import assert from "node:assert/strict";
import { activeDigest, findLink, parseNote, taskSection } from "../notes.mjs";
import { connector, connectorAddress } from "../transport.mjs";

const note = (id, ...path) => ({ id, name: path.at(-1), path, type: "note" });

test("recognizes existing YAML, BOM, CRLF, task folders and hidden daily plans", () => {
  const raw = "\uFEFF---\r\ntitle: \"Тест\"\r\naliases: [Раз, Два]\r\ngroup: work\r\nlane: later\r\n---\r\n- [x] Проверка";
  const parsed = parseNote(raw);
  assert.deepEqual(parsed.p.aliases, ["Раз", "Два"]);
  assert.equal(parsed.body, "- [x] Проверка");
  assert.deepEqual(taskSection(note("work", "Тест.md"), parsed), { group: "work", lane: "later" });
  assert.deepEqual(taskSection(note("nested", "Личное", "Текущие", "Проект", "Часть.md")), { group: "personal", lane: "current" });
  assert.equal(taskSection(note("daily", "2025-01-01.md"), parsed), null);
  assert.equal(taskSection(note("archived", "Архив", "Тест.md"), parsed), null);
  assert.equal(parseNote("---\n---\n# Без свойств").body, "# Без свойств");
});

test("resolves relative paths, aliases and rejects ambiguous note names", () => {
  const current = note("current", "A", "This.md");
  const here = note("near", "A", "Same.md");
  const other = note("far", "B", "Nested", "Same.md");
  const elsewhere = note("outside", "C", "Elsewhere.md");
  const files = [current, here, other, elsewhere];
  const notes = new Map([["far", parseNote("---\naliases:\n  - Связь\n---\n# Проверка")]]);
  assert.equal(findLink(files, notes, current, "Same"), here);
  assert.equal(findLink(files, notes, current, "../B/Nested/Same.md"), other);
  assert.equal(findLink(files, notes, current, "Связь"), other);
  assert.equal(findLink(files, notes, current, "Nested/Same"), other);
  assert.equal(findLink(files, notes, elsewhere, "Same"), null);
});

test("selects only the latest available configured digest", () => {
  const folder = { id: "digest", type: "folder", path: ["Дайджесты"] };
  const latest = note("new", "Дайджесты", "Дайджест 2026-11-20.md");
  const files = [folder, note("old", "Дайджесты", "Дайджест 2026-11-19.md"), latest,
    note("future", "Дайджесты", "Дайджест 2026-11-21.md")];
  assert.equal(activeDigest(files, folder.id, new Map(), "2026-11-20"), latest);
  assert.equal(activeDigest(files, "", new Map(), "2026-11-20"), null);
});

test("maps an interrupted PUT to unknown and maps an expired session to auth", async () => {
  const offline = connector("https://example.invalid", () => "session", async () => { throw new Error("offline"); });
  await assert.rejects(offline.save("folder", "file", { markdown: "draft" }), { code: "unknown" });
  await assert.rejects(offline.tree("folder"), { code: "network" });
  const expired = connector("https://example.invalid", () => "session",
    async () => Response.json({ error: "auth" }, { status: 401 }));
  await assert.rejects(expired.read("folder", "file"), { code: "auth" });
  assert.throws(() => connectorAddress("https://a:b@example.invalid"), { code: "address" });
});
