# Places

Restaurants, cafés and bars I like, by city, for deciding where to eat or where to take friends. Each place is a plain Markdown file in this repo, used through an iPhone app.

- **App:** https://takayukispeed.github.io/places/ (see [Setting up the iPhone app](#setting-up-the-iphone-app))
- **Browse on GitHub:** [INDEX.md](INDEX.md)

## Layout

```
places/      one folder per city, one file per place
templates/   place.md, to start a new one by hand
index.html   the app (plus app/, sw.js, manifest.webmanifest)
scripts/     geocode_places.py adds map coordinates; build_index.py regenerates INDEX.md (both run on GitHub)
tests/       format and hours tests, an iPhone end-to-end test, and an app-update test
```

## Categories

| `category:` | Shown as |
|---|---|
| `cheap` | Cheap eats |
| `nice` | Nice meal |
| `brunch` | Brunch |
| `cafe` | Cafés |
| `bakery` | Bakeries |
| `bar` | Bars |
| `cocktail` | Fancy bars |

## A place file

```markdown
---
name: Big in Japan
city: Montréal
category: cocktail
area: Plateau
address: 4175 Boulevard Saint-Laurent, Montréal, QC
phone:
website:
lat:
lng:
checked: 2026-10
---

# Big in Japan

## Hours

- Mon: Closed
- Tue–Sat: 17:00–03:00
- Sun: Closed

## Notes

Anything worth remembering: what to order, who it suits, links to sources.
```

- **Hours:** one line per day or range: `Mon–Fri: 11:30–14:00, 17:00–22:00`, `Sat, Sun: 10:00–15:00`, `Daily: 8:00–15:00`, `Daily: Open 24 hours`, `Tue: Closed`. A closing time earlier than the opening time runs past midnight. Leave the section empty when unsure; the app then points to Google Maps.
- **`checked:`** is the month the hours and address were last checked. The app sets it when you change either.
- **Address:** write street names in full (`Boulevard Saint-Laurent`, `Rue Rachel Est`). The free map lookup handles those better than abbreviations.
- **`lat` / `lng`:** leave blank. After each push, a GitHub Action looks the address up on OpenStreetMap and fills them in.

## Setting up the iPhone app

The app is a home-screen web app. It is free, needs no App Store, and works offline once it has loaded. The map needs a connection.

**One-time setup on GitHub:**

1. Open this repo's **Settings → Pages**.
2. Under *Build and deployment*, set **Source: GitHub Actions**.
3. The `Deploy app` workflow publishes the app on every push to `main`.
4. The app is live at https://takayukispeed.github.io/places/.

**On the iPhone:**

1. Open that link in **Safari** and tap **Share → Add to Home Screen**.
2. To add or edit places, open ⚙︎ **Settings** inside the installed app and paste a GitHub token: a *fine-grained* token for this repo with **Contents: Read and write**. You can add this repo to the token you already use for Recipe Book (edit the token at https://github.com/settings/personal-access-tokens and add `places` under *Repository access*), or make a new one.

### How sync works

- Places are read from this repo through the GitHub API and cached on the phone.
- Saving in the app commits the file straight to `main` ("Add place: …", "Update place: …").
- A GitHub Action then adds map coordinates for new or moved places and rebuilds `INDEX.md`.
- Edits made on GitHub, or by Claude, appear the next time the app opens or you tap ↻.

## In the app

- **City** picker (once there is more than one city), **category** chips, **search** (names, neighbourhoods and notes), and **Open now**.
- **List / Map.** Pins are coloured by category; tap one for its name and whether it is open. Zoom in to neighbourhood level and names appear beside the pins, on the right or, if that's taken, the left. A name never covers another name or pin; where there's no room it waits for a closer zoom (places open now get first pick).
- **My location:** the arrow button on the map shows a blue dot where you are and centres the map on it. The dot follows you while the map is open, and stays on next time. The first tap asks for location permission; if it was refused, turn it on in iPhone Settings → Privacy & Security → Location Services → Safari Websites.
- **A place:** status (*Open until 23:00*, *Closed · opens 17:00*), **Directions** (Google Maps; opens the Google Maps app on iPhone if it's installed), **Google Maps** (photos, reviews, live hours), Call and Website buttons, the address, hours with today highlighted, and notes.
- **Adding:** tap +, type the name and city, then **Look up on OpenStreetMap**. It fills in the map location, and the address, phone, website and hours when OpenStreetMap has them. Check the result before saving. Changing the city moves the file to that city's folder.

**Why not pull place data from Google?** Google's Places API needs a billed API key, and a key in a public web app can be copied and used by anyone. OpenStreetMap is free and needs no key, and the Google Maps button gives live details when you need them.

## Tests

```
node tests/format.test.mjs                                  # every place round-trips; hours logic
NODE_PATH=$(npm root -g) node tests/app.e2e.cjs [shots]     # full flow in an emulated iPhone (needs Playwright)
NODE_PATH=$(npm root -g) node tests/update.e2e.cjs          # installed app picks up a new deploy
NODE_PATH=$(npm root -g) node tests/map.e2e.cjs [shot.png]  # the map with real Leaflet: pins, my location
```
