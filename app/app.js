import { slugify, block, escapeHtml as esc } from "./format.js";
import {
  CATEGORIES, categoryLabel, categoryColour, categoryOrder,
  parsePlace, serializePlace, placePath, hoursStatus, todayLine, osmHoursToLines,
} from "./places.js";

// ---- Config ---------------------------------------------------------------
// On GitHub Pages (owner.github.io/repo/) the repo is read from the URL;
// anywhere else (e.g. local testing) these defaults are used.
const DEFAULT_OWNER = "takayukispeed";
const DEFAULT_REPO = "places";
const BRANCH = "main";

const onPages = location.hostname.endsWith(".github.io");
const OWNER = onPages ? location.hostname.split(".")[0] : DEFAULT_OWNER;
const REPO = onPages ? location.pathname.split("/").filter(Boolean)[0] || DEFAULT_REPO : DEFAULT_REPO;
const API = `https://api.github.com/repos/${OWNER}/${REPO}`;

// Prefixed "pl." because other apps on the same github.io address share this storage.
const KEY_CACHE = "pl.files.v1";
const KEY_TOKEN = "pl.token";
const KEY_HINT = "pl.installHintDismissed";
const KEY_CITY = "pl.city";
const KEY_GEO = "pl.geo.v1";
const KEY_LOCATE = "pl.showMyLocation";
const KEY_SORT = "pl.listSort"; // "az" once chosen; nearest first otherwise

// ---- Storage (wrapped: private mode can make localStorage throw) ----------
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

const state = {
  files: JSON.parse(store.get(KEY_CACHE) || "{}"), // path -> { sha, text }
  places: [],
  placeQuery: "",
  placeCats: new Set(), // categories shown; empty means all
  placeOpenNow: false,
  placeReservable: false, // only places with a booking link
  placesMode: "map", // or "list"
  syncing: false,
  syncError: null,
  lastSync: null,
};

const token = () => store.get(KEY_TOKEN) || "";

// ---- GitHub API -----------------------------------------------------------
async function gh(path, { method = "GET", body, accept } = {}) {
  const headers = { Accept: accept || "application/vnd.github+json" };
  if (token()) headers.Authorization = `Bearer ${token()}`;
  if (body) headers["Content-Type"] = "application/json";
  const res = await fetch(API + path, {
    method, headers, cache: "no-store", body: body && JSON.stringify(body),
  });
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).message || msg; } catch { /* not JSON */ }
    const err = new Error(msg);
    err.status = res.status;
    err.rateLimited = (res.status === 403 || res.status === 429)
      && res.headers.get("x-ratelimit-remaining") === "0";
    throw err;
  }
  return res;
}

function friendlyError(err) {
  if (err.rateLimited) return "GitHub's limit for signed-out reads was hit. Add a token in Settings, or try again within the hour.";
  if (err.status === 401) return "The GitHub token was rejected. Check it in Settings.";
  if (err.status === 403 || err.status === 404) return "No permission. The token needs Contents: Read and write on this repo.";
  if (err.status === 409 || err.status === 422) return "The file changed on GitHub since you opened it. Sync, then redo the edit.";
  if (err instanceof TypeError) return "You appear to be offline.";
  return err.message || "Something went wrong.";
}

function toBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

async function pool(items, size, fn) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(size, queue.length) }, async () => {
    while (queue.length) await fn(queue.shift());
  }));
}

