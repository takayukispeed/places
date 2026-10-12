#!/usr/bin/env python3
"""Fill in missing lat/lng in places/<city>/*.md from each address, using OpenStreetMap's
Nominatim geocoder (free, 1 request a second). Runs on GitHub after places change.

Usage: python3 scripts/geocode_places.py
"""
import json
import re
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
AGENT = "places-app/1.0 (personal restaurant list; github.com)"


def field(text, key):
    m = re.search(rf"^{key}:[ \t]*(.*)$", text, re.M)
    return m.group(1).strip() if m else ""


def coord(x):
    """6 decimals (about 10 cm) without trailing zeros, as the app writes them."""
    return f"{x:.6f}".rstrip("0").rstrip(".")


def geocode(query):
    url = "https://nominatim.openstreetmap.org/search?" + urllib.parse.urlencode(
        {"q": query, "format": "jsonv2", "limit": 1})
    req = urllib.request.Request(url, headers={"User-Agent": AGENT})
    with urllib.request.urlopen(req, timeout=20) as res:
        hits = json.load(res)
    return (float(hits[0]["lat"]), float(hits[0]["lon"])) if hits else None


def main():
    filled = 0
    for path in sorted(ROOT.glob("places/*/*.md")):
        text = path.read_text(encoding="utf-8")
        if not text.startswith("---") or (field(text, "lat") and field(text, "lng")):
            continue
        address = field(text, "address")
        if not address:
            continue
        try:
            hit = geocode(address)
            time.sleep(1.1)
            if not hit:  # "(basement)" notes, unit numbers and postal codes can confuse the geocoder
                plain = re.sub(r"\s*\([^)]*\)|,?\s*[A-Z]\d[A-Z] ?\d[A-Z]\d", "", address)
                plain = re.sub(r",\s*(local|suite|unit|unité|bureau|#)\s*[\w-]+", "", plain, flags=re.I)
                hit = geocode(plain)
                time.sleep(1.1)
        except Exception as err:  # network trouble: leave it for the next run
            print(f"{path.relative_to(ROOT)}: {err}")
            continue
        if not hit:
            print(f"{path.relative_to(ROOT)}: not found ({address})")
            continue
        text = re.sub(r"^lat:.*$", f"lat: {coord(hit[0])}", text, count=1, flags=re.M)
        text = re.sub(r"^lng:.*$", f"lng: {coord(hit[1])}", text, count=1, flags=re.M)
        path.write_text(text, encoding="utf-8")
        filled += 1
    print(f"geocoded {filled} places")


if __name__ == "__main__":
    main()
