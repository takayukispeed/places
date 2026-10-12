// Run: node tests/format.test.mjs
import { readFileSync, readdirSync, existsSync } from "node:fs";
import assert from "node:assert/strict";
import { inline, slugify } from "../app/format.js";
import { parsePlace, serializePlace, parseHours, hoursStatus, todayLine, osmHoursToLines } from "../app/places.js";

// Every place in the repo, and every suggestion waiting for review, must survive a parse →
// serialize round trip unchanged, with valid fields.
for (const root of ["places", "suggestions"].filter((d) => existsSync(d))) for (const city of readdirSync(root)) {
  for (const f of readdirSync(`${root}/${city}`).filter((f) => f.endsWith(".md"))) {
    const text = readFileSync(`${root}/${city}/${f}`, "utf8");
    const p = parsePlace(text);
    assert.equal(serializePlace(p), text, `round trip: ${root}/${city}/${f}`);
    assert.ok(["cheap", "sitdown", "nice", "cafe", "bakery", "icecream", "bar", "cocktail"].includes(p.category), `category: ${f}`);
    assert.ok(p.address, `address: ${f}`);
    if (p.hours.length) assert.ok(parseHours(p.hours), `hours parse: ${f}`);
  }
}

assert.equal(inline("**a** <b>"), "<strong>a</strong> &lt;b&gt;");
assert.equal(inline("[x](../montreal/a-b.md)"), "x");
assert.equal(inline("[x](places/montreal/a-b.md)"), '<a href="#/view/places/montreal/a-b.md">x</a>');
assert.ok(!inline("[x](javascript:alert)").includes("href"));
assert.equal(slugify("Café Noble"), "cafe-noble");
assert.equal(slugify("L'Express"), "l-express");

// Hours
const bij = ["Mon: Closed", "Tue–Sat: 17:00–03:00", "Sun: Closed"];
const at = (s) => new Date(s); // 2026-10-12 is a Monday
assert.deepEqual(hoursStatus(bij, at("2026-10-12T20:00")), { open: false, text: "Closed · opens tomorrow 17:00" });
assert.deepEqual(hoursStatus(bij, at("2026-10-13T18:30")), { open: true, text: "Open until 3:00" });
assert.deepEqual(hoursStatus(bij, at("2026-10-14T02:00")), { open: true, text: "Open until 3:00" }, "past midnight");
assert.deepEqual(hoursStatus(bij, at("2026-10-18T02:30")), { open: true, text: "Open until 3:00" }, "Saturday night into Sunday");
assert.deepEqual(hoursStatus(bij, at("2026-10-18T12:00")), { open: false, text: "Closed · opens Tue 17:00" });
assert.deepEqual(hoursStatus(["Mon-Fri: 11:30-14:00, 17:00-22:00"], at("2026-10-12T15:00")), { open: false, text: "Closed · opens 17:00" });
assert.deepEqual(hoursStatus(["Daily: 8h–15h"], at("2026-10-12T09:00")), { open: true, text: "Open until 15:00" });
assert.deepEqual(hoursStatus(["Daily: 12:00–00:00"], at("2026-10-12T23:30")), { open: true, text: "Open until midnight" });
assert.equal(hoursStatus(["Mon: 9:00–17:00"], at("2026-10-13T10:00")), null, "today unknown");
assert.equal(hoursStatus([], at("2026-10-13T10:00")), null);
assert.equal(todayLine(bij, at("2026-10-14T12:00")), 1);
assert.deepEqual(hoursStatus(["Daily: Open 24 hours"], at("2026-10-12T03:00")), { open: true, text: "Open 24 hours" });
assert.deepEqual(hoursStatus(["Mon–Fri: 24h", "Sat–Sun: 8:00–20:00"], at("2026-10-18T07:00")), { open: false, text: "Closed · opens 8:00" });
assert.deepEqual(hoursStatus(["Mon–Fri: 24h", "Sat–Sun: 8:00–20:00"], at("2026-10-16T23:30")), { open: true, text: "Open 24 hours" });
assert.deepEqual(osmHoursToLines("Mo-Fr 11:00-22:00; Sa,Su 10:00-23:00; Tu off"), ["Mon–Fri: 11:00–22:00", "Sat, Sun: 10:00–23:00", "Tue: Closed"]);
assert.deepEqual(osmHoursToLines("24/7"), []);
console.log("format and hours tests passed");
