package ws

import (
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
	"github.com/interview-assistant/backend/internal/auth"
	"github.com/interview-assistant/backend/internal/interview"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

// Default heartbeat deadlines; tests may override via Handler fields.
const (
	defaultPongWait   = 60 * time.Second
	defaultPingPeriod = 30 * time.Second
	defaultWriteWait  = 10 * time.Second
)

type Handler struct {
	svc    *interview.Service
	secret string
	hub    *Hub

	pongWait   time.Duration
	pingPeriod time.Duration
	writeWait  time.Duration
}

func RegisterRoutes(r *gin.Engine, svc *interview.Service, secret string) {
	h := &Handler{
		svc:        svc,
		secret:     secret,
		hub:        NewHub(),
		pongWait:   defaultPongWait,
		pingPeriod: defaultPingPeriod,
		writeWait:  defaultWriteWait,
	}
	svc.SetSessionNotifier(h.hub)
	r.GET("/ws/interviews/:id", h.Serve)
}

func (h *Handler) Serve(c *gin.Context) {
	token := c.Query("token")
	if token == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "missing token"})
		return
	}
	userID, _, err := auth.ParseToken(h.secret, token)
	if err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid token"})
		return
	}
	sessionID, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid id"})
		return
	}

	conn, err := upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		return
	}
	defer conn.Close()

	h.hub.Register(sessionID, conn)
	defer h.hub.Unregister(sessionID, conn)

	ctx := c.Request.Context()

	// Heartbeat: ping every pingPeriod; a dead peer (no pong within pongWait)
	// fails the read deadline, closing the connection and notifying the client.
	conn.SetReadDeadline(time.Now().Add(h.pongWait))
	conn.SetPongHandler(func(string) error {
		return conn.SetReadDeadline(time.Now().Add(h.pongWait))
	})

	go func() {
		ticker := time.NewTicker(h.pingPeriod)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				if err := conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(h.writeWait)); err != nil {
					return
				}
			case <-ctx.Done():
				return
			}
		}
	}()

	msgs, err := h.svc.BeginLive(ctx, userID, sessionID)
	if err != nil {
		_ = writeJSON(conn, ServerMsg{Type: "status", Content: err.Error()})
		return
	}
	for _, m := range msgs {
		if err := writeJSON(conn, toServerMsg(m)); err != nil {
			return
		}
	}

	for {
		var clientMsg ClientMsg
		if err := conn.ReadJSON(&clientMsg); err != nil {
			return
		}
		if clientMsg.Type != "answer" {
			continue
		}
		answerMsgs, err := h.svc.HandleAnswer(ctx, userID, sessionID, clientMsg.Content, clientMsg.VoiceDurationMs)
		if err != nil {
			_ = writeJSON(conn, ServerMsg{Type: "status", Content: err.Error()})
			continue
		}
		for _, m := range answerMsgs {
			if err := writeJSON(conn, toServerMsg(m)); err != nil {
				return
			}
		}
	}
}

func toServerMsg(m interview.OutboundMessage) ServerMsg {
	msg := ServerMsg{Type: m.Type, Content: m.Content}
	if m.Progress != nil {
		msg.Progress = &struct {
			Current int `json:"current"`
			Total   int `json:"total"`
		}{Current: m.Progress.Current, Total: m.Progress.Total}
	}
	return msg
}
