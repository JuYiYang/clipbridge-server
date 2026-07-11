package server

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

var ErrInvalidItem = errors.New("invalid clipboard item")

type Store interface {
	UpsertItems(ctx context.Context, deviceID string, items []ClipboardItem) (stored int, nextSince float64, err error)
	ListItemsSince(ctx context.Context, since float64) ([]ClipboardItem, *float64, error)
}

type FileStore struct {
	path  string
	mu    sync.Mutex
	state fileState
}

type fileState struct {
	Version int                            `json:"version"`
	Items   map[string]storedClipboardItem `json:"items"`
}

type storedClipboardItem struct {
	ClipboardItem
	UpdatedAt float64 `json:"updatedAt"`
}

func NewFileStore(path string) (*FileStore, error) {
	store := &FileStore{path: path}
	if err := store.load(); err != nil {
		return nil, err
	}
	return store, nil
}

func (s *FileStore) UpsertItems(ctx context.Context, deviceID string, items []ClipboardItem) (int, float64, error) {
	select {
	case <-ctx.Done():
		return 0, 0, ctx.Err()
	default:
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	if s.state.Items == nil {
		s.state.Items = map[string]storedClipboardItem{}
	}

	stored := 0
	nextSince := cursorNow()
	for _, item := range items {
		item = normalizeItem(deviceID, item)
		if !validItem(item) {
			return stored, nextSince, ErrInvalidItem
		}

		if existing, ok := s.state.Items[item.ID]; ok {
			item = mergeItems(existing.ClipboardItem, item)
		}

		nextSince = cursorNow()
		s.state.Items[item.ID] = storedClipboardItem{ClipboardItem: item, UpdatedAt: nextSince}
		stored++
	}

	if stored == 0 {
		return 0, nextSince, nil
	}
	return stored, nextSince, s.saveLocked()
}

func (s *FileStore) ListItemsSince(ctx context.Context, since float64) ([]ClipboardItem, *float64, error) {
	select {
	case <-ctx.Done():
		return nil, nil, ctx.Err()
	default:
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	items := make([]storedClipboardItem, 0)
	for _, item := range s.state.Items {
		if item.UpdatedAt > since {
			items = append(items, item)
		}
	}
	sort.SliceStable(items, func(i, j int) bool {
		if items[i].UpdatedAt == items[j].UpdatedAt {
			return items[i].LastCopiedAt.Before(items[j].LastCopiedAt)
		}
		return items[i].UpdatedAt < items[j].UpdatedAt
	})

	response := make([]ClipboardItem, 0, len(items))
	var nextSince *float64
	for _, item := range items {
		response = append(response, item.ClipboardItem)
		updatedAt := item.UpdatedAt
		nextSince = &updatedAt
	}

	return response, nextSince, nil
}

func (s *FileStore) load() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.state = fileState{Version: 1, Items: map[string]storedClipboardItem{}}
	data, err := os.ReadFile(s.path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if len(data) == 0 {
		return nil
	}
	if err := json.Unmarshal(data, &s.state); err != nil {
		return err
	}
	if s.state.Items == nil {
		s.state.Items = map[string]storedClipboardItem{}
	}
	if s.state.Version == 0 {
		s.state.Version = 1
	}
	return nil
}

func (s *FileStore) saveLocked() error {
	if err := os.MkdirAll(filepath.Dir(s.path), 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(s.state, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

func normalizeItem(deviceID string, item ClipboardItem) ClipboardItem {
	if item.SourceDeviceID == "" {
		item.SourceDeviceID = deviceID
	}
	if item.NumberOfCopies <= 0 {
		item.NumberOfCopies = 1
	}
	now := time.Now().UTC()
	if item.FirstCopiedAt.IsZero() {
		item.FirstCopiedAt = now
	}
	if item.LastCopiedAt.IsZero() {
		item.LastCopiedAt = item.FirstCopiedAt
	}
	return item
}

func validItem(item ClipboardItem) bool {
	if item.ID == "" || item.SourceDeviceID == "" || len(item.Contents) == 0 {
		return false
	}
	for _, content := range item.Contents {
		if content.Type == "" {
			return false
		}
	}
	return true
}

func mergeItems(existing ClipboardItem, incoming ClipboardItem) ClipboardItem {
	merged := incoming
	if !existing.FirstCopiedAt.IsZero() && existing.FirstCopiedAt.Before(incoming.FirstCopiedAt) {
		merged.FirstCopiedAt = existing.FirstCopiedAt
	}
	if existing.LastCopiedAt.After(incoming.LastCopiedAt) {
		merged.LastCopiedAt = existing.LastCopiedAt
	}
	if existing.NumberOfCopies > incoming.NumberOfCopies {
		merged.NumberOfCopies = existing.NumberOfCopies
	}
	if incoming.Pin == nil {
		merged.Pin = existing.Pin
	}
	if incoming.Application == nil {
		merged.Application = existing.Application
	}
	if incoming.Title == "" {
		merged.Title = existing.Title
	}
	return merged
}

func cursorNow() float64 {
	return float64(time.Now().UTC().UnixNano()) / 1e9
}
