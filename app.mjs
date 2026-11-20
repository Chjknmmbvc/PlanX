import { activeDigest, compareNames, displayName, groups, lanes, normalize, noteName,
  noteRoute, parseNote, taskSection } from "./notes.mjs";
import { renderMarkdown, headingKey } from "./markdown.mjs";
import { connector, connectorAddress, ConnectionError } from "./transport.mjs";
import { demoDrive } from "./demo.mjs";

const by = (id) => document.getElementById(id);
const el = (tag, text) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
};
const store = (area, key, value) => {
  try { window[area].setItem(key, JSON.stringify(value)); return true; } catch { return false; }
};
const recall = (area, key, fallback) => {
  try { return JSON.parse(window[area].getItem(key)) ?? fallback; } catch { return fallback; }
};

const key = "planx:connection:v1";
const sessionKey = "planx:session:v1";
const appearanceKey = "planx:appearance:v2";
const settings = recall("localStorage", key, {});
const appearance = recall("localStorage", appearanceKey, { theme: "b", open: {} });
appearance.open ||= {};
const remembered = () => store("localStorage", key, settings);
let session = recall("sessionStorage", sessionKey, null);
let connection, mode = "", address = "", root = "", folders = [], files = [];
let notes = new Map(), opened = new Set(), refreshing, sourceEpoch = 0;
let active = null, lastList = "#/home";
const draftMemory = new Map(), pendingWrites = new Set();
const themeMenu = document.querySelector(".theme-menu");
const bottomLinks = document.querySelectorAll(".bottom-nav a");

function theme(name) {
  if (!["a", "b", "c"].includes(name)) return;
  appearance.theme = name;
  document.documentElement.dataset.theme = name;
  for (const button of themeMenu.querySelectorAll("button")) {
    button.setAttribute("aria-pressed", String(button.dataset.theme === name));
  }
  store("localStorage", appearanceKey, appearance);
}

theme(appearance.theme);
themeMenu.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-theme]");
  if (!button) return;
  theme(button.dataset.theme);
  themeMenu.open = false;
  themeMenu.querySelector("summary").focus();
});
document.addEventListener("click", (event) => {
  if (themeMenu.open && !themeMenu.contains(event.target)) themeMenu.open = false;
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && themeMenu.open) {
    themeMenu.open = false;
    themeMenu.querySelector("summary").focus();
  }
});

const connectStatus = (text) => { by("connection-status").textContent = text; };
const noteStatus = (text) => { by("note-status").textContent = text; };
const scope = () => mode === "demo" ? "demo" : address;
const folderSettings = () => (settings.vaults ||= {})[scope()] ||= {};
const connectForm = by("connect-form");
const sessionToken = (origin) => session?.origin === origin && session.expiresAt > Date.now() ? session.token : "";
const userError = (error) => ({
  auth: "Сеанс истёк. Откройте «Диск» и подключитесь снова.",
  drive_auth: "Подключение к Google Диску требует проверки.",
  address: "Укажите адрес подключения HTTPS.",
  network: "Нет связи с Диском. Попробуйте обновить после восстановления сети.",
  outside: "Папка или заметка недоступна в этом подключении.",
  too_large: "Заметка превышает допустимый размер.",
  read_only: "Для этого подключения запись пока недоступна.",
  conflict: "Версия на Диске изменилась.",
  unknown: "Связь прервалась. Сохранение не подтверждено.",
}[error?.code] || "Диск не ответил. Повторите позже.");

function settingsView() {
  by("folder-form").hidden = !folders.length;
  by("digest-form").hidden = !root || !connection;
  by("refresh").hidden = !root || !connection;
  const selection = folders.find((folder) => folder.id === root);
  by("permission-status").textContent = mode === "live" && selection && !selection.writable
    ? "Подключение только для чтения. Запись включается после проверки защиты версий на Диске." : "";
  const select = by("folder-select");
  select.replaceChildren(new Option("Выберите папку", "", false, !root));
  for (const folder of folders) select.append(new Option(folder.name, folder.id, false, folder.id === root));
  const digest = by("digest-select");
  digest.replaceChildren(new Option("Не показывать", ""));
  for (const file of files) {
    const label = file.path.join(" / ") + (file.type === "folder" ? "/" : "");
    digest.append(new Option(label, file.id, false, file.id === folderSettings().digest));
  }
}

function fileLink(file, title = noteName(file.name)) {
  const a = el("a", title);
  a.href = noteRoute(file.id);
  return a;
}

