# ClipBridge Server Deployment

This guide deploys `clipbridge-server` to Cloudflare Workers with D1. The
Worker stores synchronized clipboard records and serves the admin list page.

## Prerequisites

- A Cloudflare account.
- A GitHub repository connected to Cloudflare Workers.
- Node.js 20 or newer for local Wrangler commands.
- A shared access token for clients and the server.

Generate a token locally:

```sh
uuidgen
```

Use the generated value as `CLIPBRIDGE_TOKEN` in Cloudflare and in the macOS or
Windows client settings.

## Cloudflare Dashboard Deployment

1. Open Cloudflare Dashboard -> Workers & Pages.
2. Choose Create -> Worker.
3. Choose Continue with GitHub.
4. Select the `JuYiYang/clipbridge-server` repository.
5. Use project name `clipbridge-server`.
6. Leave the build command empty unless Cloudflare asks for one.
7. Set the deploy command to:

```sh
npx wrangler deploy
```

8. Deploy the project once.

The first deploy may succeed before the D1 schema exists. That is fine; create
and migrate D1 next.

## D1 Database

Create a D1 database named `clipbridge` from the Cloudflare Dashboard:

1. Open Workers & Pages -> D1.
2. Choose Create database.
3. Name it `clipbridge`.
4. Copy the generated database ID.
5. Open the Worker settings and add a D1 binding:
   - Variable name: `DB`
   - Database: `clipbridge`

The binding name must be exactly `DB`.

If you are editing the repository config, put the same database ID in
`wrangler.jsonc`:

```jsonc
"d1_databases": [
  {
    "binding": "DB",
    "database_name": "clipbridge",
    "database_id": "your-d1-database-id",
    "migrations_dir": "migrations"
  }
]
```

## Apply Schema

In Cloudflare Dashboard:

1. Open D1 -> `clipbridge`.
2. Open Console.
3. Paste the SQL from `migrations/0001_initial.sql`.
4. Run it.

The SQL creates `clipboard_items` plus indexes for sync cursor and source
device filtering.

You can also apply the migration from a local terminal:

```sh
npm install
npm run db:migrate:remote
```

## Secrets And Variables

In the Worker settings, add a secret:

```text
CLIPBRIDGE_TOKEN=<your uuid token>
```

This token is used as the bearer token for API clients. The admin page accepts
HTTP Basic Auth too: use any username and use the token as the password.

Optional plain variable:

```text
CLIPBRIDGE_MAX_BODY_BYTES=10485760
```

If unset, the Worker defaults to 10 MiB.

## Verify Deployment

Open:

```text
https://<your-worker-domain>/healthz
```

Expected response:

```json
{ "ok": true }
```

Open the admin list:

```text
https://<your-worker-domain>/admin/items
```

If auth is enabled, enter any username and the token as the password.

## Client Configuration

macOS:

1. Open ClipBridge Preferences.
2. Open Cloud.
3. Enable Cloud Sync.
4. Set Server URL to the Worker URL.
5. Set Access Token to `CLIPBRIDGE_TOKEN`.
6. Set the sync interval.

Windows:

1. Run `clipbridge-windows.exe`.
2. Click the tray icon and open settings.
3. Set Server URL, Token, sync interval, and clipboard poll interval.
4. Save.

## GitHub Auto Deploy

If the Cloudflare project is connected to GitHub, pushing to the configured
production branch will trigger Cloudflare's deployment pipeline. If you change
D1 schema files, deploy code and apply migrations separately; Cloudflare does
not automatically run arbitrary D1 migration SQL from the dashboard unless you
configure that pipeline yourself.

## Local Commands

```sh
npm install
npm run dev
npm run typecheck
npm run db:migrate:local
npm run db:migrate:remote
npm run deploy
```
