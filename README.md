# ClipBridge Server

ClipBridge Server is the self-hostable sync backend for ClipBridge clients.

This first implementation is intentionally small: a Go HTTP API, bearer-token authentication, and a file-backed JSON store. The store is hidden behind an interface so the next step can swap in SQLite or PostgreSQL without changing the client protocol.

## Status

Implemented:

- `GET /healthz`
- `POST /v1/clipboard/items`
- `GET /v1/clipboard/items?since=<unix-seconds>`
- Optional bearer token auth through `CLIPBRIDGE_TOKEN`
- Idempotent writes by clipboard item `id`
- Incremental pull cursor through `nextSince`

Planned:

- SQLite/PostgreSQL storage
- Tombstones for delete and clear propagation
- Device registration
- Client-side end-to-end encryption envelopes
- OpenAPI contract and Docker image

## Run

```sh
go run ./cmd/clipbridge-server
```

Environment variables:

| Name | Default | Description |
| --- | --- | --- |
| `CLIPBRIDGE_ADDR` | `:8080` | HTTP listen address. |
| `CLIPBRIDGE_DATA_PATH` | `data/clipbridge.json` | File-store path. |
| `CLIPBRIDGE_TOKEN` | empty | When set, clients must send `Authorization: Bearer <token>`. |
| `CLIPBRIDGE_MAX_BODY_BYTES` | `10485760` | Maximum JSON request body size. |

Example:

```sh
CLIPBRIDGE_TOKEN=dev-token go run ./cmd/clipbridge-server
```

Then configure the macOS client:

- Server URL: `http://localhost:8080`
- Access token: `dev-token`

## API

See [docs/api.md](docs/api.md).