function drawHome() {
  const tasks = new Map(groups.map(({ id }) => [id, new Map(lanes.map((lane) => [lane.id, []]))]));
  const digest = activeDigest(files, folderSettings().digest, notes);
  for (const file of files) {
    if (file.type !== "note" || file.id === digest?.id) continue;
    const position = taskSection(file, notes.get(file.id));
    if (position) tasks.get(position.group).get(position.lane).push(file);
  }
  const containers = [];
  for (const { id, label } of groups) {
    const box = el("details");
    box.className = "workspace";
    box.open = appearance.open[id] ?? true;
    const summary = el("summary", label);
    summary.className = "workspace-head";
    const symbol = el("span");
    symbol.className = "workspace-symbol";
    symbol.setAttribute("aria-hidden", "true");
    summary.append(symbol);
    box.append(summary);
    box.ontoggle = () => {
      appearance.open[id] = box.open;
      store("localStorage", appearanceKey, appearance);
    };
    const body = el("div");
    body.className = "workspace-body";
    for (const lane of lanes) {
      const section = el("section");
      section.append(el("h2", lane.label));
      const entries = tasks.get(id).get(lane.id);
      entries.sort((a, b) => compareNames(displayName(a, notes.get(a.id)), displayName(b, notes.get(b.id))));
      if (entries.length) {
        const list = el("div");
        list.className = "workspace-list";
        for (const file of entries) {
          const row = el("div");
          row.className = "card";
          row.append(fileLink(file, displayName(file, notes.get(file.id))));
          list.append(row);
        }
        section.append(list);
      } else {
        const empty = el("p", "Нет задач");
        empty.className = "muted empty";
        section.append(empty);
      }
      body.append(section);
    }
    box.append(body);
    containers.push(box);
  }
  by("workspaces").replaceChildren(...containers);
  by("digest").hidden = !digest;
  by("digest").replaceChildren(...(digest ? [fileLink(digest, "Дайджест · " + displayName(digest, notes.get(digest.id)).replace(/^Дайджест\s*/i, ""))] : []));
}

function drawTree() {
  const search = normalize(by("file-search").value);
  const tree = by("tree");
  const list = el("ul");
  if (search) {
    for (const file of files) {
      if (file.type !== "note") continue;
      const title = displayName(file, notes.get(file.id));
      if (![title, file.name].some((label) => normalize(label).includes(search))) continue;
      const item = el("li");
      const link = fileLink(file, title);
      link.title = file.path.join(" / ");
      item.append(link, el("small", file.path.slice(0, -1).join(" / ")));
      list.append(item);
    }
  } else {
    const children = new Map();
    for (const file of files) {
      if (!children.has(file.parent)) children.set(file.parent, []);
      children.get(file.parent).push(file);
    }
    const add = (target, parent) => {
      const rows = (children.get(parent) || []).sort((a, b) =>
        a.type.localeCompare(b.type) || compareNames(a.name, b.name));
      for (const file of rows) {
        const item = el("li");
        if (file.type === "folder") {
          const box = el("details");
          box.open = opened.has(file.id);
          box.ontoggle = () => {
            if (box.open) opened.add(file.id);
            else opened.delete(file.id);
          };
          const nested = el("ul");
          add(nested, file.id);
          box.append(el("summary", file.name), nested);
          item.append(box);
        } else item.append(fileLink(file));
        target.append(item);
      }
    };
    add(list, root);
  }
  tree.replaceChildren(list.children.length ? list : el("p",
    search ? "Ничего не найдено" : "В папке пока нет заметок"));
}

function applyNote(file, snapshot) {
  const parsed = parseNote(snapshot.markdown);
  notes.set(file.id, { ...parsed, listingVersion: file.version });
  return parsed;
}

function showViews() {
  drawHome();
  drawTree();
  settingsView();
}

