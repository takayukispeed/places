// The suggestion Worker (worker/suggest.js), with GitHub mocked. Run: node tests/worker.test.mjs
import assert from "node:assert/strict";
import worker from "../worker/suggest.js";

const APP = "https://takayukispeed.github.io";
const puts = [];
globalThis.fetch = async (url, init) => { puts.push({ url, init }); return new Response("{}", { status: 201 }); };
const env = { GITHUB_TOKEN: "test-token" };
const post = (body, { origin = APP, ip = "1.1.1.1" } = {}) => worker.fetch(new Request("https://suggest.example/", {
  method: "POST", headers: { Origin: origin, "Content-Type": "application/json", "CF-Connecting-IP": ip }, body: JSON.stringify(body),
}), env);

// Preflight and other origins
const pre = await worker.fetch(new Request("https://suggest.example/", { method: "OPTIONS", headers: { Origin: APP } }), env);
assert.equal(pre.headers.get("Access-Control-Allow-Origin"), APP);
assert.equal((await post({ name: "X", city: "Toronto" }, { origin: "https://evil.example" })).status, 403);
assert.equal((await worker.fetch(new Request("https://suggest.example/"), env)).status, 404);

// Required fields; the hidden field quietly drops bots
assert.equal((await post({ name: "", city: "Toronto" })).status, 400);
assert.equal((await post({ name: "Spam", city: "Toronto", website: "http://spam" })).status, 200);
assert.equal(puts.length, 0, "nothing saved for bots or bad requests");

// A real one: saved to inbox/ with the GitHub token, cleaned up and capped in length
const ok = await post({ name: "  Café\u0000 Noble ", city: "Toronto", by: "Sam", note: "x".repeat(900) });
assert.equal(ok.status, 200);
assert.equal(puts.length, 1);
const { url, init } = puts[0];
assert.match(url, /^https:\/\/api\.github\.com\/repos\/takayukispeed\/places\/contents\/inbox\/\d{4}-\d\d-\d\dT[\d-]+Z-cafe-noble\.json$/);
assert.equal(init.method, "PUT");
assert.equal(init.headers.Authorization, "Bearer test-token");
const sent = JSON.parse(init.body);
assert.equal(sent.message, "Suggestion: Café Noble (Toronto)");
const saved = JSON.parse(Buffer.from(sent.content, "base64").toString("utf8"));
assert.equal(saved.name, "Café Noble");
assert.equal(saved.by, "Sam");
assert.equal(saved.note.length, 500);

// At most 5 an hour from one visitor
for (let i = 0; i < 4; i++) assert.equal((await post({ name: `P${i}`, city: "Toronto" }, { ip: "2.2.2.2" })).status, 200);
assert.equal((await post({ name: "P5", city: "Toronto" }, { ip: "2.2.2.2" })).status, 200);
assert.equal((await post({ name: "P6", city: "Toronto" }, { ip: "2.2.2.2" })).status, 429);

// GitHub refusing is reported, not hidden
globalThis.fetch = async () => new Response("{}", { status: 401 });
assert.equal((await post({ name: "Y", city: "Toronto" }, { ip: "3.3.3.3" })).status, 502);
console.log("worker tests passed");
