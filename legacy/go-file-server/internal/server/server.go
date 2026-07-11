package server

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"
)

type Server struct {
	cfg    Config
	store  Store
	logger *slog.Logger
	mux    *http.ServeMux
}

func New(cfg Config, store Store, logger *slog.Logger) *Server {
	if cfg.MaxBodyBytes <= 0 {
		cfg.MaxBodyBytes = 10 << 20
	}
	if logger == nil {
		logger = slog.Default()
	}

	s := &Server{cfg: cfg, store: store, logger: logger, mux: http.NewServeMux()}
	s.routes()
	return s
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	started := time.Now()
	s.mux.ServeHTTP(w, r)
	s.logger.Info("request", "method", r.Method, "path", r.URL.Path, "duration", time.Since(started).String())
}

func (s *Server) routes() {
	s.mux.HandleFunc("GET /healthz", s.handleHealth)
	s.mux.HandleFunc("POST /v1/clipboard/items", s.handlePushItems)
	s.mux.HandleFunc("GET /v1/clipboard/items", s.handlePullItems)
}

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, HealthResponse{OK: true})
}

func (s *Server) handlePushItems(w http.ResponseWriter, r *http.Request) {
	if !s.authorize(w, r) {
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, s.cfg.MaxBodyBytes)
	defer r.Body.Close()

	var request PushRequest
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_json")
		return
	}
	if request.DeviceID == "" {
		writeError(w, http.StatusBadRequest, "device_id_required")
		return
	}
	if len(request.Items) == 0 {
		writeJSON(w, http.StatusOK, PushResponse{Accepted: 0, Stored: 0, NextSince: cursorNow()})
		return
	}

	stored, nextSince, err := s.store.UpsertItems(r.Context(), request.DeviceID, request.Items)
	if errors.Is(err, ErrInvalidItem) {
		writeError(w, http.StatusBadRequest, "invalid_item")
		return
	}
	if err != nil {
		s.logger.Error("store items", "error", err)
		writeError(w, http.StatusInternalServerError, "store_error")
		return
	}

	writeJSON(w, http.StatusAccepted, PushResponse{Accepted: len(request.Items), Stored: stored, NextSince: nextSince})
}

func (s *Server) handlePullItems(w http.ResponseWriter, r *http.Request) {
	if !s.authorize(w, r) {
		return
	}

	since := 0.0
	if raw := r.URL.Query().Get("since"); raw != "" {
		parsed, err := strconv.ParseFloat(raw, 64)
		if err != nil || parsed < 0 {
			writeError(w, http.StatusBadRequest, "invalid_since")
			return
		}
		since = parsed
	}

	items, nextSince, err := s.store.ListItemsSince(r.Context(), since)
	if err != nil {
		s.logger.Error("list items", "error", err)
		writeError(w, http.StatusInternalServerError, "store_error")
		return
	}

	writeJSON(w, http.StatusOK, PullResponse{Items: items, NextSince: nextSince})
}

func (s *Server) authorize(w http.ResponseWriter, r *http.Request) bool {
	if s.cfg.Token == "" {
		return true
	}

	header := r.Header.Get("Authorization")
	if !strings.HasPrefix(header, "Bearer ") {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return false
	}
	got := strings.TrimSpace(strings.TrimPrefix(header, "Bearer "))
	if subtle.ConstantTimeCompare([]byte(got), []byte(s.cfg.Token)) != 1 {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return false
	}
	return true
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeError(w http.ResponseWriter, status int, code string) {
	writeJSON(w, status, ErrorResponse{Error: code})
}
