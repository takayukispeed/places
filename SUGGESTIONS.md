# Daily suggestions

Friends suggest places from the app's **Suggest a place** form. Each suggestion is a small JSON file in `inbox/` (name, city, and optionally who sent it and a note), saved there by the Cloudflare Worker in `worker/suggest.js`.

A scheduled Claude session runs this once a day. It turns each inbox file into a researched draft in `suggestions/<city>/`. The owner reviews drafts in the app and approves, edits or rejects them. Nothing in `suggestions/` appears on the map until it is approved.

## Steps

1. List `inbox/*.json`. If there are none, stop: no commit.
2. For each file, work out which place is meant from its name, city and note.
   - Skip it if it is already in `places/` (search names and addresses with grep), or already has a draft in `suggestions/`. Also skip anything that isn't a restaurant, café, bakery, ice cream shop or bar, and anything that looks like spam or a joke.
   - A chain gets one draft per location in that metro area (other municipalities are fine).
   - Look up its address, phone, website, booking link and hours, and check whether it is still open. Use the place's own site first, then a listing updated in the last 12 months, the same way REFRESH.md does. Search results are fine as sources.
   - If it has closed for good, can't be identified, or has no hours anywhere, write no draft. List it in the commit message with the reason.
3. Write each draft as `suggestions/<city-slug>/<place-slug>.md`. Use the same format as the files in `places/` (see README), where the city slug is the folder that city uses in `places/`. Specifically:
   - **City:** use the city exactly as `places/` spells it (`Montréal`, `Toronto`, `Vancouver`). A new city is fine.
   - **Category:** one of `cheap`, `sitdown`, `nice`, `cafe`, `bakery`, `icecream`, `bar`, `cocktail`. Match how similar places are already filed.
   - **Address:** street address with postal code, and no unit, suite or floor (the geocoder fails on those; put them in Notes). Leave the postal code off if you can't confirm it. Leave `lat:` and `lng:` empty; the map looks them up after approval.
   - **Reservation link:** only a booking URL you actually found.
   - **Hours:** in the README format, with every day covered.
   - **Notes:** short, and only sourced facts with links. Don't invent descriptions; use quotation marks if you quote. End with a source line such as `- Hours: [Site](https://…), October 2026.`, then a final line `- Suggested by <name>.` (leave out "by <name>" if they gave no name). If the sender's note helps, add it as `- Their note: "…"`.
   - Set `checked:` to today's date.
4. Delete every processed inbox file (`git rm inbox/<file>.json`), including the ones skipped in step 2.
5. Run `node tests/format.test.mjs`. It checks the drafts too. Commit and push to `main` with the title `Suggestions: N drafted, M skipped`. Give the body one line per suggestion: what was drafted (or why not) and its source.

Use Canadian spelling.