async function sync({ quiet = false } = {}) {
  if (!connection || !root) return;
  if (refreshing) return refreshing;
  const generation = sourceEpoch;
  const source = connection;
  const folder = root;
  const work = async () => {
    if (!quiet) connectStatus("Обновляю папку…");
    try {
      const next = await source.tree(folder);
      if (generation !== sourceEpoch) return;
      files = next;
      const present = new Set(files.map((file) => file.id));
      for (const id of notes.keys()) if (!present.has(id)) notes.delete(id);
      showViews();
      if (!active?.snapshot && !active?.editing && location.hash.startsWith("#note/")) void route();
      const pending = files.filter((file) => file.type === "note" &&
        (!notes.has(file.id) || notes.get(file.id).listingVersion !== file.version));
      let index = 0;
      let failure;
      await Promise.all(Array.from({ length: Math.min(6, pending.length) }, async () => {
        while (index < pending.length && generation === sourceEpoch) {
          const file = pending[index++];
          try {
            const snapshot = await source.read(folder, file.id);
            if (generation === sourceEpoch) applyNote(file, snapshot);
          } catch (error) {
            failure ||= error;
            if (error?.code === "auth") break;
          }
        }
      }));
      if (generation !== sourceEpoch) return;
      showViews();
      connectStatus(failure ? userError(failure) :
        mode === "demo" ? "Вымышленная база · имитация Диска" : "");
    } catch (error) {
      if (generation === sourceEpoch) connectStatus(userError(error));
    }
  };
  const operation = work();
  refreshing = operation;
  try { await operation; } finally { if (refreshing === operation) refreshing = null; }
}

function changeSource(next, nextMode, nextAddress) {
  sourceEpoch++;
  refreshing = null;
  active = null;
  connection = next;
  mode = nextMode;
  address = nextAddress;
  files = [];
  notes = new Map();
  opened = new Set();
  folders = [];
  root = "";
  showViews();
}

async function connect(next, nextMode, nextAddress, destination) {
  changeSource(next, nextMode, nextAddress);
  const generation = sourceEpoch;
  folders = await next.folders();
  if (generation !== sourceEpoch) return;
  settings.mode = nextMode;
  if (nextMode === "live") settings.address = nextAddress;
  root = folders.some((folder) => folder.id === folderSettings().folder) ? folderSettings().folder : "";
  remembered();
  settingsView();
  if (root) {
    if (destination) location.hash = destination;
    await sync();
  } else {
    location.hash = "#/settings";
    connectStatus("Выберите папку один раз.");
  }
}

connectForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = by("connect");
  const code = connectForm.elements.code;
  button.disabled = true;
  try {
    const origin = connectorAddress(by("connector").value);
    const next = connector(origin, () => sessionToken(origin));
    const login = await next.login(code.value.trim());
    session = { ...login, origin };
    store("sessionStorage", sessionKey, session);
    await connect(next, "live", origin, "#/home");
  } catch (error) {
    connectStatus(userError(error));
  } finally {
    code.value = "";
    button.disabled = false;
  }
});

by("demo").onclick = () => connect(demoDrive(), "demo", "", "#/home").catch((error) => connectStatus(userError(error)));
by("refresh").onclick = () => sync();
by("folder-form").onsubmit = async (event) => {
  event.preventDefault();
  const selected = by("folder-select").value;
  if (!folders.some((folder) => folder.id === selected)) return;
  if (selected !== root) {
    sourceEpoch++;
    refreshing = null;
    folderSettings().digest = "";
    root = selected;
    files = [];
    notes.clear();
    opened.clear();
  }
  folderSettings().folder = root;
  remembered();
  location.hash = "#/home";
  await sync();
};
by("digest-form").onsubmit = (event) => {
  event.preventDefault();
  folderSettings().digest = by("digest-select").value;
  remembered();
  drawHome();
  connectStatus("Источник дайджеста сохранён.");
};
by("file-search").oninput = drawTree;

