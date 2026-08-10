package ws

import (
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
	"github.com/interview-assistant/backend/internal/auth"
	"github.com/interview-assistant/backend/internal/interview"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

type Handler struct {
	svc    *interview.Service
	secret string
	hub    *Hub
}

func RegisterRoutes(r *gin.Engine, svc *interview.Service, secret string) {
	h := &Handler{svc: svc, secret: secret, hub: NewHub()}
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
	msgs, err := h.svc.BeginLive(ctx, userID, sessionID)
	if err != nil {
		_ = conn.WriteJSON(ServerMsg{Type: "status", Content: err.Error()})
		return
	}
	for _, m := range msgs {
		if err := conn.WriteJSON(toServerMsg(m)); err != nil {
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
		answerMsgs, err := h.svc.HandleAnswer(ctx, userID, sessionID, clientMsg.Content)
		if err != nil {
			_ = conn.WriteJSON(ServerMsg{Type: "status", Content: err.Error()})
			continue
		}
		for _, m := range answerMsgs {
			if err := conn.WriteJSON(toServerMsg(m)); err != nil {
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
