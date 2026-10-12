// End-to-end smoke test in an emulated iPhone, with the GitHub API and OpenStreetMap mocked
// from the files in this repo. Needs Playwright:
//   NODE_PATH=$(npm root -g) node tests/app.e2e.cjs [screenshot-dir]
const { chromium, devices } = require("playwright");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const assert = require("node:assert/strict");

const ROOT = path.resolve(__dirname, "..");
const SHOTS = process.argv[2];
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".webmanifest": "application/manifest+json", ".md": "text/markdown" };

// Static server for the app. places.json is built from the fake repo below, like the Pages deploy does.
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (p === "/places.json") {
    const files = Object.fromEntries(Object.entries(repo).filter(([f]) => f.startsWith("places/")).map(([f, text]) => [f, { sha: sha(text), text }]));
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ files }));
  }
  if (p.endsWith("/")) p += "index.html";
  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});

// In-memory fake of the repo, seeded from places/.
const repo = {};
for (const city of fs.readdirSync(path.join(ROOT, "places"))) {
  for (const f of fs.readdirSync(path.join(ROOT, "places", city)).filter((f) => f.endsWith(".md"))) {
    repo[`places/${city}/${f}`] = fs.readFileSync(path.join(ROOT, "places", city, f), "utf8");
  }
}
repo["README.md"] = "# not a place\n";
// One place with no hours saved, to check the app points to Google Maps instead.
repo["places/montreal/test-no-hours.md"] = "---\nname: Test Spot\ncity: Montréal\ncategory: cheap\naddress: 1 Rue Test, Montréal\n---\n\n# Test Spot\n\n## Hours\n\n## Notes\n";
const sha = (t) => crypto.createHash("sha1").update(t).digest("hex");
const commits = [];
const apiCalls = [];
const cors = { "Access-Control-Allow-Origin": "*" };