function draftKey(view) { return "planx:draft:" + view.scope + "/" + view.folder + "/" + view.id; }
function cachedDraft(view) {
  const key = draftKey(view);
  return draftMemory.has(key) ? draftMemory.get(key) : recall("sessionStorage", key, null);
}
function putDraft(view) {
  const key = draftKey(view);
  draftMemory.set(key, view.draft);
  const ok = store("sessionStorage", key, view.draft);
  if (!ok && view === active) noteStatus("Черновик открыт в редакторе. Браузер не смог сохранить его для перезагрузки.");
}
function clearDraft(view) {
  view.draft = null;
  putDraft(view);
}
function noteControls(view) {
  const { snapshot, editing, draft, remote } = view;
  const writing = pendingWrites.has(draftKey(view));
  by("editor").hidden = !editing;
  by("editor").readOnly = !!writing;
  by("note-preview").hidden = editing;
  by("edit").hidden = editing || (!snapshot?.editable && !draft);
  by("edit").textContent = draft ? "Открыть черновик" : "Редактировать";
  by("save").hidden = !editing;
  by("save").disabled = !!writing || !snapshot?.editable || !!view.needsReview || !draft;
  by("close-editor").hidden = !editing;
  by("close-editor").disabled = !!writing;
  by("discard").hidden = !editing || !draft;
  by("discard").disabled = !!writing;
  by("review").hidden = !editing || !view.needsReview || !!remote;
  by("review").disabled = !!writing;
  by("remote").hidden = !editing || !remote;
  by("remote-text").textContent = remote?.markdown || "";
}
function matchVersions(view, snapshot) {
  if (!view.draft) return;
  if (view.draft.markdown === snapshot.markdown) {
    clearDraft(view);
    view.needsReview = false;
    view.remote = null;
    noteStatus("Текст уже есть на Диске.");
  } else if (view.draft.version !== snapshot.version) {
    view.remote = snapshot;
    view.needsReview = true;
    noteStatus("Диск изменился. Сверьте версии и объедините правки в редакторе.");
  } else {
    view.needsReview = false;
    view.remote = null;
    noteStatus("Черновик не сохранён. Можно продолжить.");
  }
}

function showNote(file, snapshot) {
  const parsed = applyNote(file, snapshot);
  const title = displayName(file, parsed);
  by("note-title").textContent = title;
  renderMarkdown(by("note-preview"), { ...parsed, title, file, files, notes });
}

async function loadNote(view, heading = "") {
  const file = files.find((entry) => entry.id === view.id && entry.type === "note");
  if (!file) {
    if (view.draft) {
      noteStatus("Заметка пока недоступна. Черновик сохранён в этой вкладке.");
    } else noteStatus("Заметка пока недоступна. Обновите папку в разделе «Диск».");
    return;
  }
  by("note-title").textContent = displayName(file, notes.get(file.id));
  try {
    const snapshot = await view.connection.read(view.folder, view.id);
    if (active !== view) return;
    const saved = view.saved;
    if (saved && snapshot.version === saved.version) throw new ConnectionError("conflict");
    view.snapshot = snapshot;
    view.saved = null;
    showNote(file, snapshot);
    noteStatus(saved ? "Сохранено." : "");
    if (view.draft) {
      matchVersions(view, snapshot);
      if (!view.draft && view.editing) by("editor").value = snapshot.markdown;
    }
    noteControls(view);
    if (heading && !view.editing) {
      const key = headingKey(heading);
      [...by("note-preview").querySelectorAll("[data-heading]")]
        .find((item) => item.dataset.heading === key)?.scrollIntoView({ block: "start" });
    }
  } catch (error) {
    if (active !== view) return;
    view.needsReview ||= !!view.draft;
    noteStatus(view.saved ? "Сохранено. Откройте заметку снова, чтобы обновить версию для редактирования."
      : userError(error) + (view.draft ? " Черновик сохранён в этой вкладке." : ""));
    noteControls(view);
  }
}

