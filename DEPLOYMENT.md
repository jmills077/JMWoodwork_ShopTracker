# Deploying to Cloudflare

Do this once to set it up. After that, `npm run deploy` publishes each new version.

## 1. Sign in to Cloudflare

```sh
npx wrangler login
```

## 2. Create the database

```sh
npx wrangler d1 create shop-tracker
```

`d1 create` prints a `database_id`. Paste it into `wrangler.jsonc`, replacing
the existing id:

```jsonc
"d1_databases": [
  { "binding": "DB", "database_name": "shop-tracker", "database_id": "<paste here>", ... }
]
```

## 3. Set the secrets

```sh
npx wrangler secret put APP_PASSWORD    # the sign-in password
npx wrangler secret put TODOIST_TOKEN   # Todoist → Settings → Integrations → Developer → API token
```

### Shopify (optional: small-batch runs from orders)

With these two secrets the Product line tab keeps one batch run per product filled from the shop's
unfulfilled orders. In the [Shopify Dev Dashboard](https://dev.shopify.com/dashboard), create an app
(for example "Shop Tracker") with only the `read_orders` and `read_products` access scopes, install it
on the JM Woodwork store, then copy its Client ID and Secret from the app's Settings:

```
npx wrangler secret put SHOPIFY_CLIENT_ID
npx wrangler secret put SHOPIFY_CLIENT_SECRET
```

Without them, products still come from the shop's public storefront feed and runs are made by hand.

To change the Todoist token later, run `npx wrangler secret put TODOIST_TOKEN` again. On a Worker
that's already deployed, this publishes the change immediately. Without the secret, the app runs with Todoist turned off.

Use a strong password for `APP_PASSWORD`. Anyone with the app's URL and this password can see and change all the
shop's data. (If you'd rather sign in with Google or email codes, put the Worker behind
[Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/applications/configure-apps/self-hosted-apps/)
as well. The password stays as a second lock.)

## 4. Create the tables, load prices, deploy

```sh
npm run db:migrate:remote   # create the tables
npm run db:seed:remote      # load the saved price list (it won't replace a newer one)
npm run deploy              # applies any new migrations, then deploys
```

Wrangler prints the app's URL (`https://shop-tracker.<your-subdomain>.workers.dev`). Open it,
sign in, then:

1. **Settings → Todoist → Test connection** to check the token.
2. **Settings → Backup → Import backup…**: import a backup exported from the old app (see the
   README).

## Updating

```sh
npm run deploy
```

This applies any new files in `migrations/` to the Cloudflare database first, then deploys.
`wrangler deploy` runs `npm run build:client` itself, so the browser script is always rebuilt.

## The weekly price check

The cron trigger in `wrangler.jsonc` (`17 9 * * 1`: Mondays at 09:17 UTC, about 5 am Eastern) is
registered on deploy. Each run's logs, including failures, appear in the Cloudflare dashboard
under **Workers & Pages → shop-tracker → Logs**.

## Backups of the database

D1 keeps 30 days of point-in-time history ([Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)):

```sh
npx wrangler d1 time-travel info shop-tracker
npx wrangler d1 export shop-tracker --remote --output=shop-tracker.sql   # a full SQL dump
```

**Settings → Backup → Export backup** in the app also downloads the projects and settings as JSON.

## Custom domain (optional)

To use your own domain instead of `workers.dev`, go to the dashboard: **Workers & Pages →
shop-tracker → Settings → Domains & Routes → Add → Custom domain**.
