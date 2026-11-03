# Shop Tracker

Quotes, scheduling and Todoist hand-off for a custom furniture shop: price a piece, send the
client a printable quote, track each job through its phases on a board and a calendar, and turn
accepted quotes into Todoist task lists. Lumber is priced from Parkerville Wood Products' price
lists, refreshed weekly.

It runs on Cloudflare: a single [Worker](https://developers.cloudflare.com/workers/) built with
[Hono](https://hono.dev), with [D1](https://developers.cloudflare.com/d1/) (SQLite) for storage and an
[R2](https://developers.cloudflare.com/r2/) bucket ready for file storage. Everything is TypeScript.

## Run it locally

Everything runs on your machine. `wrangler dev` simulates the Worker, D1, R2 and the cron trigger
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
curl -X POST "http://localhost:8787/cdn-cgi/local/explorer/api/local/scheduled?worker=shop-tracker" \
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

## How it fits together

```
src/
  index.tsx          Hono app: sign-in, the app page, the JSON API, the weekly cron
  env.ts             Worker bindings (DB, FILES, ASSETS) and secrets
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
- **Prices.** A cron trigger runs every Monday at 09:17 UTC, reads Parkerville's price lists, and
  replaces the `price_items` table. If a list can't be read, the previous prices stay.
- **Sign-in.** One shop password, set as the `APP_PASSWORD` secret. Sessions last 30 days, and
  changing the password signs every device out.
- **R2** is bound as `FILES`, but nothing uses it yet. It's there for photos and drawings.

## Moving data from the old app

The old app kept everything in the browser (or in a GitHub repository, if sync was on). To bring it over:

1. In the old app, open **Settings → Backup → Export backup**.
2. In this app, open **Settings → Backup → Import backup…** and choose the file.

The import replaces all projects and settings, and quote numbers stay the same. The Todoist token
isn't part of backups. It's set as the `TODOIST_TOKEN` secret (see [DEPLOYMENT.md](DEPLOYMENT.md)).
