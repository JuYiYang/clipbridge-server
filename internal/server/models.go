package server

import "time"

type ClipboardContent struct {
	Type  string `json:"type"`
	Value []byte `json:"value"`
}

type ClipboardItem struct {
	ID             string             `json:"id"`
	Title          string             `json:"title"`
	Application    *string            `json:"application"`
	FirstCopiedAt  time.Time          `json:"firstCopiedAt"`
	LastCopiedAt   time.Time          `json:"lastCopiedAt"`
	NumberOfCopies int                `json:"numberOfCopies"`
	Pin            *string            `json:"pin"`
	Contents       []ClipboardContent `json:"contents"`
	SourceDeviceID string             `json:"sourceDeviceID"`
}

type PushRequest struct {
	DeviceID string          `json:"deviceID"`
	Items    []ClipboardItem `json:"items"`
}

type PushResponse struct {
	Accepted  int     `json:"accepted"`
	Stored    int     `json:"stored"`
	NextSince float64 `json:"nextSince"`
}

type PullResponse struct {
	Items     []ClipboardItem `json:"items"`
	NextSince *float64        `json:"nextSince,omitempty"`
}

type ErrorResponse struct {
	Error string `json:"error"`
}

type HealthResponse struct {
	OK bool `json:"ok"`
}
