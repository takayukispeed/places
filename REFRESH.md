# Weekly refresh

A scheduled Claude session runs this once a week. It checks the 25 places checked longest ago, so every place is covered roughly every six to seven weeks. Changes go straight to `main`. The commit message lists every change and its source.

## Steps

1. `python3 scripts/due_places.py 25` lists the batch.
2. For each place, search the web for its current hours, address, phone, website, and whether it is still open. In order of preference, use:
   1. The place's own website or social media.
   2. A listing updated in the last 12 months (Yelp, Tripadvisor, a local guide, or a news article).
   3. A Google Maps result, if a search shows it.
3. Edit the file only where a source supports the change:
   - **Hours:** rewrite `## Hours` in the format in the README. When sources disagree, keep the official one and note the conflict.
   - **Address:** if the place has moved, write the new address in full and **clear `lat:` and `lng:`**. The Action then puts a new pin on the map.
   - **Phone / website:** fill in or correct these only from the official site, or from two listings that agree.
   - **Notes:** keep what is there. Add or update one source line, such as `- Hours: [Site](https://…), October 2026.` Never add claims about food, prices or atmosphere that no source supports.
   - **Closed for good:** move the file with `git mv places/<city>/<slug>.md closed/<city>/<slug>.md` and add a source line saying when and how it closed. Files in `closed/` stay out of the app and can be moved back. A temporary closure (renovation, holidays) is a note, not a move.
   - **Can't tell:** if the evidence is thin or conflicts and you can't settle it, change nothing. Add a short note saying what is uncertain.
4. Set `checked:` to today's date (`YYYY-MM-DD`) on every place in the batch, changed or not, so that next week's batch moves on.
5. Don't change `category`, `area` or `name`, apart from fixing an obvious misspelling of the official name.
6. Run `node tests/format.test.mjs` and `python3 scripts/build_index.py`, then commit and push to `main`. Use the title `Weekly refresh: N places checked, M changed`, and give the body one line per changed place: what changed and its source. Also list the places moved to `closed/` and anything left uncertain.

Use Canadian spelling.
