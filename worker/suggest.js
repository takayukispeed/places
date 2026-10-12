// Cloudflare Worker behind the app's "Suggest a place" form. It saves each suggestion as a small
// file in inbox/ in the repo; a daily Claude routine (SUGGESTIONS.md) researches it and leaves a
// draft in suggestions/ for review in the app.
//
// Setup (Cloudflare dashboard → Workers & Pages → Create → Worker): paste this file, deploy, then
// under Settings → Variables and Secrets add a secret GITHUB_TOKEN: a fine-grained GitHub token for
// takayukispeed/places only, with Contents: Read and write. The token never reaches the app.
const REPO = "takayukispeed/places";
const BRANCH = "main";
const APP_ORIGIN = "https://takayukispeed.github.io";
const LIMIT = 5; // suggestions per visitor per hour (best effort: kept in this Worker's memory)

const recent = new Map(); // ip -> [timestamps]

export default {
  async fetch(req, env) {
    const cors = {
      "Access-Control-Allow-Origin": APP_ORIGIN,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };
    const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    if (req.method !== "POST") return reply(404, { error: "Not found" });
    if (req.headers.get("Origin") !== APP_ORIGIN) return reply(403, { error: "Not allowed" });

    let body;
    try { body = await req.json(); } catch { return reply(400, { error: "Bad request" }); }
    const clean = (v, max) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
    const name = clean(body.name, 120);
    const city = clean(body.city, 60);
    const by = clean(body.by, 60);
    const note = clean(body.note, 500);
    if (clean(body.website, 10)) return reply(200, { ok: true }); // hidden field only bots fill in
    if (!name || !city) return reply(400, { error: "Add the place's name and city." });

    const ip = req.headers.get("CF-Connecting-IP") || "unknown";
    const now = Date.now();
    const times = (recent.get(ip) || []).filter((t) => now - t < 3600e3);
    if (times.length >= LIMIT) return reply(429, { error: "That's a lot of suggestions. Try again later." });
    recent.set(ip, [...times, now]);

    const slug = name.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50) || "place";
    const at = new Date(now).toISOString();
    const path = `inbox/${at.replace(/[:.]/g, "-")}-${slug}.json`;
    const text = JSON.stringify({ name, city, by, note, at }, null, 2) + "\n";
    const res = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json", "User-Agent": "places-suggest" },
      body: JSON.stringify({
        message: `Suggestion: ${name} (${city})`,
        content: btoa(unescape(encodeURIComponent(text))),
        branch: BRANCH,
      }),
    });
    if (!res.ok) return reply(502, { error: "Couldn't save it just now. Try again in a minute." });
    return reply(200, { ok: true });
  },
};