async function sync({ quiet = false } = {}) {
  if (state.syncing) return;
  state.syncing = true;
  updateSyncButton();
  try {
    // Signed out: one download of every place, published with the app (see scripts/build_bundle.py).
    // The GitHub API's signed-out limit (60 requests an hour) can't fetch them one by one.
    const bundle = token() ? null : await fetch("places.json", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    const tree = bundle
      ? { tree: Object.entries(bundle.files).map(([path, f]) => ({ path, type: "blob", sha: f.sha })) }
      : await (await gh(`/git/trees/${BRANCH}?recursive=1`)).json();
    const wanted = tree.tree.filter((e) => e.type === "blob" && /^places\/[^/]+\/[^/]+\.md$/.test(e.path));
    const next = {};
    const todo = [];
    for (const e of wanted) {
      const cached = state.files[e.path];
      if (cached && cached.sha === e.sha) next[e.path] = cached;
      else todo.push(e);
    }
    const changed = todo.length;
    if (bundle) for (const e of todo.splice(0)) next[e.path] = bundle.files[e.path];
    await pool(todo, 6, async (e) => {
      const res = await gh(`/git/blobs/${e.sha}`, { accept: "application/vnd.github.raw+json" });
      next[e.path] = { sha: e.sha, text: await res.text() };
    });
    state.files = next;
    state.lastSync = new Date();
    persist();
    rebuild();
    safeRender();
    if (!quiet && changed) toast(`Updated ${changed} file${changed > 1 ? "s" : ""}`);
    state.syncError = null;
  } catch (err) {
    state.syncError = friendlyError(err);
    // Background syncs fail quietly when there's a cached copy to show.
    if (!quiet || !Object.keys(state.files).length) toast(state.syncError);
  } finally {
    state.syncing = false;
    updateSyncButton();
    if (!Object.keys(state.files).length) safeRender();
  }
}

async function saveFile(path, text, message) {
  const existing = state.files[path];
  const body = { message, content: toBase64(text), branch: BRANCH };
  if (existing) body.sha = existing.sha;
  const res = await gh(`/contents/${path}`, { method: "PUT", body });
  const json = await res.json();
  state.files[path] = { sha: json.content.sha, text };
  persist();
  rebuild();
}

async function deleteFile(path, message) {
  await gh(`/contents/${path}`, {
    method: "DELETE", body: { message, sha: state.files[path].sha, branch: BRANCH },
  });
  delete state.files[path];
  persist();
  rebuild();
}

function persist() { store.set(KEY_CACHE, JSON.stringify(state.files)); }

function rebuild() {
  state.places = Object.entries(state.files).filter(([p]) => p.startsWith("places/"))
    .map(([path, f]) => ({ path, ...parsePlace(f.text) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function uniquePath(folder, title) {
  const base = slugify(title);
  let path = `${folder}/${base}.md`;
  for (let n = 2; state.files[path]; n++) path = `${folder}/${base}-${n}.md`;
  return path;
}

// ---- UI helpers -----------------------------------------------------------
const $ = (sel, root = document) => root.querySelector(sel);
const app = $("#app");

let toastTimer;
// The app's address without the current page (#/…), to send to friends.
async function copyAppLink() {
  const url = location.origin + location.pathname;
  try {
    await navigator.clipboard.writeText(url);
    toast("App link copied");
  } catch {
    window.prompt("Copy this link:", url); // clipboard blocked: show it to copy by hand
  }
}

function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 4000);
}

function updateSyncButton() {
  const btn = $("#sync");
  if (!btn) return;
  btn.disabled = state.syncing;
  btn.classList.toggle("spinning", state.syncing);
}

const ICON = {
  sync: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12a8 8 0 0 1-14.3 4.9M4 12a8 8 0 0 1 14.3-4.9M18.5 3v4.2h-4.2M5.5 21v-4.2h4.2"/></svg>',
  gear: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
  plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  pin: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>',
  locate: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 11l18-8-8 18-2-8-8-2z"/></svg>',
  calendar: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5" width="16" height="16" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/></svg>',
  link: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 14a4.5 4.5 0 0 0 6.4 0l3.2-3.2a4.5 4.5 0 0 0-6.4-6.4L11.6 6"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3.2 3.2a4.5 4.5 0 0 0 6.4 6.4l1.6-1.6"/></svg>',
  phone: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z"/></svg>',
  external: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
  back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>',
};

const isStandalone = () => window.navigator.standalone === true
  || window.matchMedia("(display-mode: standalone)").matches;
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent);

// ---- Views ----------------------------------------------------------------
function topBar(title) {
  return `<header class="bar">
      <h1>${title}</h1>
      <div class="bar-actions">
        <button id="copy-link" class="icon-btn" aria-label="Copy app link">${ICON.link}</button>
        <button id="sync" class="icon-btn" aria-label="Sync with GitHub">${ICON.sync}</button>
        <a class="icon-btn" href="#/settings" aria-label="Settings">${ICON.gear}</a>
      </div>
    </header>`;
}

function backBar(href, label, right = "") {
  return `<header class="bar sub">
    <a class="back" href="${href}">${ICON.back}<span>${label}</span></a>
    <div class="bar-actions">${right}</div>
  </header>`;
}

const field = (id, label, value, attrs = "") =>
  `<label class="field"><span>${label}</span><input id="${id}" value="${esc(value || "")}" ${attrs}></label>`;
const area = (id, label, value, hint, rows = 6) =>
  `<label class="field"><span>${label}${hint ? ` <small>${hint}</small>` : ""}</span>
    <textarea id="${id}" rows="${rows}">${esc(value || "")}</textarea></label>`;
const lines = (s) => s.split("\n").map((l) => l.trim()).filter(Boolean);

function tokenBanner() {
  return token() ? "" : `<p class="warn">To save changes, add a GitHub token in <a href="#/settings">Settings</a>.</p>`;
}

async function withBusy(btn, fn) {
  btn.disabled = true;
  try { await fn(); } catch (err) { toast(friendlyError(err)); } finally { btn.disabled = false; }
}

function settingsView() {
  const repoUrl = `https://github.com/${OWNER}/${REPO}`;
  app.innerHTML = `
    ${backBar("#/", "Places")}
    <div class="editor">
      <h1>Settings</h1>
      <section class="panel">
        <h2>GitHub sync</h2>
        <p>Places live in <a href="${repoUrl}" target="_blank" rel="noopener">${OWNER}/${REPO}</a>.
          Reading works without signing in. To add or edit places, paste a GitHub token below. It is stored only on this device.</p>
        <label class="field"><span>Personal access token</span>
          <input id="token" type="password" value="${esc(token())}" autocomplete="off" autocapitalize="none" placeholder="github_pat_…"></label>
        <div class="buttons">
          <button id="save-token" class="primary">Save &amp; test</button>
          ${token() ? `<button id="clear-token">Remove</button>` : ""}
        </div>
        <p id="token-status" class="status"></p>
        <details>
          <summary>How to make a token</summary>
          <ol>
            <li>Open <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">GitHub → Fine-grained tokens → Generate new token</a>.</li>
            <li>Under <em>Repository access</em> choose <strong>Only select repositories</strong> → <strong>${REPO}</strong>.</li>
            <li>Under <em>Permissions → Repository permissions</em> set <strong>Contents</strong> to <strong>Read and write</strong>.</li>
            <li>Pick an expiry, generate the token, and paste it here.</li>
          </ol>
        </details>
      </section>
      <section class="panel">
        <h2>Data</h2>
        <p>${state.places.length} places cached for offline use.
          ${state.lastSync ? `Last synced ${state.lastSync.toLocaleTimeString()}.` : ""}</p>
        <div class="buttons"><button id="resync">Re-download everything</button></div>
      </section>
    </div>
  `;
  const status = $("#token-status");
  $("#save-token").onclick = () => withBusy($("#save-token"), async () => {
    const value = $("#token").value.trim();
    if (!value) { status.textContent = "Paste a token first."; return; }
    store.set(KEY_TOKEN, value);
    status.textContent = "Testing…";
    try {
      const repo = await (await gh("")).json();
      status.textContent = repo.permissions?.push
        ? "✓ Connected. You can add and edit places."
        : "Token works but can't write to this repo. Check Contents: Read and write.";
    } catch (err) {
      status.textContent = friendlyError(err);
    }
  });
  $("#clear-token")?.addEventListener("click", () => { store.del(KEY_TOKEN); render(); toast("Token removed"); });
  $("#resync").onclick = () => { state.files = {}; persist(); rebuild(); sync(); toast("Re-downloading…"); };
}

function notFound() {
  app.innerHTML = `${backBar("#/", "Places")}<p class="empty">That page isn't here. It may have been renamed or deleted. Try syncing.</p>`;
}

// ---- Places: restaurants, cafés and bars by city --------------------------
const cities = () => [...new Set(state.places.map((p) => p.city).filter(Boolean))].sort((a, b) => a.localeCompare(b));
function currentCity() {
  const all = cities();
  const saved = store.get(KEY_CITY);
  return saved === "" || all.includes(saved) ? saved : all[0] || "";
}

const googleMaps = (p) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([p.name, p.address || p.city].filter(Boolean).join(", "))}`;
// Google Maps directions; on iPhone this opens the Google Maps app when it's installed.
const directions = (p) => `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent([p.name, p.address || p.city].filter(Boolean).join(", "))}`;
const catBadge = (k) => `<span class="badge cat" style="--c:${categoryColour(k)}">${esc(categoryLabel(k))}</span>`;
const statusHtml = (p, cls = "") => {
  const s = hoursStatus(p.hours);
  return s ? `<span class="status-dot ${s.open ? "open" : "shut"} ${cls}">${esc(s.text)}</span>` : "";
};

// Coordinates: from the file when present (a GitHub Action fills them in), otherwise looked up
// on this device with OpenStreetMap's free geocoder and remembered.
const geoCache = () => { try { return JSON.parse(store.get(KEY_GEO) || "{}"); } catch { return {}; } };
const coords = (p) => (p.lat !== null && p.lng !== null ? [p.lat, p.lng] : geoCache()[p.address] || null);

async function nominatim(params) {
  const q = new URLSearchParams({ format: "jsonv2", limit: "1", ...params });
  const res = await fetch(`https://nominatim.openstreetmap.org/search?${q}`, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`Map lookup failed (${res.status})`);
  return (await res.json())[0] || null;
}

