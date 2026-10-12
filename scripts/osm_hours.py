#!/usr/bin/env python3
"""Report what OpenStreetMap has for each place: opening hours, phone and website.

Read-only: prints a report and changes nothing, so hours can be compared with the files
by hand. Runs on GitHub from the Actions tab ("Check hours against OpenStreetMap").

Usage: python3 scripts/osm_hours.py
"""
import json
import re
import time
import unicodedata
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
AGENT = "places-app/1.0 (personal restaurant list; github.com)"
SERVERS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"]


def field(text, key):
    m = re.search(rf"^{key}:[ \t]*(.*)$", text, re.M)
    return m.group(1).strip() if m else ""


def words(s):
    s = unicodedata.normalize("NFKD", s.lower()).encode("ascii", "ignore").decode()
    stop = {"bar", "cafe", "restaurant", "resto", "le", "la", "les", "de", "du", "the", "and", "et", "boulangerie", "brasserie"}
    return {w for w in re.findall(r"[a-z0-9]+", s) if w not in stop} or set(re.findall(r"[a-z0-9]+", s))


def overpass(query):
    body = urllib.parse.urlencode({"data": query}).encode()
    for server in SERVERS:
        try:
            req = urllib.request.Request(server, data=body, headers={"User-Agent": AGENT})
            with urllib.request.urlopen(req, timeout=60) as res:
                return json.load(res)["elements"]
        except Exception as err:  # try the next server
            print(f"  ({server}: {err})")
    return []


def main():
    for path in sorted(ROOT.glob("places/*/*.md")):
        text = path.read_text(encoding="utf-8")
        name, lat, lng = field(text, "name"), field(text, "lat"), field(text, "lng")
        if not (lat and lng):
            print(f"{path.stem}: no coordinates yet")
            continue
        found = overpass(f'[out:json][timeout:30];nwr(around:120,{lat},{lng})["name"];out tags;')
        want = words(name)
        best = max(found, key=lambda e: len(want & words(e["tags"].get("name", ""))), default=None)
        if not best or not want & words(best["tags"].get("name", "")):
            print(f"{path.stem}: not in OpenStreetMap near the pin")
        else:
            t = best["tags"]
            print(f"{path.stem}: {t.get('name')!r} | hours: {t.get('opening_hours', '-')} | "
                  f"phone: {t.get('phone') or t.get('contact:phone') or '-'} | "
                  f"website: {t.get('website') or t.get('contact:website') or '-'} | "
                  f"checked: {t.get('check_date:opening_hours') or t.get('check_date') or '-'}")
        time.sleep(1.5)


if __name__ == "__main__":
    main()
