# ClipBridge Server

ClipBridge Server is the open source cloud sync backend for ClipBridge clients. The primary runtime is now Cloudflare Workers with Cloudflare D1 storage, so the service can run as a small edge API without managing a VM.

## Status

Implemented:

- `GET /healthz`
- `POST /v1/clipboard/items`
- `GET /v1/clipboard/items?since=<unix-seconds>`
- `GET /admin/items`
- Optional bearer-token auth through the Worker secret `CLIPBRIDGE_TOKEN`
- Cloudflare D1 persistence
- Idempotent writes by clipboard item `id`
- Incremental pull cursor through `nextSince`

Planned:

- Tombstones for delete and clear propagation
- Device registration
- Client-side end-to-end encryption envelopes
- OpenAPI contract

The original Go file-backed prototype is preserved in `legacy/go-file-server/` for reference, but new development should target the Worker implementation.

## Project Layout

```text
.
├── src/index.ts              # Worker HTTP API
├── migrations/0001_initial.sql
├── wrangler.jsonc            # Worker + D1 binding config
├── docs/api.md
├── docs/cloudflare.md
└── legacy/go-file-server/    # archived Go prototype
```

## Local Setup

Install dependencies:

```sh
npm install
```

Create a D1 database:

```sh
npm run db:create
```

Copy the `database_id` from Wrangler output into `wrangler.jsonc`, keeping the binding name as `DB`.

Apply the schema locally:

```sh
npm run db:migrate:local
```

Run the Worker locally:

```sh
npm run dev
```

Then configure the macOS client:

- Server URL: `http://localhost:8787`
- Access token: empty, unless you set `CLIPBRIDGE_TOKEN`

Open the local admin list:

```text
http://localhost:8787/admin/items
```

If `CLIPBRIDGE_TOKEN` is configured, the browser will ask for Basic Auth credentials. Use any username, for example `clipbridge`, and use the token as the password.

The page shows records from all devices, source device IDs, app names,
timestamps, clipboard content types, decoded text previews, browser-previewable
image thumbnails, and raw base64 values.

## Deploy

Set an access token for production:

```sh
npx wrangler secret put CLIPBRIDGE_TOKEN
```

Apply the D1 migration remotely:

```sh
npm run db:migrate:remote
```

Deploy the Worker:

```sh
npm run deploy
```

## API

See [docs/api.md](docs/api.md). Cloudflare-specific setup notes are in [docs/cloudflare.md](docs/cloudflare.md).
