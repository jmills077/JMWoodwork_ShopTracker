# Shop Tracker

Quotes, scheduling and to-do lists for a custom furniture shop: price a piece, send the
client a printable quote, track each job through its phases on a board and a calendar, and keep
each job's to-do and lumber shopping lists. Lumber is priced from Parkerville Wood Products' price
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
cp .dev.vars.example .dev.vars    # local secrets: sign-in password (default: shop), optional Shopify app
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
  env.ts             Worker bindings (DB, ASSETS, AI) and secrets
  lib/auth.ts        Single-password sign-in with a signed session cookie
  lib/db.ts          D1 reads and writes
  lib/prices.ts      Reads Parkerville's price lists (runs from the cron)
  lib/receipts.ts    Reads a receipt photo into line items (Workers AI)
  views/             Page templates (Hono JSX): the app page, sign-in
  client/app.ts      The app in the browser: every screen, the estimating model, to-do lists
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
- **Todoist** (removed). The app used to make a Todoist project per job. The to-do lists below
  replaced it, and the app no longer talks to Todoist. The `projects.todoist` column is left as it
  was so older data isn't lost; the `TODOIST_TOKEN` secret can be deleted from the Worker.
- **Small-batch runs.** The Product line tab has a quick form for a batch of one of the shop's
  products. Products, variants and prices come from the jmwood.work Shopify storefront
  (`GET /api/shop-products` reads its public `products.json` for the collection on the Small Batch
  Projects page, kept in the database for an hour and used as a fallback when the shop answers
  "too many requests"); per-unit cost, hours and materials are filled in on the Products page and kept in
  the settings. A run is a product-line project with a `data.batch` section, due on its ship-by
  date.
  With the Shopify app connected (`SHOPIFY_CLIENT_ID` / `SHOPIFY_CLIENT_SECRET`, see
  DEPLOYMENT.md), `GET /api/shop-orders` reads unfulfilled orders through the Admin API and each
  product gets one open run holding everything still owed (`src/lib/shopify.ts`).
- **Frozen projects.** A project can be frozen from its Status box when a client goes quiet or a job
  hits a long delay. It keeps its status, phase and dates (in `data.frozen`) but leaves the board,
  the stats and the calendar for the Frozen list (`#/frozen`).
  Unfreezing puts it back where it was and offers to push its due dates back by the time it spent frozen. No migration: it's
  part of the project's data.
- **Tasks.** Every project gets its own to-do list and lumber store shopping list the moment it is
  created (`data.todo`: `items`, `lumber` and a `log` of everything added, checked off, unchecked or
  removed). The Tasks page (`#/tasks`) lists the active projects (nearest due date first until you press and hold a project to move it; that order is saved in the settings and shared by every device, new projects slot in by due date, and **Sort by due date** goes back to the default), then the frozen and finished ones; its **All to-dos** tab (`#/tasks/todos`) lists every open to-do item from the active projects in that same order; its **Shopping list** tab (`#/tasks/shopping`) gathers every
  active project's shopping list in one place to check off (checking there checks the project's own list). It opens **By species**: lumber grouped by wood species with thickness, width, length and how many read from how each item is written (a dash when it isn't given; plywood and other sheet goods always show their thickness, written as 3/4", 3/4 in, ¾, .75" or 18mm, and are flagged when it's missing), and everything else under Other supplies; **By project** shows each project's list and is where items are added; each project opens its list at
  `#/tasks/<id>`, also linked as a tab on the project's page. Checked-off items stay on the list, struck
  through, with the date they were done. Press and hold an item to drag it up or down. Pasting several lines into the add box adds
  one item per line (bullets, numbers and checkboxes are stripped; a single line splits on semicolons). When a project
  is marked Complete (or a client job goes straight to Delivered & paid), everything still open is
  checked off. Projects from before this got a list on first load. No migration: it's part of the
  project's data.
- **Receipts and material purchases.** **Scan a receipt** (on the Projects page, or on a project's
  Material purchases box) takes a photo with the phone's camera or picks one from the library. The
  browser shrinks it and sends it to `POST /api/receipts/scan`, which reads it with a vision model on
  Workers AI (`src/lib/receipts.ts`, the `AI` binding: no API key, billed to the Cloudflare account
  under the Workers AI free allowance). The lines come back to check over: fix a name or price, untick
  what isn't for this job, pick the project, and the ticked lines (sales tax is a line of its own) are
  added to its `data.purchases`. Lines left over can go to another project from the same receipt. A
  project's page lists what was bought, the total spent and how it compares with the estimated lumber
  and hardware. Purchases don't change a quote or price. The photo isn't kept. No migration: it's
  part of the project's data. Under `npm run dev` the `AI` binding still runs on Cloudflare, so it
  needs `npx wrangler login`.
- **Prices.** A cron trigger runs every Monday at 09:17 UTC, reads Parkerville's price lists, and
  replaces the `price_items` table. If a list can't be read, the previous prices stay.
- **Sign-in.** One shop password, set as the `APP_PASSWORD` secret. Sessions last 30 days, and
  changing the password signs every device out.
- **R2** file storage (for photos and drawings) isn't set up yet. To add it, enable R2 in the Cloudflare dashboard, create a bucket, and add an `r2_buckets` binding in wrangler.jsonc.

## Moving data from the old app

The old app kept everything in the browser (or in a GitHub repository, if sync was on). To bring it over:

1. In the old app, open **Settings → Backup → Export backup**.
2. In this app, open **Settings → Backup → Import backup…** and choose the file.

The import replaces all projects and settings, and quote numbers stay the same.
