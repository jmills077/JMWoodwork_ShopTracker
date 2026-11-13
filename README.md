# Shop Tracker

Quotes, scheduling and Todoist hand-off for a custom furniture shop: price a piece, send the
client a printable quote, track each job through its phases on a board and a calendar, and turn
accepted quotes into Todoist task lists. Lumber is priced from Parkerville Wood Products' price
lists, refreshed weekly.

It runs on Cloudflare: a single [Worker](https://developers.cloudflare.com/workers/) built with
[Hono](https://hono.dev), with [D1](https://developers.cloudflare.com/d1/) (SQLite) for storage.
Everything is TypeScript.

## Run it locally

Everything runs on your machine. `wrangler dev` simulates the Worker, D1 and the cron trigger
locally, so you don't need a Cloudflare account or login.

Requirements: Node.js 22.18 or newer (the seed script is TypeScript run directly by Node).

```sh
npm install
cp .dev.vars.example .dev.vars    # local secrets: sign-in password (default: shop), optional Todoist token
npm run setup:local               # creates the local database and loads the saved price list
npm run dev                       # http://localhost:8787
```

Sign in with the password from `.dev.vars`. Local data lives in `.wrangler/state/`;
`npm run db:reset:local` wipes it and starts over.

To run the weekly price check by hand while `npm run dev` is running (this one step does go out to
the internet, to read Parkerville's pages):

```sh
curl -X POST "http://localhost:8787/cdn-cgi/local/explorer/api/local/scheduled?worker=jmwoodwork-shoptracker" \
  -H 'Content-Type: application/json' -d '{"cron":"17 9 * * 1"}'
```

Reload the app afterwards and linked species pick up the new prices.

| Command | What it does |
| --- | --- |
| `npm run dev` | Local server with hot reload (rebuilds the browser script too) |
| `npm run setup:local` | Apply migrations and seed prices into the local database |
| `npm run db:reset:local` | Delete local data and set it up again |
| `npm run typecheck` | Type-check the Worker, the browser script and the scripts |
| `npm run deploy` | Apply migrations to the Cloudflare database, then deploy (see [DEPLOYMENT.md](DEPLOYMENT.md)) |

## Put it on your phone's home screen

The site can be installed like an app, with its own icon, opening full screen.

- **iPhone or iPad:** open the site in Safari, tap the Share button, then **Add to Home Screen**, then **Add**.
- **Android:** open the site in Chrome, tap the ⋮ menu, then **Add to Home screen** (or **Install app**).

Sign in once from the home-screen icon: it keeps its own sign-in, separate from the browser's.
A sign-in lasts 90 days and is renewed whenever the app is used, so it only asks again after
three months without opening it, or after `APP_PASSWORD` is changed.
The manifest and icons are in `public/`. The icons are the "J.M." from the J.M. Woodwork logo (in the branding files), in cream on the brand red.

## How it fits together

```
src/
  index.tsx          Hono app: sign-in, the app page, the JSON API, the weekly cron
  env.ts             Worker bindings (DB, ASSETS) and secrets
  lib/auth.ts        Single-password sign-in with a signed session cookie
  lib/db.ts          D1 reads and writes
  lib/prices.ts      Reads Parkerville's price lists (runs from the cron)
  views/             Page templates (Hono JSX): the app page, sign-in
  client/app.ts      The app in the browser: every screen, the estimating model, Todoist sync
  shared/types.ts    Shapes shared by the server and the browser
public/app.css       Stylesheet (public/app.js is built from src/client)
migrations/          D1 schema
seed/                Last saved price list, loaded by `npm run setup:local`
scripts/             Seed script
```

- **The app page** (`GET /`) is rendered by the Worker with the shop's data embedded in it. The
  browser script draws each screen from that data, exactly as the original single-file app did.
- **Saving.** Every change is sent to `POST /api/save` shortly after it's made: only the projects
  that changed, plus the settings if they changed. When the tab comes back into view, the latest
  data is fetched, so edits on another device show up. When two devices edit the same project,
  the most recent edit wins.
- **Todoist.** The API token is the `TODOIST_TOKEN` Worker secret (locally, in `.dev.vars`). It
  never reaches the browser or the database. The browser's Todoist calls go through
  `/api/todoist/*`, which adds the token. Without it, the app runs with Todoist turned off.
- **Small-batch runs.** The Product line tab has a quick form for a batch of one of the shop's
  products. Products, variants and prices come from the jmwood.work Shopify storefront
  (`GET /api/shop-products` reads its public `products.json` for the collection on the Small Batch
  Projects page, kept in the database for an hour and used as a fallback when the shop answers
  "too many requests"); per-unit cost, hours and materials are filled in on the Products page and kept in
  the settings. A run is a product-line project with a `data.batch` section, due on its ship-by
  date. Its Todoist project is created with it and updated after every change.
  With the Shopify app connected (`SHOPIFY_CLIENT_ID` / `SHOPIFY_CLIENT_SECRET`, see
  DEPLOYMENT.md), `GET /api/shop-orders` reads unfulfilled orders through the Admin API and each
  product gets one open run holding everything still owed (`src/lib/shopify.ts`).
- **Frozen projects.** A project can be frozen from its Status box when a client goes quiet or a job
  hits a long delay. It keeps its status, phase and dates (in `data.frozen`) but leaves the board,
  the stats and the calendar for the Frozen list (`#/frozen`), and its Todoist project is archived.
  Unfreezing puts it back where it was, unarchives the Todoist project (catching a batch run up on
  any edits) and offers to push its due dates back by the time it spent frozen. No migration: it's
  part of the project's data.
- **Prices.** A cron trigger runs every Monday at 09:17 UTC, reads Parkerville's price lists, and
  replaces the `price_items` table. If a list can't be read, the previous prices stay.
- **Sign-in.** One shop password, set as the `APP_PASSWORD` secret. Sessions last 30 days, and
  changing the password signs every device out.
- **R2** file storage (for photos and drawings) isn't set up yet. To add it, enable R2 in the Cloudflare dashboard, create a bucket, and add an `r2_buckets` binding in wrangler.jsonc.

## Moving data from the old app

The old app kept everything in the browser (or in a GitHub repository, if sync was on). To bring it over:

1. In the old app, open **Settings → Backup → Export backup**.
2. In this app, open **Settings → Backup → Import backup…** and choose the file.

The import replaces all projects and settings, and quote numbers stay the same. The Todoist token
isn't part of backups. It's set as the `TODOIST_TOKEN` secret (see [DEPLOYMENT.md](DEPLOYMENT.md)).
