#!/usr/bin/env python3
"""Write places.json: every place file in one download, for phones without a GitHub token.

Signed out, the GitHub API allows 60 requests an hour, and fetching each place one by one
needs far more. The Deploy app workflow runs this before publishing, so the bundle always
matches main. Each file keeps its git blob sha, so adding a token later reuses the cache.

Usage: python3 scripts/build_bundle.py
"""
import hashlib
import json

from build_index import ROOT


def blob_sha(data):
    return hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()


def main():
    files = {}
    for path in sorted(ROOT.glob("places/*/*.md")):
        data = path.read_bytes()
        files[path.relative_to(ROOT).as_posix()] = {"sha": blob_sha(data), "text": data.decode("utf-8")}
    (ROOT / "places.json").write_text(json.dumps({"files": files}, ensure_ascii=False), encoding="utf-8")
    print(f"places.json: {len(files)} places")


if __name__ == "__main__":
    main()
