// Markdown helpers for the files in places/: front matter, list items, inline formatting.
// Shared by the app (browser) and tests (Node).

export function parseFrontMatter(text) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const meta = {};
  if (lines[0]?.trim() !== "---") return { meta, body: lines.join("\n") };
  let i = 1;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "---") break;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (value.startsWith("[") && value.endsWith("]")) {
      value = value.slice(1, -1).split(",").map((v) => v.trim()).filter(Boolean);
    }
    meta[key] = value;
  }
  return { meta, body: lines.slice(i + 1).join("\n") };
}

// Turn "- a\n- b" or "1. a\n2. b" into one item per line, keeping "### sub" headings.
export function listItems(text) {
  return (text || "").split("\n")
    .map((l) => l.trim())
    .filter((l) => l && l !== "-" && !/^\d+\.$/.test(l))
    .map((l) => l.replace(/^[-*]\s+/, "").replace(/^\d+\.\s+/, ""));
}

export function slugify(title) {
  return title.toLowerCase()
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
    .slice(0, 60) || "untitled";
}

const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Minimal inline Markdown: links, **bold**, *italic* / _italic_. Output is HTML-safe.
export function inline(md) {
  const links = [];
  let s = (md || "").replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text, url) => {
    links.push({ text, url });
    return `\u0000${links.length - 1}\u0000`;
  });
  s = escapeHtml(s)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])\*(?!\s)(.+?)\*(?=$|[\s).,;:!?])/g, "$1<em>$2</em>")
    .replace(/(^|[\s(])_(?!\s)(.+?)_(?=$|[\s).,;:!?])/g, "$1<em>$2</em>");
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => {
    const { text, url } = links[Number(i)];
    const local = url.match(/^(?:\.\.\/)*(places\/[\w.-]+\/[\w.-]+\.md)$/);
    if (local) return `<a href="#/view/${local[1]}">${escapeHtml(text)}</a>`;
    if (/^https?:\/\//.test(url)) {
      return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(text)}</a>`;
    }
    return escapeHtml(text);
  });
}

// Paragraphs and "- " lists for intro/notes blocks.
export function block(md) {
  const html = [];
  let list = null;
  for (const raw of (md || "").split("\n")) {
    const line = raw.trim();
    const item = line.match(/^[-*]\s+(.*)$/);
    if (item) { (list ??= []).push(`<li>${inline(item[1])}</li>`); continue; }
    if (list) { html.push(`<ul>${list.join("")}</ul>`); list = null; }
    if (line) html.push(`<p>${inline(line)}</p>`);
  }
  if (list) html.push(`<ul>${list.join("")}</ul>`);
  return html.join("");
}

export { escapeHtml };
