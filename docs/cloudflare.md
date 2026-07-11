# Cloudflare Deployment

ClipBridge Server runs on Cloudflare Workers and stores clipboard records in D1. The Worker binding must be named `DB` because `src/index.ts` reads `env.DB`.

## 1. Install Dependencies

```sh
npm install
```

## 2. Create D1

```sh
npm run db:create
```

Wrangler prints a `d1_databases` block. Copy the generated `database_id` into `wrangler.jsonc` and keep:

```jsonc
"binding": "DB",
"database_name": "clipbridge"
```

## 3. Apply Migrations

For local development:

```sh
npm run db:migrate:local
```

For Cloudflare production:

```sh
npm run db:migrate:remote
```

## 4. Configure Auth

Authentication is optional for local development. Production should set a Worker secret:

```sh
npx wrangler secret put CLIPBRIDGE_TOKEN
```

The macOS app should use the same value in its Cloud Sync access token field.

Optional body-size override can be configured as a plain Worker variable named `CLIPBRIDGE_MAX_BODY_BYTES`. If unset, requests are limited to 10 MiB by the Worker code.

## 5. Run Locally

```sh
npm run dev
```

Use `http://localhost:8787` as the macOS client server URL.

## 6. Deploy

```sh
npm run deploy
```

After deploy, use the Worker URL as the macOS client server URL.

## Data Model

D1 stores each clipboard item as one row keyed by `id`. Clipboard content values remain base64 strings, matching Swift `Data` JSON encoding. `updated_at` is a Unix-seconds cursor used by `GET /v1/clipboard/items?since=...`.

Deletes and clear-history events are not synced yet; the next schema revision should add tombstones before destructive client actions are propagated.
