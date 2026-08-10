package ws

import (
	"sync"

	"github.com/gorilla/websocket"
)

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
