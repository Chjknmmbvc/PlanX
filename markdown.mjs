import { Marked } from "./vendor/marked.mjs";
import DOMPurify from "./vendor/purify.mjs";
import { findLink, normalize, noteRoute } from "./notes.mjs";

const escape = (text) => text.replace(/[&<>"']/g, (ch) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[ch]));
const marker = "https://planx.invalid/wikilink/";
const md = new Marked({
  gfm: true,
  renderer: {
    html() { return ""; },
    image({ text }) { return escape(text); },
  },
  extensions: [{
    name: "wiki",
    level: "inline",
    start(src) {
      const offset = src.indexOf("[[");
      return offset >= 0 ? offset : undefined;
    },
    tokenizer(src) {
      const match = src.match(/^!?\[\[([^\]\n]+)\]\]/);
      if (match) return { type: "wiki", raw: match[0], target: match[1] };
    },
    renderer({ target }) {
      const divider = target.indexOf("|");
      const ref = divider >= 0 ? target.slice(0, divider) : target;
      const label = divider >= 0 ? target.slice(divider + 1) : ref.replace(/^#/, "");
      return '<a href="' + marker + encodeURIComponent(ref) + '">' + escape(label || ref) + "</a>";
    },
  }],
});

export const headingKey = (heading) => normalize(heading)
  .replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s+/g, "-");

export function renderMarkdown(container, { body, title, file, files, notes }) {
  const clean = DOMPurify.sanitize(md.parse(body), {
    RETURN_DOM_FRAGMENT: true,
    ADD_TAGS: ["input"],
    FORBID_TAGS: ["img", "video", "audio", "style", "form", "iframe", "svg", "math"],
    FORBID_ATTR: ["style", "src", "srcset"],
  });
  for (const a of clean.querySelectorAll("a")) {
    const href = a.getAttribute("href");
    if (!href) continue;
    const wiki = href.startsWith(marker);
    if (!wiki && /^(https?:\/\/|mailto:)/i.test(href)) {
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      continue;
    }
    let target = "";
    try { target = decodeURIComponent(wiki ? href.slice(marker.length) : href); } catch {}
    const i = target.indexOf("#");
    const name = (i < 0 ? target : target.slice(0, i)).trim();
    const heading = i < 0 ? "" : target.slice(i + 1).trim();
    const linked = target && findLink(files, notes, file, name);
    if (linked) a.href = noteRoute(linked.id, heading);
    else {
      const missing = document.createElement("span");
      missing.className = "muted";
      missing.title = "Связанная заметка не найдена или название неоднозначно";
      missing.append(...a.childNodes);
      a.replaceWith(missing);
    }
  }
  const first = clean.firstElementChild;
  if (first?.tagName === "H1" && normalize(first.textContent) === normalize(title)) first.remove();
  for (const heading of clean.querySelectorAll("h1,h2,h3,h4,h5,h6")) {
    heading.dataset.heading = headingKey(heading.textContent);
  }
  for (const table of clean.querySelectorAll("table")) {
    const wrapper = document.createElement("div");
    wrapper.className = "table-scroll";
    table.replaceWith(wrapper);
    wrapper.append(table);
  }
  container.replaceChildren(clean);
}
