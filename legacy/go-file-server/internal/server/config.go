package server

import (
	"os"
	"strconv"
)

type Config struct {
	Addr         string
	DataPath     string
	Token        string
	MaxBodyBytes int64
}

func ConfigFromEnv() Config {
	return Config{
		Addr:         envString("CLIPBRIDGE_ADDR", ":8080"),
		DataPath:     envString("CLIPBRIDGE_DATA_PATH", "data/clipbridge.json"),
		Token:        os.Getenv("CLIPBRIDGE_TOKEN"),
		MaxBodyBytes: envInt64("CLIPBRIDGE_MAX_BODY_BYTES", 10<<20),
	}
}

func envString(key string, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func envInt64(key string, fallback int64) int64 {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	parsed, err := strconv.ParseInt(value, 10, 64)
	if err != nil || parsed <= 0 {
		return fallback
	}
	return parsed
}
