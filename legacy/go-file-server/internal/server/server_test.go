package server

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"
)

func TestPushPullRoundTrip(t *testing.T) {
	api := testServer(t, "secret")
	item := ClipboardItem{
		ID:             "item-1",
		Title:          "hello",
		FirstCopiedAt:  time.Date(2026, 7, 11, 10, 0, 0, 0, time.UTC),
		LastCopiedAt:   time.Date(2026, 7, 11, 10, 0, 1, 0, time.UTC),
		NumberOfCopies: 1,
		Contents:       []ClipboardContent{{Type: "public.utf8-plain-text", Value: []byte("hello")}},
		SourceDeviceID: "mac-1",
	}

	pushBody, _ := json.Marshal(PushRequest{DeviceID: "mac-1", Items: []ClipboardItem{item}})
	push := httptest.NewRequest(http.MethodPost, "/v1/clipboard/items", bytes.NewReader(pushBody))
	push.Header.Set("Authorization", "Bearer secret")
	pushResult := httptest.NewRecorder()
	api.ServeHTTP(pushResult, push)
	if pushResult.Code != http.StatusAccepted {
		t.Fatalf("push status = %d, body = %s", pushResult.Code, pushResult.Body.String())
	}

	pull := httptest.NewRequest(http.MethodGet, "/v1/clipboard/items?since=0", nil)
	pull.Header.Set("Authorization", "Bearer secret")
	pullResult := httptest.NewRecorder()
	api.ServeHTTP(pullResult, pull)
	if pullResult.Code != http.StatusOK {
		t.Fatalf("pull status = %d, body = %s", pullResult.Code, pullResult.Body.String())
	}

	var response PullResponse
	if err := json.Unmarshal(pullResult.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if len(response.Items) != 1 || response.Items[0].ID != "item-1" || string(response.Items[0].Contents[0].Value) != "hello" {
		t.Fatalf("unexpected pull response: %+v", response.Items)
	}
	if response.NextSince == nil || *response.NextSince <= 0 {
		t.Fatalf("missing nextSince: %+v", response.NextSince)
	}
}

func TestRequiresBearerToken(t *testing.T) {
	api := testServer(t, "secret")
	req := httptest.NewRequest(http.MethodGet, "/v1/clipboard/items", nil)
	res := httptest.NewRecorder()
	api.ServeHTTP(res, req)
	if res.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusUnauthorized)
	}
}

func TestUpsertIsIdempotentByItemID(t *testing.T) {
	store, err := NewFileStore(filepath.Join(t.TempDir(), "store.json"))
	if err != nil {
		t.Fatal(err)
	}
	item := ClipboardItem{
		ID:             "same-content",
		Title:          "hello",
		NumberOfCopies: 1,
		Contents:       []ClipboardContent{{Type: "public.utf8-plain-text", Value: []byte("hello")}},
		SourceDeviceID: "mac-1",
	}
	if _, _, err := store.UpsertItems(context.Background(), "mac-1", []ClipboardItem{item}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.UpsertItems(context.Background(), "mac-1", []ClipboardItem{item}); err != nil {
		t.Fatal(err)
	}
	items, _, err := store.ListItemsSince(context.Background(), 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 {
		t.Fatalf("items = %d, want 1", len(items))
	}
}

func testServer(t *testing.T, token string) *Server {
	t.Helper()
	store, err := NewFileStore(filepath.Join(t.TempDir(), "store.json"))
	if err != nil {
		t.Fatal(err)
	}
	return New(Config{Token: token, MaxBodyBytes: 1 << 20}, store, slog.New(slog.NewTextHandler(bytes.NewBuffer(nil), nil)))
}