let geocoding = false;
async function geocodeMissing(onFound) {
  if (geocoding) return;
  geocoding = true;
  try {
    const cache = geoCache();
    const todo = state.places.filter((p) => p.address && !coords(p) && !(p.address in cache));
    for (const p of todo) {
      try {
        const hit = await nominatim({ q: p.address.replace(/\s*\([^)]*\)/g, "") });
        cache[p.address] = hit ? [Number(hit.lat), Number(hit.lon)] : null;
        store.set(KEY_GEO, JSON.stringify(cache));
        if (hit) onFound(p);
      } catch { break; /* offline or rate-limited: try again next time */ }
      await new Promise((r) => setTimeout(r, 1100)); // Nominatim allows 1 request a second
    }
  } finally { geocoding = false; }
}

// ---- Map: OpenStreetMap through Leaflet --------------------------------------------------
// draw([[place, [lat, lng]], …]) puts the pins on; fit([[lat, lng], …]) zooms to them.
const MAP_START = [45.52, -73.58];
const popupHtml = (p) => {
  const s = hoursStatus(p.hours);
  return `<a class="pop" href="#/view/${esc(p.path)}"><strong>${esc(p.name)}</strong></a><br>
    ${esc(categoryLabel(p.category))}${p.area ? ` · ${esc(p.area)}` : ""}${s ? `<br><span class="${s.open ? "open" : "shut"}">${esc(s.text)}</span>` : ""}`;
};

let leafletReady;
function loadLeaflet() {
  leafletReady ||= new Promise((resolve, reject) => {
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
    document.head.append(css);
    const js = document.createElement("script");
    js.src = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
    js.onload = () => resolve(window.L);
    js.onerror = () => { leafletReady = null; reject(new Error("The map needs a connection to load.")); };
    document.head.append(js);
  });
  return leafletReady;
}

