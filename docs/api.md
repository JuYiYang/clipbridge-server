# ClipBridge Server API

The server implements the first macOS client sync contract. The current production runtime is Cloudflare Workers with D1, but the HTTP API is intentionally runtime-neutral.

## Authentication

Set the Worker secret `CLIPBRIDGE_TOKEN` to require bearer authentication:

```http
Authorization: Bearer <token>
```

Clients also send a stable device identifier:

```http
X-ClipBridge-Device-ID: <device-id>
```

The first API revision stores the clipboard payload shape produced by the macOS client. End-to-end encryption is still a planned client-side layer; the storage table is intentionally narrow so encrypted envelopes can replace structured contents later.

## Health

```http
GET /healthz
```

Response:

```json
{ "ok": true }
```

## Admin List

```http
GET /admin/items
```

The admin page renders a browser-readable table of synced clipboard rows from all devices. It includes source device IDs, applications, timestamps, content types, decoded text previews, and raw base64 values.

If `CLIPBRIDGE_TOKEN` is configured, browsers authenticate with HTTP Basic Auth. Use any username and use the token as the password. API clients can also send the existing bearer token:

```http
Authorization: Bearer <token>
```

Optional query parameters:

- `device=<source-device-id>` filters to one device.
- `limit=<number>` controls the number of rows, capped at 500.

## Push Clipboard Items

```http
POST /v1/clipboard/items
```

Request:

```json
{
  "deviceID": "mac-device-id",
  "items": [
    {
      "id": "sha256-content-id",
      "title": "copied text",
      "application": "com.apple.TextEdit",
      "firstCopiedAt": "2026-07-11T10:00:00Z",
      "lastCopiedAt": "2026-07-11T10:00:00Z",
      "numberOfCopies": 1,
      "pin": null,
      "contents": [
        { "type": "public.utf8-plain-text", "value": "Y29waWVkIHRleHQ=" }
      ],
      "sourceDeviceID": "mac-device-id"
    }
  ]
}
```

Response:

```json
{ "accepted": 1, "stored": 1, "nextSince": 1783764000.0 }
```

`id` is treated as an idempotency key. If the same item is pushed again, the server updates the existing row and advances the sync cursor.

## Pull Clipboard Items

```http
GET /v1/clipboard/items?since=<unix-seconds>
```

Response:

```json
{
  "items": [],
  "nextSince": 1783764000.0
}
```

Clients store `nextSince` and use it as the next incremental pull cursor. When no rows changed, `nextSince` may be omitted.
