import { expect, test } from "@playwright/test";

async function selectFolder(page, id) {
  await page.locator("#folder-select").selectOption(id);
  await page.getByRole("button", { name: "Выбрать папку", exact: true }).click();
}

test("opens a nested tree, reads Markdown and restores the chosen folder after reload", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Диск", exact: true }).click();
  await page.getByRole("button", { name: "Открыть вымышленную базу" }).click();
  await selectFolder(page, "fixture_vault");
  await expect(page.getByRole("link", { name: "Сверить план маяка" })).toBeVisible();
  await expect(page.locator("#home")).not.toContainText("2025-01-03");

  await page.getByRole("link", { name: "Диск", exact: true }).click();
  await page.locator("#digest-select").selectOption("digests_area");
  await page.getByRole("button", { name: "Сохранить источник" }).click();
  await page.getByRole("link", { name: "Plan X, главная" }).click();
  await expect(page.locator("#digest a")).toHaveCount(1);
  await expect(page.locator("#digest")).toContainText("2025-01-03");
  await page.locator("#workspaces").getByText("Личное", { exact: true }).click();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("planx:appearance:v2")).open.personal)).toBe(false);
  await page.reload();
  await expect(page.locator(".workspace").first()).not.toHaveAttribute("open", "");
  await expect(page.locator("#digest a")).toHaveCount(1);

  const nav = page.getByRole("navigation", { name: "Основная навигация" });
  const home = nav.getByRole("link", { name: "Главная" });
  const explorer = nav.getByRole("link", { name: "Проводник" });
  await expect(nav.getByRole("link")).toHaveCount(2);
  await expect(home).toHaveAttribute("aria-current", "page");

  for (const [theme, label] of [["a", "Два поля"], ["c", "Рабочий круг"], ["b", "Карманные папки"]]) {
    await page.locator(".theme-menu > summary").click();
    await page.getByRole("button", { name: label }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    const dimensions = await page.evaluate(() => ({
      page: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth,
    }));
    expect(dimensions.page).toBeLessThanOrEqual(dimensions.viewport);
    const bottomGap = await nav.evaluate((bar) => window.innerHeight - bar.getBoundingClientRect().bottom);
    expect(Math.abs(bottomGap)).toBeLessThan(1);
    await explorer.click();
    await expect(explorer).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("heading", { name: "Проводник" })).toBeVisible();
    await home.click();
    await expect(home).toHaveAttribute("aria-current", "page");
  }

  await explorer.click();
  const openFolder = async (parent, name) => {
    const summary = parent.locator(":scope > ul > li > details > summary").filter({ hasText: name });
    await summary.click();
    const folder = summary.locator("..");
    await expect(folder).toHaveJSProperty("open", true);
    return folder;
  };
  const work = await openFolder(page.locator("#tree"), /^Петроработа$/);
  const current = await openFolder(work, /^Текущие$/);
  await openFolder(current, /^Маяк$/);
  await expect(page.getByRole("link", { name: "Сверить план маяка" })).toBeVisible();
  await page.getByRole("searchbox").fill("Сверить");
  await expect(page.locator("#tree a")).toHaveCount(1);
  await page.getByRole("link", { name: "Сверить план маяка" }).click();
  await expect(page.getByRole("checkbox")).toBeDisabled();
  await expect(explorer).toHaveAttribute("aria-current", "location");
  await expect(page.locator("#note-preview")).not.toContainText("kind:");
  await page.getByRole("link", { name: "Размеры" }).click();
  await expect(page.getByRole("heading", { name: "Схема маяка" })).toBeVisible();
  await expect(page.locator("#note-preview strong")).toHaveText("32 см");
  await expect(page.getByRole("link", { name: "К проводнику" })).toBeVisible();
});

test("edits same file, retains a draft offline or at 401, and handles a competing update", async ({ page, context }) => {
  const origin = "https://fixture.invalid";
  const folder = "folder_fixture";
  const id = "fixture_note";
  const name = "Вымышленная задача";
  const base = "# Вымышленная задача\n\n- [ ] Подготовить макет";
  let markdown = base;
  let version = 1;
  let expired = false;
  let interruptAfterWrite = false;
  let puts = 0;
  const routePath = "/v1/folders/" + folder + "/notes/" + id;
  await page.route(origin + "/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const type = request.method();
    const headers = {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "authorization, content-type",
      "access-control-allow-methods": "GET, PUT, POST, OPTIONS",
    };
    const respond = (json, status = 200) => route.fulfill({ json, status, headers });
    if (type === "OPTIONS") return route.fulfill({ status: 204, headers });
    if (path === "/v1/session") {
      expired = false;
      return respond({ token: "fake", expiresAt: Date.now() + 60000 });
    }
    if (expired) return respond({ error: "auth" }, 401);
    if (path === "/v1/folders") return respond([{ id: folder, name: "Тест", writable: true }]);
    if (path.endsWith("/tree")) return respond([{
      id, type: "note", parent: folder, name: name + ".md",
      path: ["Личное", "Текущие", name + ".md"], version: String(version),
    }]);
    if (path === routePath && type === "PUT") {
      puts++;
      const input = request.postDataJSON();
      if (input.version !== String(version)) return respond({ error: "conflict" }, 409);
      markdown = input.markdown;
      version++;
      if (interruptAfterWrite) return route.abort("failed");
      return respond({ saved: true });
    }
    return respond({ markdown, version: String(version), editable: true });
  });

  await page.goto("/#/settings");
  await page.getByLabel("Адрес подключения").fill(origin);
  await page.getByLabel("Код доступа").fill("fake");
  await page.getByRole("button", { name: "Подключиться" }).click();
  await selectFolder(page, folder);
  await page.getByRole("link", { name }).click();
  await page.getByRole("button", { name: "Редактировать" }).click();
  const editor = page.getByRole("textbox", { name: "Текст заметки" });
  const save = page.getByRole("button", { name: "Сохранить", exact: true });
  const draft = base + "\n\nМоя правка";
  await editor.fill(draft);
  await context.setOffline(true);
  await save.click();
  await expect(page.locator("#note-status")).toContainText(/не сохранилась|не подтверждено/);
  await expect(editor).toHaveValue(draft);
  await context.setOffline(false);
  if (await save.isDisabled()) {
    await page.getByRole("button", { name: "Проверить на Диске" }).click();
  }

  expired = true;
  await save.click();
  await expect(page.locator("#note-status")).toContainText("Сеанс истёк");
  await expect(editor).toHaveValue(draft);
  await page.getByRole("link", { name: "Диск", exact: true }).click();
  await page.getByLabel("Код доступа").fill("fake");
  await page.getByRole("button", { name: "Подключиться" }).click();
  await page.getByRole("link", { name }).click();
  await page.getByRole("button", { name: "Открыть черновик" }).click();
  await expect(editor).toHaveValue(draft);
  markdown = base + "\n\nПравка другого редактора";
  version++;
  await save.click();
  await expect(page.locator("#remote-text")).toContainText("Правка другого редактора");
  expect(markdown).not.toContain("Моя правка");
  const merged = markdown + "\n\nМоя правка";
  await editor.fill(merged);
  await page.getByRole("button", { name: "Я объединил правки" }).click();
  interruptAfterWrite = true;
  await save.click();
  await expect(page.locator("#note-status")).toContainText("не подтверждено");
  await page.getByRole("button", { name: "Проверить на Диске" }).click();
  await expect(page.locator("#note-status")).toContainText("Текст уже есть на Диске");
  expect(markdown).toBe(merged);
  expect(puts).toBe(2);
  await page.reload();
  await expect(page.locator("#note-preview")).toContainText("Моя правка");
});