async function osmMap(el) {
  const L = await loadLeaflet();
  const map = L.map(el, { zoomControl: false }).setView(MAP_START, 12);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);
  const layer = L.layerGroup().addTo(map);
  let me = null;
  map.on("zoomend", () => { el.dataset.zoom = map.getZoom(); });
  el.dataset.zoom = map.getZoom();

  // Double-tap to zoom in. Safari on iPhone doesn't pass double-taps on to Leaflet, so touch
  // double-taps are spotted here: two quick, still, one-finger taps close together, not on a pin,
  // name or popup. Leaflet's own double-click zoom stays for the mouse.
  map.doubleClickZoom.disable();
  let lastPointer = "mouse";
  map.on("dblclick", (e) => {
    if (lastPointer !== "mouse") return;
    map.setZoomAround(e.containerPoint, map.getZoom() + (e.originalEvent.shiftKey ? -1 : 1));
  });
  const touches = new Map();
  let multi = false, lastTap = null;
  el.addEventListener("pointerdown", (e) => {
    lastPointer = e.pointerType;
    if (e.pointerType !== "touch") return;
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY, t: e.timeStamp });
    if (touches.size > 1) multi = true; // a pinch, not a tap
  }, true);
  const lift = (e) => {
    if (e.pointerType !== "touch") return;
    const start = touches.get(e.pointerId);
    touches.delete(e.pointerId);
    const wasMulti = multi;
    if (!touches.size) multi = false;
    const tap = start && e.type === "pointerup" && !wasMulti
      && Math.hypot(e.clientX - start.x, e.clientY - start.y) < 10 && e.timeStamp - start.t < 300
      && !e.target.closest(".leaflet-interactive, .leaflet-popup, .leaflet-control, .locate-btn");
    if (!tap) { lastTap = null; return; }
    if (lastTap && e.timeStamp - lastTap.t < 350 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30) {
      lastTap = null;
      const box = el.getBoundingClientRect();
      map.setZoomAround(L.point(e.clientX - box.left, e.clientY - box.top), Math.min(map.getZoom() + 1, map.getMaxZoom()));
    } else lastTap = { x: e.clientX, y: e.clientY, t: e.timeStamp };
  };
  el.addEventListener("pointerup", lift, true);
  el.addEventListener("pointercancel", lift, true);
  let markers = []; // most important first: open now get first pick

  // Names beside the pins, at any zoom, never on top of each other or of another pin. Only pins
  // on screen are considered, and each name's size is worked out from its text, so this stays
  // quick with hundreds of places. Going down the list, each name goes to the right of its pin
  // if that space is free, else to the left, else it is left off until a closer zoom.
  // [Leaflet direction, offset, the label's box from the pin centre and the name's width]. The
  // sums include Leaflet's 6px tooltip margin; side ones are tried first, then above and below.
  const PIN = 11, GAP = 3, LINE = 15; // pin radius + border; space between; label line height
  const SIDES = [
    ["right", [9, 0], (x, y, w) => ({ l: x + 15, t: y - LINE / 2 })],
    ["left", [-9, 0], (x, y, w) => ({ l: x - 15 - w, t: y - LINE / 2 })],
    ["top", [0, -5], (x, y, w) => ({ l: x - w / 2, t: y - 11 - LINE })],
    ["bottom", [0, 5], (x, y, w) => ({ l: x - w / 2, t: y + 11 })],
  ];
  const ctx = document.createElement("canvas").getContext("2d");
  ctx.font = '700 12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  const widths = new Map();
  const textWidth = (s) => { if (!widths.has(s)) widths.set(s, Math.ceil(ctx.measureText(s).width) + 1); return widths.get(s); };
  const overlaps = (a, b) => a.l < b.r + GAP && a.r > b.l - GAP && a.t < b.b + GAP && a.b > b.t - GAP;
  const declutter = () => {
    const size = map.getSize();
    const seen = [];
    for (const m of markers) {
      const { x, y } = map.latLngToContainerPoint(m.getLatLng());
      if (x > -PIN && y > -PIN && x < size.x + PIN && y < size.y + PIN) seen.push([m, x, y]);
    }
    const pins = seen.map(([m, x, y]) => ({ m, l: x - PIN, r: x + PIN, t: y - PIN, b: y + PIN }));
    // Names also keep clear of the buttons and the credit on top of the map.
    const box = el.getBoundingClientRect();
    const kept = [...el.parentElement.querySelectorAll(".locate-btn, .leaflet-control-attribution")].map((c) => c.getBoundingClientRect())
      .filter((c) => c.width).map((c) => ({ l: c.left - box.left, r: c.right - box.left, t: c.top - box.top, b: c.bottom - box.top }));
    const show = new Map();
    for (const [m, x, y] of seen) {
      const w = textWidth(m.placeName);
      for (const side of SIDES) {
        const { l, t } = side[2](x, y, w);
        const r = { l, r: l + w, t, b: t + LINE };
        if (r.l < 0 || r.r > size.x || r.t < 0 || r.b > size.y) continue;
        if (kept.some((k) => overlaps(r, k)) || pins.some((k) => k.m !== m && overlaps(r, k))) continue;
        kept.push(r);
        show.set(m, side);
        break;
      }
    }
    for (const m of markers) {
      const side = show.get(m), tip = m.getTooltip();
      if (!side) { if (tip && m.isTooltipOpen()) m.closeTooltip(); continue; }
      if (!tip) { // first time: binding a permanent name opens it
        m.bindTooltip(esc(m.placeName), { permanent: true, direction: side[0], offset: side[1], className: "pin-label", interactive: true });
        continue;
      }
      const moved = tip.options.direction !== side[0];
      tip.options.direction = side[0];
      tip.options.offset = side[1];
      if (!m.isTooltipOpen()) m.openTooltip();
      else if (moved) tip.update();
    }
  };
  // After Leaflet has redrawn the pins for the new view, once per frame.
  let queued = false;
  const later = () => { if (!queued) { queued = true; requestAnimationFrame(() => { queued = false; declutter(); }); } };
  map.on("zoomend moveend resize", later);

  return {
    draw(items) {
      layer.clearLayers();
      const open = (p) => (hoursStatus(p.hours)?.open ? 0 : 1);
      markers = [...items].sort(([a], [b]) => open(a) - open(b)).map(([p, c]) => {
        const m = L.circleMarker(c, { radius: 9, color: "#fff", weight: 2, fillColor: categoryColour(p.category), fillOpacity: 1 })
          .bindPopup(popupHtml(p))
          .addTo(layer);
        m.placeName = p.name; // its name is added once declutter finds room for it
        return m;
      });
      declutter();
    },
    fit(pts) {
      // Not animated: a zoom animation still running would undo a "centre on me" made meanwhile.
      if (pts.length > 1) map.fitBounds(pts, { padding: [30, 30], maxZoom: 15, animate: false });
      else if (pts.length === 1) map.setView(pts[0], 15, { animate: false });
    },
    // "You are here": a pulsing blue dot (an HTML marker, so it can't be mistaken for a place pin
    // and always sits above them), with a faint circle for how accurate the fix is.
    me({ lat, lng, accuracy }) {
      if (!me) {
        const icon = L.divIcon({ className: "me-marker", html: '<span class="me-pulse"></span><span class="me-dot"></span>', iconSize: [22, 22] });
        me = L.layerGroup([
          L.circle([lat, lng], { radius: accuracy, color: "#1a73e8", weight: 1, opacity: 0.4, fillOpacity: 0.1, interactive: false }),
          L.marker([lat, lng], { icon, interactive: false, keyboard: false, zIndexOffset: 1000, title: "You are here" }),
        ]).addTo(map);
      } else {
        const [ring, dot] = me.getLayers();
        ring.setLatLng([lat, lng]).setRadius(accuracy);
        dot.setLatLng([lat, lng]);
      }
    },
    // Where the map is, so coming back to it (from a place page, or the list) lands in the same spot.
    view: () => ({ center: map.getCenter(), zoom: map.getZoom() }),
    restore({ center, zoom }) { map.setView(center, zoom, { animate: false }); },
    onMove(fn) { map.on("moveend", fn); },
    centre({ lat, lng }) {
      const go = () => map.setView([lat, lng], Math.max(map.getZoom(), 15));
      // Leaflet ends a zoom animation by jumping to its own target, so wait for any (e.g. pinch) to finish.
      if (map._animatingZoom) map.once("zoomend", go); else go();
    },
  };
}

// The map's last position this visit, per city (not saved), so Back from a place lands where you were.
const lastMapView = {};

// ---- My location: watched only while the map is on screen ----------------------------------
let watchId = null;
let myPos = null;
// The list asks for a fix itself: "pending" while waiting, "failed" if none came (falls back to A–Z).
let listFix = null;
function stopLocating() {
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
}
function startLocating(onFix, onError) {
  if (watchId !== null) return;
  if (!("geolocation" in navigator)) { onError({ code: 0 }); return; }
  watchId = navigator.geolocation.watchPosition(
    (pos) => { gotFix(pos); onFix(myPos); },
    (err) => { stopLocating(); onError(err); },
    { enableHighAccuracy: true, maximumAge: 15000, timeout: 20000 },
  );
}


function gotFix(pos) {
  myPos = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy };
  autoCity();
}

