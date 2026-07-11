# Legacy Go File Server

This directory preserves the original Go file-backed prototype for reference. It is no longer the primary ClipBridge Server runtime; new development should target the Cloudflare Worker in `../../src/index.ts`.

Run from this directory if you need to compare behavior:

```sh
go test ./...
go run ./cmd/clipbridge-server
```