async function mockGitHub(route) {
  const req = route.request();
  const url = new URL(req.url());
  const p = url.pathname.replace("/repos/takayukispeed/places", "");
  apiCalls.push(p);
  const json = (status, body) => route.fulfill({ status, headers: { ...cors, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (p.startsWith("/git/trees/")) {
    return json(200, { tree: Object.entries(repo).map(([path, t]) => ({ path, type: "blob", sha: sha(t) })) });
  }
  if (p.startsWith("/git/blobs/")) {
    const hit = Object.values(repo).find((t) => sha(t) === p.split("/").pop());
    return route.fulfill({ status: hit ? 200 : 404, headers: cors, body: hit || "" });
  }
  if (p.startsWith("/contents/")) {
    const file = decodeURIComponent(p.slice("/contents/".length));
    const body = JSON.parse(req.postData());
    if (repo[file] && body.sha !== sha(repo[file])) return json(409, { message: "sha mismatch" });
    commits.push({ method: req.method(), file, message: body.message });
    if (req.method() === "DELETE") { delete repo[file]; return json(200, {}); }
    repo[file] = Buffer.from(body.content, "base64").toString("utf8");
    return json(200, { content: { sha: sha(repo[file]) } });
  }
  if (p === "") return json(200, { permissions: { push: true } });
  return json(404, { message: "not mocked" });
}

const KAZU = [{
  lat: "45.4932", lon: "-73.5791", display_name: "Kazu, 1862, Rue Sainte-Catherine Ouest, Montréal",
  address: { house_number: "1862", road: "Rue Sainte-Catherine Ouest", city: "Montréal", postcode: "H3H 1M1", suburb: "Ville-Marie" },
  extratags: { opening_hours: "Mo,Th-Su 12:00-21:00; Tu,We off", phone: "+1 514-937-2333" },
}];

(async () => {
  await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}/`;
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ...devices["iPhone 15"], serviceWorkers: "block" });
  await ctx.route("https://api.github.com/**", mockGitHub);
  await ctx.route("https://unpkg.com/**", (r) => r.abort()); // no Leaflet offline: the map shows a message
  await ctx.route("https://nominatim.openstreetmap.org/**", (r) => r.fulfill({
    status: 200, headers: { ...cors, "Content-Type": "application/json" }, body: JSON.stringify(KAZU),
  }));
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => { errors.push(e.message); if (process.env.DEBUG) console.log(e.stack); });
  const shot = (name) => SHOTS && page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: false });
  const placeCount = Object.keys(repo).filter((p) => p.startsWith("places/")).length;
  const count = (cat) => Object.values(repo).filter((t) => new RegExp(`^category: ${cat}$`, "m").test(t)).length;

  // List: every place, grouped by category in a fixed order
  await page.goto(base);
  await page.waitForSelector(".card");
  assert.equal(await page.locator(".card").count(), placeCount);
  // Signed out (a friend's phone): everything comes from places.json, not the rate-limited API,
  // and there's no way to add or edit.
  assert.deepEqual(apiCalls, []);
  assert.equal(await page.locator(".fab").count(), 0);
  assert.deepEqual(await page.locator(".list-heading").allInnerTexts(),
    ["CHEAP EATS", "NICE MEAL", "BRUNCH", "CAFÉS", "BAKERIES", "BARS", "FANCY BARS"]);
  await shot("1-list");

  // Copy app link: the address without the #/… page
  await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });
  await page.click("#copy-link");
  await page.waitForSelector("text=App link copied");
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), base);

  // Filters: category chip, search (keeps focus), open now
  await page.click(".chip[data-cat=bar]");
  assert.equal(await page.locator(".card").count(), count("bar"));
  await page.fill("#search", "rachel");
  assert.equal(await page.evaluate(() => document.activeElement.id), "search");
  assert.equal(await page.locator(".card").count(), 2, "Pit Caribou and Projet Pilote");
  await page.fill("#search", "");
  await page.click(".chip[data-cat='']");
  await page.click("#open-now");
  const open = await page.locator(".card").count();
  assert.ok(open < placeCount);
  assert.equal(await page.locator(".card .status-dot.shut").count(), 0, "only open places");
  await page.click("#open-now");

  // Place page
  await page.click("text=Big in Japan");
  await page.waitForSelector(".hours");
  assert.equal(await page.locator(".hours li").count(), 3);
  assert.equal(await page.locator(".hours li.today").count(), 1);
  assert.match(await page.locator(".actions").innerText(), /Directions[\s\S]*Google Maps/);
  assert.equal(await page.locator("text=Edit").count(), 0, "no Edit when signed out");
  assert.equal(await page.locator(".actions a", { hasText: "Reserve" }).count(), 0, "no reservation link saved");
  assert.match(await page.locator(".actions a").nth(1).getAttribute("href"), /^https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=Big%20in%20Japan%2C%204175/);
  assert.match(await page.locator(".actions a").nth(0).getAttribute("href"), /^https:\/\/www\.google\.com\/maps\/dir\/\?api=1&destination=Big%20in%20Japan%2C%204175/);
  await shot("2-place");

  // A place without hours points to Google Maps
  await page.goto(base + "#/view/places/montreal/test-no-hours.md");
  await page.waitForSelector("text=No hours saved");

  // Map: Leaflet can't load in this test, so it explains instead of breaking
  await page.goto(base);
  await page.click("[data-mode=map]");
  await page.waitForSelector("text=The map needs a connection");
  // Icon styles must not reach other <svg>s: Leaflet draws the pins in one, and a 22px rule hid them all.
  assert.equal(await page.evaluate(() => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("width", "300"); svg.setAttribute("height", "200");
    document.querySelector("#results").append(svg);
    const { width, fill } = getComputedStyle(svg);
    svg.remove();
    return `${width} ${fill}`;
  }), "300px rgb(0, 0, 0)");
  await page.click("[data-mode=list]");

  // Editing without a token is blocked
  await page.goto(base + "#/new/place");
  assert.ok(await page.locator("#save").isDisabled());

  // Add a token
  await page.goto(base + "#/settings");
  await page.fill("#token", "github_pat_test");
  await page.click("#save-token");
  await page.waitForSelector("text=Connected");
  assert.deepEqual(apiCalls.filter((c) => c.startsWith("/git/blobs/")), [], "signed in, the bundle's cache is reused");
  await shot("3-settings");

  // Add a place with an OpenStreetMap lookup
  await page.goto(base);
  await page.waitForSelector(".card");
  await page.click(".fab");
  await page.fill("#name", "Kazu");
  await page.selectOption("#category", "cheap");
  assert.equal(await page.inputValue("#city"), "Montréal", "defaults to the city being browsed");
  await page.click("#lookup");
  await page.waitForSelector("text=Filled in");
  assert.equal(await page.inputValue("#address"), "1862 Rue Sainte-Catherine Ouest, Montréal, H3H 1M1");
  assert.equal(await page.inputValue("#hours"), "Mon, Thu–Sun: 12:00–21:00\nTue, Wed: Closed");
  assert.equal(await page.inputValue("#lat"), "45.493200");
  await page.fill("#notes", "Get the **pork bowl**.");
  await page.fill("#reserve", "https://example.com/book");
  await shot("4-editor");
  await page.click("#save");
  await page.waitForURL(/#\/view\/places\/montreal\/kazu\.md$/);
  assert.match(repo["places/montreal/kazu.md"], /^---\nname: Kazu\ncity: Montréal\ncategory: cheap\narea: Ville-Marie\naddress: 1862 Rue Sainte-Catherine Ouest, Montréal, H3H 1M1\nphone: \+1 514-937-2333\nwebsite:\nreserve: https:\/\/example\.com\/book\nlat: 45\.4932\nlng: -73\.5791\nchecked: \d{4}-\d{2}-\d{2}\n---\n\n# Kazu\n\n## Hours\n\n- Mon, Thu–Sun: 12:00–21:00\n- Tue, Wed: Closed\n\n## Notes\n\nGet the \*\*pork bowl\*\*\.\n$/);
  assert.equal(await page.locator(".notes strong").innerText(), "pork bowl");
  assert.equal(await page.locator(".actions a", { hasText: "Reserve" }).getAttribute("href"), "https://example.com/book");

  // Edit: a new address clears the old coordinates so the pin gets looked up again
  await page.click("text=Edit");
  await page.fill("#address", "1863 Rue Sainte-Catherine Ouest, Montréal");
  await page.click("#save");
  await page.waitForSelector(".hours");
  assert.match(repo["places/montreal/kazu.md"], /\nlat:\nlng:\n/);

  // Moving it to another city moves the file
  await page.click("text=Edit");
  await page.fill("#city", "Toronto");
  await page.click("#save");
  await page.waitForURL(/#\/view\/places\/toronto\/kazu\.md$/);
  assert.ok(repo["places/toronto/kazu.md"] && !repo["places/montreal/kazu.md"]);
  await page.goto(base);
  await page.waitForSelector("#city");
  assert.equal(await page.inputValue("#city"), "Toronto", "remembers the last city");
  assert.equal(await page.locator(".card").count(), 1);
  await page.selectOption("#city", "Montréal");
  assert.equal(await page.locator(".card").count(), placeCount);
  await page.selectOption("#city", "");
  assert.equal(await page.locator(".card").count(), placeCount + 1);

  // Delete
  page.once("dialog", (d) => d.accept());
  await page.goto(base + "#/edit/places/toronto/kazu.md");
  await page.click("#delete");
  await page.waitForURL(/#\/$/);
  assert.ok(!repo["places/toronto/kazu.md"]);

  // Unknown pages
  await page.goto(base + "#/view/places/montreal/nope.md");
  await page.waitForSelector("text=That page isn't here");

  // Offline: a fresh load with the API down still shows cached places
  await ctx.unroute("https://api.github.com/**");
  await ctx.route("https://api.github.com/**", (r) => r.abort());
  await page.goto(base);
  await page.reload();
  await page.waitForSelector(".card");

  assert.deepEqual(commits.map((c) => c.message), [
    "Add place: Kazu", "Update place: Kazu", "Update place: Kazu", "Move place: Kazu", "Delete place: Kazu",
  ]);
  assert.deepEqual(errors, []);
  await browser.close();
  server.close();
  console.log("e2e passed");
})().catch((e) => { console.error(e); process.exit(1); });
