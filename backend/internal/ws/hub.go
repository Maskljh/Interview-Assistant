package ws

import (
	"sync"

	"github.com/gorilla/websocket"
)

// writeMu guards every conn.WriteJSON call so concurrent writers (the Serve
// read loop and hub Broadcast, e.g. ForceEnd -> BroadcastDone) cannot race on
// the same connection. gorilla/websocket panics on concurrent writes; heartbeat
// pings use WriteControl, which gorilla documents as safe to call concurrently,
// so they do not take this lock.
var writeMu sync.Mutex

func writeJSON(conn *websocket.Conn, msg any) error {
	writeMu.Lock()
	defer writeMu.Unlock()
	return conn.WriteJSON(msg)
}

type Hub struct {
	mu    sync.Mutex
	conns map[int64]map[*websocket.Conn]struct{}
}

func NewHub() *Hub {
	return &Hub{conns: make(map[int64]map[*websocket.Conn]struct{})}
}

func (h *Hub) Register(sessionID int64, conn *websocket.Conn) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.conns[sessionID] == nil {
		h.conns[sessionID] = make(map[*websocket.Conn]struct{})
	}
	h.conns[sessionID][conn] = struct{}{}
}

func (h *Hub) Unregister(sessionID int64, conn *websocket.Conn) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if m := h.conns[sessionID]; m != nil {
		delete(m, conn)
		if len(m) == 0 {
			delete(h.conns, sessionID)
		}
	}
}

func (h *Hub) Broadcast(sessionID int64, msg ServerMsg) {
	h.mu.Lock()
	targets := make([]*websocket.Conn, 0, len(h.conns[sessionID]))
	for conn := range h.conns[sessionID] {
		targets = append(targets, conn)
	}
	h.mu.Unlock()
	for _, conn := range targets {
		_ = writeJSON(conn, msg)
	}
}

func (h *Hub) BroadcastDone(sessionID int64) {
	h.Broadcast(sessionID, ServerMsg{Type: "done"})
}

func (h *Hub) BroadcastClosing(sessionID int64, closing string) {
	h.Broadcast(sessionID, ServerMsg{Type: "closing", Content: closing})
}
