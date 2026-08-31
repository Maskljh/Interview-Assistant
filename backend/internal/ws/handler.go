package ws

import (
	"errors"
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
		// 会话不可进入/不存在属于致命错误：类型化为 error，前端据此停止重连并友好提示。
		code := "error"
		if errors.Is(err, interview.ErrNotFound) {
			code = "not_found"
		} else if errors.Is(err, interview.ErrInvalidState) {
			code = "invalid_state"
		}
		_ = writeJSON(conn, ServerMsg{Type: "error", Code: code, Content: userFacingWSStatus(err)})
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
		switch clientMsg.Type {
		case "answer":
			answerMsgs, err := h.svc.HandleAnswer(ctx, userID, sessionID, clientMsg.Content, clientMsg.VoiceDurationMs)
			if err != nil {
				_ = writeJSON(conn, ServerMsg{Type: "status", Content: userFacingWSStatus(err)})
				continue
			}
			for _, m := range answerMsgs {
				if err := writeJSON(conn, toServerMsg(m)); err != nil {
					return
				}
			}
		case "skip_question":
			skipMsgs, err := h.svc.SkipQuestion(ctx, userID, sessionID)
			if err != nil {
				_ = writeJSON(conn, ServerMsg{Type: "status", Content: userFacingWSStatus(err)})
				continue
			}
			for _, m := range skipMsgs {
				if err := writeJSON(conn, toServerMsg(m)); err != nil {
					return
				}
			}
		default:
			continue
		}
	}
}

// userFacingWSStatus 把服务端错误映射为面向用户的中文提示，避免把内部错误原文透传给客户端。
func userFacingWSStatus(err error) string {
	switch {
	case errors.Is(err, interview.ErrNotFound):
		return "面试不存在或已结束，请刷新页面"
	case errors.Is(err, interview.ErrInvalidState):
		return "面试状态已变化，请刷新后重试"
	case errors.Is(err, interview.ErrLLMFailure):
		return "AI 思考出错了，请稍后重试或跳过本问题"
	default:
		return "发生错误，请稍后重试"
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
