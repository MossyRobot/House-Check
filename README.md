# House Check

A one-click bookmark for Rightmove. On any property page it opens a results page showing:

- the **radon class** for the property's 1 km square (BGS/UKHSA Indicative Atlas of Radon)
- **journey times** by car and public transport to saved places (Google Maps Routes API)

Everything runs in the browser. It's a static site on GitHub Pages, with no server, no install and no Python for the person using it.
Saved places are kept in each user's own browser (localStorage), never in this repo.

```
docs/            the website (GitHub Pages serves this folder)
  index.html     results page + saved places + setup (bookmarklet)
  app.js         page logic
  lib.js         pure logic: coordinates, radon grid, Rightmove parsing, bookmarklet
  config.js      Google Maps API key (restricted - see below)
  radon-gb.bin   compact radon grid, built by tools/build_radon.py
tools/build_radon.py   one-off: atlas GeoPackage -> docs/radon-gb.bin
tests/lib.test.mjs     run with: node --test
```

## One-time setup

### 1. Build the radon data
1. Download **"Radon data: indicative atlas for Great Britain – OGC GeoPackage"** (~7 MB) from
   https://www.bgs.ac.uk/datasets/radon-data-indicative-atlas-of-radon/
   and unzip it into `data/radon/` (git ignores this folder).
2. Convert it (needs [uv](https://docs.astral.sh/uv/), already installed here):
   ```bash
   uv run tools/build_radon.py
   ```
   It finds the atlas in `data/radon/` by itself. You can also pass a file path.
   This writes `docs/radon-gb.bin` (~430 KB) and prints a count of squares per class.
   If it can't find the class column, it lists the columns. Re-run with `--class-column NAME`.

### 2. Put it on GitHub Pages
1. Create a GitHub repo (e.g. `house-check`) and push this folder to it.
2. Repo **Settings → Pages → Build and deployment**: Source = *Deploy from a branch*,
   Branch = `main`, folder = `/docs`. Save.
3. After a minute the site is at `https://<your-username>.github.io/house-check/`.

On a free GitHub plan the Pages site is public, even if the repo is private.
Nothing personal is in it: places live in each browser, and the key below is locked to the site.

### 3. Google Maps key (for journey times)
1. https://console.cloud.google.com → create a project → attach a billing account
   (needed even to use the free allowance).
2. **APIs & Services → Library**: enable **Routes API**.
3. **APIs & Services → Credentials → Create credentials → API key**, then edit it:
   - *Application restrictions*: **Websites** → add `https://<your-username>.github.io/*`
   - *API restrictions*: **Restrict key** → **Routes API** only
4. **APIs & Services → Routes API → Quotas**: set a requests-per-day limit (e.g. 300).
   That keeps you well inside the free monthly allowance, and requests simply stop if it's hit.
5. Optional: **Billing → Budgets & alerts**: a £1 budget alert.
6. Paste the key into `docs/config.js`, commit and push.

Each property check uses 2 requests per saved place (drive + public transport).
Results are cached in the browser for 30 days, so re-opening a property is free.

### 4. Share it
Send the Pages link to whoever will use it. On the page, they drag **House check** onto their bookmarks bar and
add their saved places. Then they click the bookmark on any Rightmove property.
Saved places can be exported/imported as a file to move them between browsers.

## Development

```bash
node --test                      # unit tests
python -m http.server -d docs    # local preview at http://localhost:8000
```

The Google key won't work on localhost while it's restricted to github.io. For local
testing, either add `http://localhost:8000/*` to the key's allowed websites or
paste an unrestricted test key into the page's Settings box (stored only in your browser).

## Caveats

- Rightmove has no API. The bookmark reads the data already on the page you're viewing.
  If Rightmove changes its page format, `extractListing` in `docs/lib.js` needs updating.
- Some listings have an *approximate* pin. The page warns when this happens.
- The radon atlas covers Great Britain only. Northern Ireland has a separate atlas that isn't loaded.
- Driving times ignore traffic. Public transport is timed for the next weekday at 08:00.
- Fares aren't included yet.