// On the first location fix of a visit, switch to the city you're in (the one whose places are
// nearest, within 150 km), even from "All cities". A city picked by hand this visit is kept.
let cityAutoPicked = false;
function autoCity() {
  const all = cities();
  if (cityAutoPicked || !myPos || !all.length) return;
  cityAutoPicked = true;
  let best = null, bestKm = Infinity;
  for (const c of all) {
    const pts = state.places.filter((p) => p.city === c).map(coords).filter(Boolean);
    if (!pts.length) continue;
    const mid = [pts.reduce((a, [lat]) => a + lat, 0) / pts.length, pts.reduce((a, [, lng]) => a + lng, 0) / pts.length];
    const km = distanceKm([myPos.lat, myPos.lng], mid);
    if (km < bestKm) { best = c; bestKm = km; }
  }
  if (best && bestKm < 150 && best !== currentCity()) {
    store.set(KEY_CITY, best);
    toast(`Showing ${best}`);
    render();
  }
}

// One-off fix for sorting the list; the map keeps its own watch running while it's open.
function locateOnce(onFix, onError) {
  if (!("geolocation" in navigator)) { onError({ code: 0 }); return; }
  navigator.geolocation.getCurrentPosition(
    (pos) => { gotFix(pos); onFix(myPos); },
    onError,
    { enableHighAccuracy: false, maximumAge: 60000, timeout: 15000 },
  );
}

// Straight-line distance in km.
function distanceKm([lat1, lng1], [lat2, lng2]) {
  const rad = Math.PI / 180;
  const a = Math.sin((lat2 - lat1) * rad / 2) ** 2
    + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin((lng2 - lng1) * rad / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(a));
}
const fmtDistance = (km) => (km < 1 ? `${Math.max(10, Math.round(km * 100) * 10)} m` : `${km < 10 ? km.toFixed(1) : Math.round(km)} km`);

function locationDenied() {
  store.del(KEY_LOCATE);
  toast(isIOS() ? "Location is off for this app. Turn it on in Settings → Privacy & Security → Location Services → Safari Websites."
    : "Location permission was denied. Allow it in your browser's site settings.");
}