async function route() {
  const hash = location.hash || "#/home";
  const match = hash.match(/^#note\/([^/]+)(?:\/(.+))?$/);
  const view = match ? "note" : ["#/files", "#/settings"].includes(hash) ? hash.slice(2) : "home";
  const changedScreen = by(view).hidden;
  const current = view === "note" ? lastList : "#/" + view;
  for (const link of bottomLinks) {
    if (link.hash === current) link.setAttribute("aria-current", view === "note" ? "location" : "page");
    else link.removeAttribute("aria-current");
  }
  for (const id of ["home", "files", "settings", "note"]) by(id).hidden = id !== view;
  if (view !== "note") {
    active = null;
    if (view !== "settings") lastList = current;
    if (changedScreen) window.scrollTo(0, 0);
    return;
  }
  let id, heading;
  try {
    id = decodeURIComponent(match[1]);
    heading = decodeURIComponent(match[2] || "");
  } catch {
    location.hash = "#/home";
    return;
  }
  const existing = active?.id === id && active.folder === root;
  if (existing && active.editing) return;
  const note = existing ? active : {
    id, folder: root || folderSettings().folder, scope: scope(), connection, editing: false,
  };
  if (!existing) {
    active = note;
    note.draft = cachedDraft(note);
    note.needsReview = !!note.draft;
    by("note-back").href = lastList;
    by("note-back").textContent = lastList === "#/files" ? "К проводнику" : "К задачам";
    by("note-title").textContent = "";
    by("note-preview").replaceChildren();
    by("editor").value = "";
    noteControls(note);
    window.scrollTo(0, 0);
  }
  noteStatus("Открываю заметку…");
  await loadNote(note, heading);
}

by("edit").onclick = () => {
  if (!active?.snapshot?.editable && !active?.draft) return;
  active.editing = true;
  by("editor").value = active.draft?.markdown ?? active.snapshot.markdown;
  noteControls(active);
  by("editor").focus();
};
by("editor").oninput = () => {
  const view = active;
  const input = by("editor").value;
  const base = view.snapshot?.markdown || "";
  const crlf = base.includes("\r\n") && !base.replaceAll("\r\n", "").includes("\n");
  const markdown = crlf ? input.replaceAll("\n", "\r\n") : input;
  if (view.snapshot && markdown === view.snapshot.markdown && !view.needsReview) clearDraft(view);
  else {
    view.draft = { markdown, version: view.draft?.version ?? view.snapshot?.version };
    noteStatus("Черновик не сохранён.");
    putDraft(view);
  }
  noteControls(view);
};
by("close-editor").onclick = () => {
  active.editing = false;
  noteControls(active);
};
by("discard").onclick = () => {
  if (!active.draft || !window.confirm("Отменить несохранённые правки?")) return;
  const view = active;
  clearDraft(view);
  view.editing = false;
  view.remote = null;
  view.needsReview = false;
  noteControls(view);
  void loadNote(view);
};
by("review").onclick = () => loadNote(active);
by("rebase").onclick = () => {
  const view = active;
  view.draft = { markdown: view.draft.markdown, version: view.remote.version };
  view.remote = null;
  view.needsReview = false;
  putDraft(view);
  noteStatus("Объединённая версия готова к сохранению.");
  noteControls(view);
};
by("save").onclick = async () => {
  const view = active;
  if (!view?.draft || view.needsReview || pendingWrites.has(draftKey(view))) return;
  const draft = view.draft;
  if (navigator.onLine === false) {
    noteStatus("Нет сети. Правка не сохранилась. Черновик остаётся в редакторе.");
    return;
  }
  const pendingKey = draftKey(view);
  pendingWrites.add(pendingKey);
  noteControls(view);
  try {
    await view.connection.save(view.folder, view.id, draft);
    clearDraft(view);
    view.editing = false;
    if (active && draftKey(active) === pendingKey) {
      const shown = active;
      shown.draft = null;
      shown.editing = false;
      shown.snapshot = null;
      shown.saved = draft;
      const file = files.find((entry) => entry.id === shown.id && entry.type === "note");
      if (file) showNote(file, draft);
      noteControls(shown);
      noteStatus("Сохранено.");
      await loadNote(shown);
    }
    if (connection === view.connection) void sync({ quiet: true });
  } catch (error) {
    view.needsReview = ["unknown", "auth", "conflict", "drive_auth"].includes(error?.code);
    if (active && draftKey(active) === pendingKey) {
      active.needsReview ||= view.needsReview;
      noteStatus(userError(error) + " Черновик сохранён в этой вкладке.");
      if (error?.code === "conflict") await loadNote(active);
    }
  } finally {
    pendingWrites.delete(pendingKey);
    if (active && draftKey(active) === pendingKey) noteControls(active);
  }
};

window.addEventListener("hashchange", route);
window.addEventListener("online", () => sync({ quiet: true }));
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void sync({ quiet: true });
});
window.addEventListener("pageshow", (event) => {
  if (event.persisted) void sync({ quiet: true });
});
window.setInterval(() => {
  if (!document.hidden && navigator.onLine !== false) void sync({ quiet: true });
}, 60000);
window.addEventListener("beforeunload", (event) => {
  if (active?.draft && !recall("sessionStorage", draftKey(active), null)) {
    event.preventDefault();
    event.returnValue = "";
  }
});

async function start() {
  by("connector").value = settings.address || "";
  if (settings.mode === "demo") await connect(demoDrive(), "demo", "");
  else if (settings.mode === "live" && settings.address) {
    const origin = connectorAddress(settings.address);
    if (sessionToken(origin)) await connect(connector(origin, () => sessionToken(origin)), "live", origin);
    else {
      mode = "live";
      address = origin;
      connectStatus(userError(new ConnectionError("auth")));
    }
  } else connectStatus("Подключить папку можно в разделе «Диск».");
  showViews();
}
await start().catch((error) => connectStatus(userError(error)));
await route();
