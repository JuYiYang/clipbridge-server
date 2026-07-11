# ClipBridge Server API

The server implements the first macOS client contract.

## Authentication

Set `CLIPBRIDGE_TOKEN` to require bearer authentication:

```http
Authorization: Bearer <token>
```

Clients also send a stable device identifier:

```http
X-ClipBridge-Device-ID: <device-id>
```

The first API revision stores the clipboard payload shape produced by the macOS client. End-to-end encryption is still a planned client-side layer; the storage interface is intentionally narrow so encrypted envelopes can replace structured contents later.

## Health

```http
GET /healthz
```

Response:

```json
{ "ok": true }
```

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

`id` is treated as an idempotency key.

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

Clients store `nextSince` and use it as the next incremental pull cursor.