function filteredPlaces() {
  const city = currentCity();
  const q = state.placeQuery.trim().toLowerCase();
  return state.places.filter((p) => {
    if (city && p.city !== city) return false;
    if (state.placeCats.size && !state.placeCats.has(p.category)) return false;
    if (state.placeOpenNow && !hoursStatus(p.hours)?.open) return false;
    if (state.placeReservable && !/^https?:\/\//.test(p.reserve)) return false;
    if (!q) return true;
    const hay = [p.name, p.area, p.address, categoryLabel(p.category), p.notes].join(" ").toLowerCase();
    return q.split(/\s+/).every((w) => hay.includes(w));
  });
}

function placesView() {
  const all = cities();
  const city = currentCity();
  const inCity = state.places.filter((p) => !city || p.city === city);
  const cats = CATEGORIES.map(([k]) => k).filter((k) => inCity.some((p) => p.category === k))
    .concat([...new Set(inCity.map((p) => p.category))].filter((k) => categoryOrder(k) === 99).sort());
  for (const k of state.placeCats) if (!cats.includes(k)) state.placeCats.delete(k);
  const map = state.placesMode === "map";
  // On the map, the page fits the screen and doesn't scroll: the map takes whatever height is left.
  document.body.classList.toggle("map-mode", map);
  const showHint = isIOS() && !isStandalone() && !store.get(KEY_HINT);

  app.innerHTML = `
    ${topBar("Places")}
    ${showHint ? `<div class="hint"><span>Install: tap <strong>Share</strong> → <strong>Add to Home Screen</strong></span>
      <button id="hint-close" aria-label="Dismiss">✕</button></div>` : ""}
    <div class="place-tools">
      ${all.length > 1 ? `<select id="city" aria-label="City">
        ${all.map((c) => `<option ${c === city ? "selected" : ""}>${esc(c)}</option>`).join("")}
        <option value="" ${city === "" ? "selected" : ""}>All cities</option>
      </select>` : all.length ? `<span class="city-name">${esc(all[0])}</span>` : ""}
      <div class="segmented small mode" role="group" aria-label="View">
        <button data-mode="list" class="${map ? "" : "on"}" aria-pressed="${!map}">List</button>
        <button data-mode="map" class="${map ? "on" : ""}" aria-pressed="${map}">Map</button>
      </div>
    </div>
    <input id="search" type="search" placeholder="Search names, neighbourhoods, notes"
      value="${esc(state.placeQuery)}" autocomplete="off" autocorrect="off">
    <div class="chips">
      <button class="chip" data-cat="">ALL</button>
      ${cats.map((k) => `<button class="chip" data-cat="${esc(k)}">${esc(categoryLabel(k))}</button>`).join("")}
    </div>
    <div class="sort-row">
      <button class="chip open-chip ${state.placeOpenNow ? "on" : ""}" id="open-now" aria-pressed="${state.placeOpenNow}">Open now</button>
      <button class="chip res-chip ${state.placeReservable ? "on" : ""}" id="reservable" aria-pressed="${state.placeReservable}">${ICON.calendar}Reserve</button>
      <span id="sort-status" class="sort-status"></span>
      ${map ? "" : `<div class="segmented small" role="group" aria-label="Sort">
        <button data-sort="near">Nearest</button>
        <button data-sort="az">A–Z</button>
      </div>`}
    </div>
    <div id="results"></div>
    ${token() ? `<a class="fab" href="#/new/place" aria-label="New place">${ICON.plus}</a>` : ""}
  `;

  const away = (p) => { const c = myPos && coords(p); return c ? distanceKm([myPos.lat, myPos.lng], c) : null; };
  const card = (p) => `
    <li><a class="card" href="#/view/${esc(p.path)}">
      <span class="card-title">${esc(p.name)}${away(p) !== null ? `<span class="card-dist">${fmtDistance(away(p))}</span>` : ""}</span>
      <span class="card-meta">${catBadge(p.category)}${p.area ? `<span>${esc(p.area)}</span>` : ""}${!city && p.city ? `<span>${esc(p.city)}</span>` : ""}</span>
      ${statusHtml(p, "card-status")}
    </a></li>`;

  let mapView = null;

  const show = ({ refit = true } = {}) => {
    const matches = filteredPlaces();
    app.querySelectorAll("[data-cat]").forEach((c) => {
      const on = c.dataset.cat ? state.placeCats.has(c.dataset.cat) : !state.placeCats.size;
      c.classList.toggle("on", on);
      c.setAttribute("aria-pressed", String(on));
    });
    if (map) {
      if (!mapView || !$("#map-note")) return; // still loading, or it couldn't load
      const missing = matches.filter((p) => !coords(p)).length;
      $("#map-note").textContent = missing ? `Finding ${missing} more on the map…` : "";
      const items = matches.map((p) => [p, coords(p)]).filter(([, c]) => c);
      mapView.draw(items);
      if (refit) mapView.fit(items.map(([, c]) => c));
      return;
    }
    const loading = !state.lastSync && !Object.keys(state.files).length;
    if (!matches.length) {
      $("#results").innerHTML = `<p class="empty">${state.places.length ? "Nothing matches."
        : loading ? "Loading…" : "No places yet. Tap + to add one."}</p>`;
      return;
    }
    // One combined list: nearest first (the default, once we know where you are), or A–Z
    // (state.places is already sorted by name). Each card's badge shows its category.
    const sortAz = store.get(KEY_SORT) === "az";
    const sorted = !sortAz && myPos
      ? [...matches].sort((a, b) => (away(a) ?? Infinity) - (away(b) ?? Infinity))
      : matches;
    $("#results").innerHTML = `<ul class="cards">${sorted.map(card).join("")}</ul>`;
  };
  // The sort toggle and its status line (list only) sit outside #results, next to Open now.
  const showSort = () => {
    if (map) return;
    const sortAz = store.get(KEY_SORT) === "az";
    app.querySelectorAll("[data-sort]").forEach((b) => {
      const on = (b.dataset.sort === "az") === sortAz;
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", String(on));
    });
    $("#sort-status").textContent = sortAz || myPos ? "" : listFix === "pending" ? "Finding you…" : "Location off, so A–Z";
  };
  const showAll = (opts) => { show(opts); showSort(); };
  app.querySelectorAll("[data-sort]").forEach((b) => {
    b.onclick = () => {
      if (b.dataset.sort === "az") { store.set(KEY_SORT, "az"); showAll(); return; }
      store.del(KEY_SORT);
      if (myPos) showAll(); else findMe(true);
    };
  });
  const results = $("#results");
  // A fix for nearest-first. Asked for automatically, it fails quietly to A–Z; after a tap on
  // Nearest, a failure says why.
  const findMe = (tapped) => {
    listFix = "pending";
    showAll();
    locateOnce(() => {
      listFix = null;
      store.set(KEY_LOCATE, "1"); // the map shows the dot too from now on
      if (results.isConnected) showAll();
    }, (err) => {
      listFix = "failed";
      if (err.code === 1) { if (tapped) locationDenied(); else store.del(KEY_LOCATE); }
      else if (tapped) toast("Couldn't find your location. Try again outside or with Wi-Fi on.");
      if (results.isConnected) showAll();
    });
  };

  if (map) {
    $("#results").innerHTML = `<div class="map-wrap"><div id="map" class="map"></div>
      <button id="locate" class="locate-btn" aria-label="Show my location" aria-pressed="false">${ICON.locate}</button></div>
      <p id="map-note" class="map-note"></p>`;
    osmMap($("#map")).then((view) => {
      if (!document.getElementById("map")) return;
      mapView = view;
      const key = city || "*";
      if (lastMapView[key]) { view.restore(lastMapView[key]); show({ refit: false }); } else show();
      view.onMove(() => { lastMapView[key] = view.view(); });
      // My location: the button centres on you; once turned on, the dot shows whenever the map opens.
      let centreNext = false;
      const btn = $("#locate");
      const setOn = (on) => { btn.classList.toggle("on", on); btn.setAttribute("aria-pressed", String(on)); };
      const onFix = (pos) => {
        if (!document.getElementById("map")) return;
        view.me(pos);
        if (centreNext) { view.centre(pos); centreNext = false; }
      };
      const onError = (err) => {
        setOn(false);
        btn.classList.remove("busy");
        if (err.code === 1) locationDenied();
        else toast("Couldn't find your location. Try again outside or with Wi-Fi on.");
      };
      const locate = () => {
        setOn(true);
        if (myPos) { view.me(myPos); view.centre(myPos); } else { centreNext = true; btn.classList.add("busy"); }
        startLocating((pos) => { btn.classList.remove("busy"); onFix(pos); }, onError);
      };
      btn.onclick = () => { store.set(KEY_LOCATE, "1"); locate(); };
      if (store.get(KEY_LOCATE)) { // show the dot without moving the map
        setOn(true);
        if (myPos) view.me(myPos);
        startLocating(onFix, onError);
      }
      // Pins appear as they're found, without moving the map under your finger. If none were
      // known yet (a new city), zoom to them once the lookups finish.
      const hadPins = filteredPlaces().some(coords);
      geocodeMissing(() => { if (document.getElementById("map")) show({ refit: false }); })
        .then(() => { if (document.getElementById("map")) show({ refit: !hadPins }); });
    }).catch((err) => { $("#results").innerHTML = `<p class="empty">${esc(err.message)}</p>`; });
  } else {
    showAll();
    // Nearest first by default: refresh the fix if location is on, or ask once per visit.
    if (store.get(KEY_SORT) !== "az" && (store.get(KEY_LOCATE) || listFix === null)) findMe(false);
  }

  $("#sync").onclick = () => sync();
  $("#copy-link").onclick = copyAppLink;
  updateSyncButton();
  $("#hint-close")?.addEventListener("click", () => { store.set(KEY_HINT, "1"); render(); });
  $("#city")?.addEventListener("change", (e) => { cityAutoPicked = true; store.set(KEY_CITY, e.target.value); render(); });
  app.querySelectorAll("[data-mode]").forEach((b) => {
    b.onclick = () => { state.placesMode = b.dataset.mode; render(); };
  });
  $("#search").oninput = (e) => { state.placeQuery = e.target.value; show(); };
  // Filters that sit on top of the categories: Open now, and places you can book online.
  const toggle = (id, key) => {
    $(id).onclick = (e) => {
      state[key] = !state[key];
      e.currentTarget.classList.toggle("on", state[key]);
      e.currentTarget.setAttribute("aria-pressed", String(state[key]));
      show();
    };
  };
  toggle("#open-now", "placeOpenNow");
  toggle("#reservable", "placeReservable");
  app.querySelectorAll("[data-cat]").forEach((c) => {
    // Categories toggle, so several can be on at once; All clears them.
    c.onclick = () => {
      const k = c.dataset.cat;
      if (!k) state.placeCats.clear();
      else if (state.placeCats.has(k)) state.placeCats.delete(k);
      else state.placeCats.add(k);
      show();
    };
  });
}

function placeView(p) {
  const today = todayLine(p.hours);
  const site = p.website && /^https?:\/\//.test(p.website) ? p.website : "";
  const reserve = p.reserve && /^https?:\/\//.test(p.reserve) ? p.reserve : "";
  app.innerHTML = `
    ${backBar("#/", "Places", token() ? `<a class="text-btn" href="#/edit/${esc(p.path)}">Edit</a>` : "")}
    <article class="place">
      <h1>${esc(p.name)}</h1>
      <p class="meta">${catBadge(p.category)}${p.area ? `<span>${esc(p.area)}</span>` : ""}${p.city ? `<span>${esc(p.city)}</span>` : ""}</p>
      ${statusHtml(p, "big")}
      <div class="actions">
        <a href="${esc(directions(p))}" target="_blank" rel="noopener">${ICON.pin}<span>Directions</span></a>
        <a href="${esc(googleMaps(p))}" target="_blank" rel="noopener"><span class="g">G</span><span>Google Maps</span></a>
        ${reserve ? `<a href="${esc(reserve)}" target="_blank" rel="noopener">${ICON.calendar}<span>Reserve</span></a>` : ""}
        ${p.phone ? `<a href="tel:${esc(p.phone.replace(/[^\d+]/g, ""))}">${ICON.phone}<span>Call</span></a>` : ""}
        ${site ? `<a href="${esc(site)}" target="_blank" rel="noopener">${ICON.external}<span>Website</span></a>` : ""}
      </div>
      <section>
        <h2>Address</h2>
        <p class="address">${p.address ? esc(p.address) : "Not added yet."}${p.phone ? `<br><a href="tel:${esc(p.phone.replace(/[^\d+]/g, ""))}">${esc(p.phone)}</a>` : ""}</p>
      </section>
      <section>
        <h2>Hours</h2>
        ${p.hours.length ? `<ul class="hours">${p.hours.map((h, i) => `<li class="${i === today ? "today" : ""}">${esc(h)}</li>`).join("")}</ul>`
          : `<p class="muted">No hours saved. <a href="${esc(googleMaps(p))}" target="_blank" rel="noopener">Check Google Maps</a>.</p>`}
        ${p.hours.length ? `<p class="fine">${p.checked ? `Checked ${esc(p.checked)}. ` : ""}Google Maps has the current hours, including holidays.</p>` : ""}
      </section>
      ${p.notes ? `<section class="notes"><h2>Notes</h2>${block(p.notes)}</section>` : ""}
    </article>
  `;
}

const HOURS_HINT = "one line per day or range · e.g. Mon–Fri: 11:30–22:00 · Sat: 10:00–14:00, 17:00–23:00 · Sun: Closed · Daily: Open 24 hours";

function placeEditor(p) {
  const isNew = !p;
  const city = currentCity();
  p ||= { name: "", city, category: state.placeCats.size === 1 ? [...state.placeCats][0] : "nice", area: "", address: "", phone: "", website: "", reserve: "", lat: null, lng: null, checked: "", hours: [], notes: "" };
  const cats = CATEGORIES.some(([k]) => k === p.category) ? CATEGORIES : [...CATEGORIES, [p.category, p.category]];
  app.innerHTML = `
    ${backBar(isNew ? "#/" : `#/view/${esc(p.path)}`, "Cancel", `<button class="text-btn strong" id="save" ${token() ? "" : "disabled"}>Save</button>`)}
    <form class="editor" onsubmit="return false">
      <h1>${isNew ? "New place" : "Edit place"}</h1>
      ${tokenBanner()}
      ${field("name", "Name", p.name, 'required autocapitalize="words"')}
      <label class="field"><span>Category</span><select id="category">
        ${cats.map(([k, label]) => `<option value="${esc(k)}" ${k === p.category ? "selected" : ""}>${esc(label)}</option>`).join("")}
      </select></label>
      <div class="row">
        ${field("city", "City", p.city, 'autocapitalize="words" list="city-list"')}
        ${field("area", "Neighbourhood", p.area, 'autocapitalize="words"')}
      </div>
      <datalist id="city-list">${cities().map((c) => `<option value="${esc(c)}">`).join("")}</datalist>
      ${field("address", "Address", p.address)}
      <div class="buttons lookup"><button type="button" id="lookup">Look up on OpenStreetMap</button></div>
      <p id="lookup-status" class="status"></p>
      <div class="row">
        ${field("phone", "Phone", p.phone, 'type="tel"')}
        ${field("website", "Website", p.website, 'type="url" autocapitalize="none"')}
        ${field("reserve", "Reservation link", p.reserve, 'type="url" autocapitalize="none"')}
      </div>
      ${area("hours", "Hours", p.hours.join("\n"), HOURS_HINT, 7)}
      ${area("notes", "Notes", p.notes, "what to order, who it's good for…", 4)}
      <div class="row">
        ${field("lat", "Latitude <small>for the map</small>", String(p.lat ?? ""), 'inputmode="decimal"')}
        ${field("lng", "Longitude", String(p.lng ?? ""), 'inputmode="decimal"')}
      </div>
      ${isNew ? "" : `<button type="button" id="delete" class="danger" ${token() ? "" : "disabled"}>Delete place</button>`}
    </form>
  `;

  // Fill blanks from OpenStreetMap: coordinates always, plus address, phone, website and hours when it has them.
  $("#lookup").onclick = () => withBusy($("#lookup"), async () => {
    const status = $("#lookup-status");
    const name = $("#name").value.trim();
    const where = $("#city").value.trim();
    const addr = $("#address").value.trim();
    if (!name && !addr) { status.textContent = "Enter a name or an address first."; return; }
    status.textContent = "Searching…";
    let hit = name ? await nominatim({ q: [name, where].filter(Boolean).join(", "), extratags: "1", addressdetails: "1" }) : null;
    if (!hit && addr) hit = await nominatim({ q: addr, extratags: "1", addressdetails: "1" });
    if (!hit) { status.textContent = "Not found. Check the spelling, or type the address and try again."; return; }
    const filled = [];
    const set = (id, value, label) => { if (value && !$(id).value.trim()) { $(id).value = value; filled.push(label); } };
    const a = hit.address || {};
    const street = [a.house_number, a.road].filter(Boolean).join(" ");
    set("#address", [street, a.city || a.town || a.village, a.state, a.postcode].filter(Boolean).join(", "), "address");
    set("#area", a.neighbourhood || a.suburb || "", "neighbourhood");
    set("#phone", hit.extratags?.phone || hit.extratags?.["contact:phone"], "phone");
    set("#website", hit.extratags?.website || hit.extratags?.["contact:website"], "website");
    set("#hours", osmHoursToLines(hit.extratags?.opening_hours).join("\n"), "hours");
    $("#lat").value = Number(hit.lat).toFixed(6);
    $("#lng").value = Number(hit.lon).toFixed(6);
    filled.push("map location");
    status.textContent = `Found: ${hit.display_name.split(",").slice(0, 3).join(",")}. Filled in ${filled.join(", ")}. Check that it's the right place.`;
  });

  $("#save").onclick = () => withBusy($("#save"), async () => {
    const name = $("#name").value.trim();
    if (!name) { toast("Give it a name."); $("#name").focus(); return; }
    const num = (id) => { const v = $(id).value.trim(); return v && Number.isFinite(Number(v)) ? Number(v) : null; };
    const next = {
      name,
      city: $("#city").value.trim(),
      category: $("#category").value,
      area: $("#area").value.trim(),
      address: $("#address").value.trim(),
      phone: $("#phone").value.trim(),
      website: $("#website").value.trim(),
      reserve: $("#reserve").value.trim(),
      lat: num("#lat"),
      lng: num("#lng"),
      hours: lines($("#hours").value),
      notes: $("#notes").value.trim(),
    };
    // A new address with the old coordinates would put the pin in the wrong spot; clearing them
    // lets the map look the address up again.
    if (!isNew && next.address !== p.address && next.lat === p.lat && next.lng === p.lng) next.lat = next.lng = null;
    const changedHours = isNew || next.hours.join("\n") !== p.hours.join("\n") || next.address !== p.address;
    next.checked = changedHours ? new Date().toISOString().slice(0, 10) : p.checked;
    const folder = placePath(next);
    const path = isNew || !p.path.startsWith(`${folder}/`) ? uniquePath(folder, name) : p.path;
    await saveFile(path, serializePlace(next), `${isNew ? "Add" : "Update"} place: ${name}`);
    if (!isNew && path !== p.path) await deleteFile(p.path, `Move place: ${name}`); // city changed
    if (next.city) store.set(KEY_CITY, next.city);
    toast("Saved");
    location.hash = `#/view/${path}`;
  });

  $("#delete")?.addEventListener("click", () => {
    if (!confirm(`Delete "${p.name}"? It stays in the repo's history on GitHub.`)) return;
    withBusy($("#delete"), async () => {
      await deleteFile(p.path, `Delete place: ${p.name}`);
      toast("Deleted");
      location.hash = "#/";
    });
  });
}

