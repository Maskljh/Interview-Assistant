package ws

import (
	"context"
	"database/sql"
	"fmt"
	"net"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
	"github.com/interview-assistant/backend/internal/auth"
	"github.com/interview-assistant/backend/internal/db"
	"github.com/interview-assistant/backend/internal/interview"
	"github.com/interview-assistant/backend/internal/llm"
	"github.com/interview-assistant/backend/internal/sessionredis"
	"github.com/redis/go-redis/v9"
)

func testDB(t *testing.T) *sql.DB {
	t.Helper()
	dsn := os.Getenv("MYSQL_DSN")
	if dsn == "" {
		dsn = "root:root@tcp(127.0.0.1:3306)/interview?parseTime=true&charset=utf8mb4"
	}
	sqlDB, err := db.Open(dsn)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() {
		_, _ = sqlDB.Exec(`
			DELETE t FROM interview_turns t
			INNER JOIN interview_sessions s ON s.id = t.session_id
			INNER JOIN users u ON u.id = s.user_id
			WHERE u.email LIKE 'test-ws-%@example.com'`)
		_, _ = sqlDB.Exec(`
			DELETE q FROM interview_questions q
			INNER JOIN interview_sessions s ON s.id = q.session_id
			INNER JOIN users u ON u.id = s.user_id
			WHERE u.email LIKE 'test-ws-%@example.com'`)
		_, _ = sqlDB.Exec(`
			DELETE s FROM interview_sessions s
			INNER JOIN users u ON u.id = s.user_id
			WHERE u.email LIKE 'test-ws-%@example.com'`)
		_, _ = sqlDB.Exec("DELETE FROM users WHERE email LIKE 'test-ws-%@example.com'")
		sqlDB.Close()
	})
	return sqlDB
}

// fakeLLM echoes a valid question-generation response.
type fakeLLM struct{}

func (fakeLLM) ChatJSON(ctx context.Context, system, user string, out any) error {
	gen, ok := out.(*llm.GenQuestionsOut)
	if !ok {
		return nil
	}
	gen.Questions = make([]llm.GenQuestion, 5)
	for i := range gen.Questions {
		gen.Questions[i] = llm.GenQuestion{Seq: i + 1, Question: "Q?", Intent: "assessment"}
	}
	return nil
}

// seedInProgressSession registers a user, creates a session via svc.Create and
// starts it via svc.Start (5 questions, status ready→in_progress on BeginLive).
// Returns the session ID and a signed WS token.
func seedInProgressSession(t *testing.T, svc *interview.Service, sqlDB *sql.DB, email string) (int64, string) {
	t.Helper()
	res, err := sqlDB.Exec(`INSERT INTO users (email, password_hash) VALUES (?, 'x')`, email)
	if err != nil {
		t.Fatalf("insert user: %v", err)
	}
	uid, err := res.LastInsertId()
	if err != nil {
		t.Fatalf("last insert id: %v", err)
	}
	token, err := auth.IssueToken("test-secret", uid, email, time.Hour)
	if err != nil {
		t.Fatalf("issue token: %v", err)
	}
	session, err := svc.Create(context.Background(), uid, "Backend JD", nil, interview.ModeMixed, interview.InputModeText, "standard", nil)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if _, _, err := svc.Start(context.Background(), uid, session.ID); err != nil {
		t.Fatalf("start: %v", err)
	}
	return session.ID, token
}

// newHeartbeatTestServer mounts a ws Handler with short heartbeat values and
// returns the httptest server and the dial URL for the given session/token.
func newHeartbeatTestServer(t *testing.T, svc *interview.Service, sessionID int64, token string,
	pongWait, pingPeriod, writeWait time.Duration) (*httptest.Server, string) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	r := gin.New()
	h := &Handler{svc: svc, secret: "test-secret", hub: NewHub(),
		pongWait: pongWait, pingPeriod: pingPeriod, writeWait: writeWait}
	r.GET("/ws/interviews/:id", h.Serve)
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)
	url := "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws/interviews/" + fmt.Sprint(sessionID) + "?token=" + token
	return srv, url
}

func TestHeartbeatPingKeepsConnection(t *testing.T) {
	sqlDB := testDB(t)
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("miniredis: %v", err)
	}
	t.Cleanup(mr.Close)
	store := sessionredis.NewRedisStore(redis.NewClient(&redis.Options{Addr: mr.Addr()}))
	svc := interview.NewService(sqlDB, fakeLLM{}, store)
	sessionID, token := seedInProgressSession(t, svc, sqlDB, "test-ws-heartbeat@example.com")

	_, url := newHeartbeatTestServer(t, svc, sessionID, token, 2*time.Second, 100*time.Millisecond, time.Second)
	conn, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()

	// The client's default ping handler auto-responds with pongs, so the
	// server's read deadline keeps being extended and the connection must stay
	// alive well past pongWait. We should receive frames (ping control frames
	// are handled internally; data frames surface here) and only exit when the
	// client read deadline expires.
	conn.SetReadDeadline(time.Now().Add(1500 * time.Millisecond))
	gotFrame := false
	for {
		if _, _, err := conn.ReadMessage(); err != nil {
			break // expected: client read deadline (connection still alive)
		}
		gotFrame = true
	}
	if !gotFrame {
		t.Fatal("no frames received; connection may be dead")
	}
}

func TestHeartbeatNoPongClosesConnection(t *testing.T) {
	sqlDB := testDB(t)
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("miniredis: %v", err)
	}
	t.Cleanup(mr.Close)
	store := sessionredis.NewRedisStore(redis.NewClient(&redis.Options{Addr: mr.Addr()}))
	svc := interview.NewService(sqlDB, fakeLLM{}, store)
	sessionID, token := seedInProgressSession(t, svc, sqlDB, "test-ws-nopong@example.com")

	_, url := newHeartbeatTestServer(t, svc, sessionID, token, 300*time.Millisecond, 50*time.Millisecond, time.Second)
	conn, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()

	// Never reply to pings: override gorilla's default auto-pong handler. The
	// server's read deadline (pongWait=300ms) then expires, Serve's read loop
	// errors and defer conn.Close() closes the connection. The client should
	// observe a close/EOF error well before its own 2s read deadline.
	conn.SetPingHandler(func(string) error { return nil })
	conn.SetReadDeadline(time.Now().Add(2 * time.Second))

	closed := false
	for {
		if _, _, err := conn.ReadMessage(); err != nil {
			if ne, ok := err.(net.Error); ok && ne.Timeout() {
				t.Fatalf("client read deadline expired (%v); server never closed the dead connection", err)
			}
			closed = true
			break
		}
	}
	if !closed {
		t.Fatal("no read error observed; connection was not closed by the server")
	}
}
