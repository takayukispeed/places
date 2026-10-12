// The map with the real Leaflet (fetched once from npm) and a fake GPS fix: pins visible, the
// "my location" button, dot, centring, remembered setting and a denied permission.
//   NODE_PATH=$(npm root -g) node tests/map.e2e.cjs [screenshot.png]
const { chromium, devices } = require("playwright");
const http = require("node:http"), fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const assert = require("node:assert/strict");
const { execSync } = require("node:child_process");
const os = require("node:os");
const ROOT = path.resolve(__dirname, ".."), OUT = process.argv[2];
// Leaflet itself, same version the app loads from unpkg, cached in the temp folder.
const CACHE = path.join(os.tmpdir(), "places-leaflet-1.9.4");
const LF = path.join(CACHE, "package", "dist");
if (!fs.existsSync(LF)) {
  fs.mkdirSync(CACHE, { recursive: true });
  const tgz = execSync("npm pack leaflet@1.9.4 --silent", { cwd: CACHE }).toString().trim();
  execSync(`tar xzf ${tgz}`, { cwd: CACHE });
}
const T = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png" };
const srv = http.createServer((q, r) => { let p = decodeURIComponent(new URL(q.url, "http://x").pathname); if (p.endsWith("/")) p += "index.html";
  if (p === "/places.json") { r.writeHead(404); return r.end(); } // a local build may be stale; read the mocked API instead
  const f = path.join(ROOT, p); if (!fs.existsSync(f)) { r.writeHead(404); return r.end(); } r.writeHead(200, { "Content-Type": T[path.extname(f)] || "text/plain" }); fs.createReadStream(f).pipe(r); });