// ---- Router ---------------------------------------------------------------
// Feel like an app: no pinch-zooming the page. iPhone Safari ignores user-scalable=no, so stop its
// pinch gestures here too. The map does its own zooming with touch events, which this leaves alone.
for (const type of ["gesturestart", "gesturechange"]) {
  document.addEventListener(type, (e) => { if (!e.target.closest?.(".leaflet-container")) e.preventDefault(); }, { passive: false });
}
document.addEventListener("touchmove", (e) => {
  if (e.touches.length > 1 && !e.target.closest?.(".leaflet-container")) e.preventDefault();
}, { passive: false });

let lastRoute = "";
let listScroll = 0; // the list's scroll position, kept while you look at a place
if ("scrollRestoration" in history) history.scrollRestoration = "manual"; // the app restores it itself
function render() {
  stopLocating(); // the map view starts it again if it's still showing
  document.body.classList.remove("map-mode"); // the map view sets it again
  const route = decodeURIComponent(location.hash.slice(1) || "/");
  // A new page starts at the top, except the list: coming back to it lands where you left it.
  let scrollTo = null;
  if (route !== lastRoute) {
    if (lastRoute === "/" && state.placesMode === "list") listScroll = window.scrollY;
    scrollTo = route === "/" && state.placesMode === "list" ? listScroll : 0;
    lastRoute = route;
  }
  showRoute(route);
  if (scrollTo !== null) window.scrollTo(0, scrollTo);
}

