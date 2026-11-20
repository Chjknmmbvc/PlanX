import { ConnectionError } from "./transport.mjs";

const root = "fixture_vault";
const folders = [
  [root, "", "Тестовая база"],
  ["personal_area", root, "Личное"],
  ["personal_now", "personal_area", "Текущие"],
  ["personal_later", "personal_area", "Долгосрочные"],
  ["work_area", root, "Петроработа"],
  ["work_now", "work_area", "Текущие"],
  ["work_project", "work_now", "Маяк"],
  ["work_later", "work_area", "Долгосрочные"],
  ["digests_area", root, "Дайджесты"],
  ["daily_area", root, "Дневные планы"],
];
const fixtures = [
  ["kite_plan", "personal_now", "Подготовить воздушного змея", "# Подготовить воздушного змея\n\nПлан на субботу.\n\n- [x] Нарисовать эскиз\n- [ ] Найти рейки\n  - Посмотреть в мастерской\n\nПодробнее: [[Маяк/Схема маяка|посмотреть схему]]."],
  ["bike_route", "personal_later", "Продумать веломаршрут", "## Маршрут\n\n1. Парк\n2. Пруд"],
  ["test_work", "work_project", "Сверить план маяка", "---\nkind: task\n---\n# Сверить план маяка\n\n- [ ] Проверить два эскиза\n\n[[Схема маяка#Размеры|Размеры]]"],
  ["lighthouse", "work_project", "Схема маяка", "---\nkind: reference\naliases:\n  - Чертёж\n---\n# Схема маяка\n\n## Размеры\n\nВысота **32 см**.\n\nhttps://example.com"],
  ["work_future", "work_later", "Описать проект маяка", "Черновик будущего разговора."],
  ["daily_old", "daily_area", "2025-01-03", "---\ngroup: personal\nlane: current\nkind: daily\n---\nСтарый дневной план."],
  ["digest_old", "digests_area", "Дайджест 2025-01-02", "Прошлый дайджест."],
  ["digest_new", "digests_area", "Дайджест 2025-01-03", "Воздушный змей и проект маяка."],
];
const path = (id) => {
  if (id === root) return [];
  const entry = folders.find(([key]) => key === id);
  return [...path(entry[1]), entry[2]];
};

export function demoDrive(storage = localStorage) {
  const key = "planx:demo:changes:v1";
  const fallback = {};
  function changes() {
    try { return JSON.parse(storage.getItem(key) || "{}"); } catch { return fallback; }
  }
  function verify(folder) {
    if (folder !== root) throw new ConnectionError("outside");
  }
  function read(folder, id) {
    verify(folder);
    const fixture = fixtures.find(([key]) => key === id);
    if (!fixture) throw new ConnectionError("outside");
    return changes()[id] || { markdown: fixture[3], version: "fixture-1", editable: true };
  }
  return {
    async folders() { return [{ id: root, name: folders[0][2], writable: true }]; },
    async tree(folder) {
      verify(folder);
      return [
        ...folders.slice(1).map(([id, parent, name]) => ({ type: "folder", id, parent, name, path: path(id) })),
        ...fixtures.map(([id, parent, title]) => ({
          type: "note", id, parent, name: title + ".md", path: [...path(parent), title + ".md"],
          version: read(folder, id).version,
        })),
      ];
    },
    async read(folder, id) { return read(folder, id); },
    async save(folder, id, { markdown, version }) {
      if (read(folder, id).version !== version) throw new ConnectionError("conflict");
      const record = { markdown, version: "fixture-" + crypto.randomUUID(), editable: true };
      const next = { ...changes(), [id]: record };
      try { storage.setItem(key, JSON.stringify(next)); } catch { Object.assign(fallback, next); }
      return record;
    },
  };
}