const repo = {}; for (const f of fs.readdirSync(ROOT + "/places/montreal")) repo["places/montreal/" + f] = fs.readFileSync(ROOT + "/places/montreal/" + f, "utf8");
const sha = (t) => crypto.createHash("sha1").update(t).digest("hex");
(async () => {
  await new Promise((r) => srv.listen(0, r));
  const b = await chromium.launch();
  const ctx = await b.newContext({ ...devices["iPhone 15"], serviceWorkers: "block", permissions: ["geolocation"], geolocation: { latitude: 45.5235, longitude: -73.5960, accuracy: 40 } });
  const cors = { "Access-Control-Allow-Origin": "*" };
  await ctx.route("https://api.github.com/**", (r) => { const p = new URL(r.request().url()).pathname;
    if (p.includes("/git/trees/")) return r.fulfill({ headers: cors, contentType: "application/json", body: JSON.stringify({ tree: Object.entries(repo).map(([path, t]) => ({ path, type: "blob", sha: sha(t) })) }) });
    const hit = Object.values(repo).find((t) => sha(t) === p.split("/").pop()); return r.fulfill({ headers: cors, body: hit || "" }); });
  await ctx.route("https://unpkg.com/**", (r) => r.fulfill({ path: LF + "/" + new URL(r.request().url()).pathname.split("/dist/")[1] }));
  await ctx.route("https://tile.openstreetmap.org/**", (r) => r.abort());
  const page = await ctx.newPage(); const errs = []; page.on("pageerror", (e) => errs.push(e.message));
  const base = `http://localhost:${srv.address().port}/`;
  await page.goto(base); await page.waitForSelector("path.leaflet-interactive"); // opens on the map, pins drawn
  assert.equal(await page.getAttribute("#locate", "aria-pressed"), "false");
  const before = await page.locator("path.leaflet-interactive").count();
  // Names: hidden on the whole-city view, shown from neighbourhood zoom, never overlapping.
  const shownLabels = () => page.evaluate(() => [...document.querySelectorAll(".pin-label")]
    .filter((l) => getComputedStyle(l).display !== "none" && l.style.visibility !== "hidden")
    .map((l) => { const r = l.getBoundingClientRect(); return { t: l.textContent, l: r.left, r: r.right, top: r.top, b: r.bottom }; }));
  assert.equal((await shownLabels()).length, 0, "no names on the city view");
  // New places get coordinates from a GitHub Action after they're pushed, so count those that have them.
  assert.equal(before, Object.values(repo).filter((t) => /^lat: -?\d/m.test(t)).length, "a pin for every place with coordinates");
  const pane = await page.locator("svg.leaflet-zoom-animated").boundingBox();
  assert.ok(pane.width > 100 && pane.height > 100, "pins are drawn in a full-size layer, not a 22px icon box");
  await page.click("#locate");
  await page.waitForFunction(() => document.querySelector(".me-dot") && document.querySelector("#locate").getAttribute("aria-pressed") === "true");
  await page.waitForTimeout(800);
  const paths = await page.locator(".leaflet-overlay-pane path").count();
  assert.equal(paths, before + 1, "accuracy ring");
  assert.equal(await page.locator(".me-marker").count(), 1, "one you-are-here marker");
  // centred on the fix
  const centre = await page.evaluate(() => { const r = document.querySelector("#map").getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; });
  const dot = await page.evaluate(() => { const d = document.querySelector(".me-dot").getBoundingClientRect(); return [d.left + d.width / 2, d.top + d.height / 2]; });
  assert.ok(Math.abs(centre[0] - dot[0]) < 3 && Math.abs(centre[1] - dot[1]) < 3, "map centred on me");
  const labs = await shownLabels();
  const inView = await page.evaluate(() => {
    const m = document.querySelector("#map").getBoundingClientRect();
    const inside = (r) => r.left >= m.left && r.right <= m.right && r.top >= m.top && r.bottom <= m.bottom;
    // Leaflet leaves off-screen pins as zero-size shapes, so count only drawn ones.
    const pins = [...document.querySelectorAll("path.leaflet-interactive")].map((p) => p.getBoundingClientRect()).filter((r) => r.width > 0 && inside(r)).length;
    const names = [...document.querySelectorAll(".pin-label")].filter((l) => l.style.visibility !== "hidden" && getComputedStyle(l).display !== "none" && inside(l.getBoundingClientRect())).length;
    return { pins, names };
  });
  assert.ok(inView.names >= inView.pins / 3, `pins on screen get names once zoomed in (${inView.names} names, ${inView.pins} pins)`);
  for (const [i, a] of labs.entries()) for (const b2 of labs.slice(i + 1)) {
    assert.ok(a.r <= b2.l || b2.r <= a.l || a.b <= b2.top || b2.b <= a.top, `"${a.t}" overlaps "${b2.t}"`);
  }
  const pinBoxes = await page.evaluate(() => [...document.querySelectorAll("path.leaflet-interactive")].map((p) => p.getBoundingClientRect()).filter((r) => r.width > 0).map((r) => ({ l: r.left, r: r.right, top: r.top, b: r.bottom })));
  for (const a of labs) for (const p of pinBoxes) {
    assert.ok(a.r <= p.l || p.r <= a.l || a.b <= p.top || p.b <= a.top, `"${a.t}" covers a pin`);
  }
  // Tapping a name opens the same popup as its pin
  await page.locator(".pin-label", { hasText: labs[0].t }).click();
  await page.waitForSelector(".leaflet-popup");
  assert.ok((await page.locator(".leaflet-popup-content").innerText()).startsWith(labs[0].t), "label opens its place's popup");
  // From the popup to the place page and Back: the map is where it was, not refitted to the city
  const pinSpots = () => page.evaluate(() => {
    const m = document.querySelector("#map").getBoundingClientRect();
    return [...document.querySelectorAll("path.leaflet-interactive")].map((p) => p.getBoundingClientRect())
      .filter((r) => r.width > 0).map((r) => `${Math.round(r.x - m.x)},${Math.round(r.y - m.y)}`).sort().join(" ");
  });
  const spotsBefore = await pinSpots();
  await page.locator(".leaflet-popup-content a").first().click();
  await page.waitForSelector(".place");
  await page.goBack();
  await page.waitForSelector("path.leaflet-interactive");
  await page.waitForTimeout(300);
  assert.equal(await pinSpots(), spotsBefore, "map keeps its position after Back");
  if (OUT) await page.screenshot({ path: OUT });
  // moving updates the dot, not adds another
  await ctx.setGeolocation({ latitude: 45.525, longitude: -73.59, accuracy: 20 });
  await page.waitForTimeout(1500);
  assert.equal(await page.locator(".leaflet-overlay-pane path").count(), before + 1);
  assert.equal(await page.locator(".me-marker").count(), 1, "moving updates the marker, not adds one");
  // remembered: list → map shows the dot again without tapping
  await page.click("[data-mode=list]"); await page.click("[data-mode=map]"); await page.waitForSelector(".leaflet-container");
  await page.waitForFunction(() => document.querySelectorAll(".me-marker").length === 1);
  assert.equal(await page.getAttribute("#locate", "aria-pressed"), "true");
  // denied permission: friendly message, button off, setting forgotten
  await ctx.clearPermissions();
  await page.evaluate(() => localStorage.removeItem("pl.showMyLocation"));
  await page.click("[data-mode=list]"); await page.click("[data-mode=map]"); await page.waitForSelector(".leaflet-container");
  await page.evaluate(() => { navigator.geolocation.watchPosition = (ok, err) => { setTimeout(() => err({ code: 1 }), 50); return 1; }; navigator.geolocation.clearWatch = () => {}; });
  await page.click("#locate");
  await page.waitForFunction(() => document.querySelector("#locate").getAttribute("aria-pressed") === "false");
  assert.match(await page.innerText("#toast"), /Location/);
  assert.equal(await page.evaluate(() => localStorage.getItem("pl.showMyLocation")), null);
  assert.deepEqual(errs, []);
  console.log("map e2e passed");
  await b.close(); srv.close();
})().catch((e) => { console.error(e); process.exit(1); });