function showRoute(route) {
  let m;
  if (route === "/" || route === "") return placesView();
  if (route === "/settings") return settingsView();
  if (route === "/new/place") return placeEditor(null);
  if ((m = route.match(/^\/(view|edit)\/(places\/.+)$/))) {
    const place = state.places.find((p) => p.path === m[2]);
    if (!place) return state.lastSync ? notFound() : (app.innerHTML = '<p class="empty">Loading…</p>');
    return m[1] === "view" ? placeView(place) : placeEditor(place);
  }
  return notFound();
}

// Background syncs must not redraw over a form someone is typing in.
const editing = () => /^#\/(edit|new)\//.test(location.hash) || location.hash === "#/settings";
function safeRender() { if (!editing()) render(); }

window.addEventListener("hashchange", render);
rebuild();
render();
sync({ quiet: true });
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && !editing()) sync({ quiet: true });
});

// ---- App updates ----------------------------------------------------------
// Check for a new version whenever the app comes to the foreground; when one takes over,
// reload so the new code runs (unless a form is open, in which case the next open picks it up).
if ("serviceWorker" in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register("sw.js", { updateViaCache: "none" })
    .then((reg) => {
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") reg.update().catch(() => {});
      });
    })
    .catch(() => { /* offline support is optional */ });
  let reloaded = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController || reloaded || editing()) return;
    reloaded = true;
    location.reload();
  });
}
