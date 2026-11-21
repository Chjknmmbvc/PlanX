export const groups = [
  { id: "personal", label: "Личное" },
  { id: "work", label: "Петроработа" },
];
export const lanes = [
  { id: "current", label: "Текущие" },
  { id: "later", label: "Долгосрочные" },
];

export const noteName = (name) => name.replace(/\.md$/i, "");
export const normalize = (value) => value.normalize("NFC").trim().toLocaleLowerCase("ru");
export const compareNames = (a, b) => a.localeCompare(b, "ru", { numeric: true });
export const noteRoute = (id, heading = "") => "#note/" + encodeURIComponent(id) +
  (heading ? "/" + encodeURIComponent(heading) : "");

function scalar(value) {
  const text = value.trim();
  if (text.startsWith('"') && text.endsWith('"')) {
    try { return JSON.parse(text); } catch { return text.slice(1, -1); }
  }
  if (text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1).replaceAll("''", "'");
  return text.replace(/\s+#.*$/, "");
}

export function parseNote(raw) {
  const text = raw.replace(/^\uFEFF/, "");
  const front = text.match(/^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/);
  const p = Object.create(null);
  let key = "";
  for (const line of (front?.[1] || "").split(/\r?\n/)) {
    const field = line.match(/^([\w-]+):(?:[ \t]*(.*))?$/);
    const item = line.match(/^\s*-\s+(.+)$/);
    if (field) {
      key = field[1];
      const value = field[2] || "";
      p[key] = /^\[.*\]$/.test(value)
        ? value.slice(1, -1).split(",").map(scalar).filter(Boolean)
        : scalar(value);
    } else if (item && key) {
      if (!Array.isArray(p[key])) p[key] = [];
      p[key].push(scalar(item[1]));
    }
  }
  return { p, body: text.slice(front?.[0].length || 0) };
}

export function displayName(file, note) {
  const title = note?.p.title;
  return typeof title === "string" && title.trim() ? title : noteName(file.name);
}

function labelId(items, value) {
  if (typeof value !== "string") return "";
  const label = normalize(value);
  return items.find((item) => label === item.id || label === normalize(item.label))?.id || "";
}

export function taskSection(file, note) {
  const p = note?.p || {};
  const path = file.path.slice(0, -1);
  const kind = normalize(String(p.kind || p.type || ""));
  const archived = /^(true|yes|да)$/i.test(String(p.archived || ""));
  if (archived || /^(daily([ -]plan)?|day[- ]plan|дневной план|digest|дайджест|reference)$/.test(kind) ||
      path.some((part) => /^(archive|архив|daily|daily notes|дневник|дневные планы|ежедневные планы|дайджесты)$/i.test(part)) ||
      /^\d{4}-\d{2}-\d{2}(?:$|[ —–_])/.test(noteName(file.name))) return null;
  const group = labelId(groups, p.group) || path.map((item) => labelId(groups, item)).find(Boolean);
  const lane = labelId(lanes, p.lane) || path.map((item) => labelId(lanes, item)).find(Boolean);
  return group && lane ? { group, lane } : null;
}

export function activeDigest(files, source, notes, today = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Europe/Moscow", year: "numeric", month: "2-digit", day: "2-digit",
}).format(Date.now())) {
  if (!source) return null;
  const selected = files.find((file) => file.id === source);
  if (!selected || selected.type === "note") return selected || null;
  const candidates = files.filter((file) => file.type === "note" &&
    file.path.length > selected.path.length &&
    selected.path.every((part, index) => part === file.path[index]));
  const ranked = candidates.flatMap((file) => {
    const title = displayName(file, notes.get(file.id));
    const explicit = [notes.get(file.id)?.p.date, title, file.name]
      .map(String).map((part) => part.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0]).find(Boolean);
    if (explicit && explicit > today) return [];
    return [{ file, date: explicit || file.modifiedTime?.slice(0, 10) || "" }];
  });
  ranked.sort((a, b) => b.date.localeCompare(a.date) ||
    String(b.file.modifiedTime || "").localeCompare(String(a.file.modifiedTime || "")) ||
    compareNames(a.file.name, b.file.name));
  return ranked[0]?.file || null;
}

const comparablePath = (parts) => parts.map((part, i) => normalize(
  i === parts.length - 1 ? noteName(part) : part,
)).join("/");

function relativePath(base, target) {
  const parts = target.startsWith("/") ? [] : [...base];
  for (const part of target.split("/")) {
    if (!part || part === ".") continue;
    if (part !== "..") parts.push(part);
    else if (parts.length) parts.pop();
    else return null;
  }
  return comparablePath(parts);
}

export function findLink(files, notes, current, target) {
  if (!target) return current;
  const available = files.filter((file) => file.type === "note");
  const here = current.path.slice(0, -1);
  const paths = new Map();
  for (const path of [relativePath(here, target), relativePath([], target)]) {
    if (!path || paths.has(path)) continue;
    paths.set(path, true);
    const matches = available.filter((file) => comparablePath(file.path) === path);
    if (matches.length) return matches.length === 1 ? matches[0] : null;
  }
  if (target.includes("/")) {
    if (/^(?:\.{1,2}\/|\/)/.test(target)) return null;
    const key = relativePath([], target);
    const suffix = available.filter((file) => key && comparablePath(file.path).endsWith("/" + key));
    return suffix.length === 1 ? suffix[0] : null;
  }
  const match = normalize(noteName(target));
  const matches = available.filter((file) => {
    const note = notes.get(file.id);
    return [file.name, displayName(file, note), ...[note?.p.aliases].flat()].some((part) =>
      typeof part === "string" && normalize(noteName(part)) === match);
  });
  return matches.length === 1 ? matches[0] : null;
}
