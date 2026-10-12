// The map with the real Leaflet (app/vendor) and a fake GPS fix: pins visible, the
// "my location" button, dot, centring, remembered setting and a denied permission.
//   NODE_PATH=$(npm root -g) node tests/map.e2e.cjs [screenshot.png]
const { chromium, devices } = require("playwright");
const http = require("node:http"), fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const assert = require("node:assert/strict");
const ROOT = path.resolve(__dirname, ".."), OUT = process.argv[2];
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
  await ctx.route("https://tile.openstreetmap.org/**", (r) => r.abort());
  const page = await ctx.newPage(); const errs = []; page.on("pageerror", (e) => errs.push(e.message));
  const base = `http://localhost:${srv.address().port}/`;
  await page.goto(base); await page.waitForSelector("path.leaflet-interactive"); // opens on the map, pins drawn
  // Double-tap on an empty spot zooms in exactly one level (Safari needs the app's own handling)
  const zoom = () => page.evaluate(() => Number(document.querySelector("#map").dataset.zoom));
  const mb = await page.locator("#map").boundingBox();
  const empty = await page.evaluate(({ x, y, w, h }) => {
    for (let fy = 0.15; fy < 0.9; fy += 0.05) for (let fx = 0.1; fx < 0.9; fx += 0.05) {
      const px = x + w * fx, py = y + h * fy;
      const el = document.elementFromPoint(px, py);
      if (el && !el.closest(".leaflet-interactive, .leaflet-control, .locate-btn, .pin-label")) return { px, py };
    }
  }, { x: mb.x, y: mb.y, w: mb.width, h: mb.height });
  const z0 = await zoom();
  await page.touchscreen.tap(empty.px, empty.py); await page.waitForTimeout(60); await page.touchscreen.tap(empty.px, empty.py);
  await page.waitForFunction((z) => Number(document.querySelector("#map").dataset.zoom) !== z, z0);
  await page.waitForTimeout(400);
  assert.equal(await zoom(), z0 + 1, "double-tap zooms in one level");
  // two taps far apart, or slow, don't zoom
  await page.touchscreen.tap(empty.px, empty.py); await page.waitForTimeout(500); await page.touchscreen.tap(empty.px, empty.py);
  await page.waitForTimeout(500);
  assert.equal(await zoom(), z0 + 1, "slow taps don't zoom");
  // back to the starting view for the rest of the test
  await page.reload(); await page.waitForSelector("path.leaflet-interactive");
  assert.equal(await page.getAttribute("#locate", "aria-pressed"), "false");
  const before = await page.locator("path.leaflet-interactive").count();
  // Names: some even on the whole-city view, more closer in, never overlapping each other or a pin.
  const shownLabels = () => page.evaluate(() => [...document.querySelectorAll(".pin-label")]
    .filter((l) => getComputedStyle(l).display !== "none" && l.style.visibility !== "hidden")
    .map((l) => { const r = l.getBoundingClientRect(); return { t: l.textContent, l: r.left, r: r.right, top: r.top, b: r.bottom }; }));
  const cityLabs = await shownLabels();
  assert.ok(cityLabs.length > 3, `some names on the city view (${cityLabs.length})`);
  assert.ok(cityLabs.length < 40, "but not every name");
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
  const mapRect = await page.locator("#map").boundingBox();
  const tapLabel = labs.find((l) => l.l >= mapRect.x && l.r <= mapRect.x + mapRect.width && l.top >= mapRect.y && l.b <= mapRect.y + mapRect.height);
  await page.locator(".pin-label", { hasText: tapLabel.t }).click();
  await page.waitForSelector(".leaflet-popup");
  assert.ok((await page.locator(".leaflet-popup-content").innerText()).startsWith(tapLabel.t), "label opens its place's popup");
  // From the popup to the place page and Back: the map is where it was, not refitted to the city
  const pinSpots = () => page.evaluate(() => {
    const m = document.querySelector("#map").getBoundingClientRect();
    return [...document.querySelectorAll("path.leaflet-interactive")].map((p) => p.getBoundingClientRect())
      .filter((r) => r.width > 0).map((r) => `${Math.round(r.x - m.x)},${Math.round(r.y - m.y)}`).sort().join(" ");
  });
  // The popup may pan the map to fit; measure once it has stopped moving.
  const settled = async () => { let a, b = await pinSpots(); do { a = b; await page.waitForTimeout(300); b = await pinSpots(); } while (a !== b); return b; };
  const spotsBefore = await settled();
  await page.locator(".leaflet-popup-content a").first().click();
  await page.waitForSelector(".place");
  await page.goBack();
  await page.waitForFunction(() => [...document.querySelectorAll("path.leaflet-interactive")].some((p) => p.getBoundingClientRect().width > 0));
  await page.waitForTimeout(300);
  assert.equal(await settled(), spotsBefore, "map keeps its position after Back");
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
