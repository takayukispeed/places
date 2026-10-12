#!/usr/bin/env python3
"""List the places checked longest ago, for the weekly refresh (see REFRESH.md).

`checked:` is a date (2026-10-19) or a month (2026-10). Sorting the text puts a bare month
before any day in that month, and a blank before everything.

Usage: python3 scripts/due_places.py [count]   (default 25)
"""
import sys
from pathlib import Path

from build_index import ROOT, front_matter


def main():
    count = int(sys.argv[1]) if len(sys.argv) > 1 else 25
    places = sorted(ROOT.glob("places/*/*.md"), key=lambda p: (front_matter(p).get("checked", ""), p.as_posix()))
    for path in places[:count]:
        print(f'{front_matter(path).get("checked", "") or "never":<10}  {path.relative_to(ROOT).as_posix()}')


if __name__ == "__main__":
    main()
