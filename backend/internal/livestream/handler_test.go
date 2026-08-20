package livestream_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/interview-assistant/backend/internal/auth"
	"github.com/interview-assistant/backend/internal/livestream"
)

type fakeSession struct {
	streamURL string
	speakErr  error
	closed    bool
}

func (f *fakeSession) StreamURL() string { return f.streamURL }
func (f *fakeSession) Speak(ctx context.Context, text string) error { return f.speakErr }
func (f *fakeSession) Close() error { f.closed = true; return nil }

type fakeProvider struct {
	session  livestream.Session
	startErr error
}

func (f *fakeProvider) StartSession(ctx context.Context, avatarID string) (livestream.Session, error) {
	return f.session, f.startErr
}

func (f *fakeProvider) CloseSession(ctx context.Context, sessionID string) error {
	return nil
}

func testRouter(p livestream.Provider) *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	livestream.RegisterRoutes(r, "test-secret", p, &livestream.Config{
		APIKey:   "test-appkey",
		Secret:   "test-token",
		AvatarID: "test-project",
	})
	return r
}

func authHeader(t *testing.T) string {
	t.Helper()
	token, err := auth.IssueToken("test-secret", 1, "test@example.com", time.Hour)
	if err != nil {
		t.Fatalf("issue token: %v", err)
	}
	return "Bearer " + token
}

func postSession(t *testing.T, r *gin.Engine) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/livestream/sessions", bytes.NewBufferString(`{}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", authHeader(t))
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	return rec
}

func createAndGetID(t *testing.T, r *gin.Engine) string {
	t.Helper()
	rec := postSession(t, r)
	if rec.Code != http.StatusOK {
		t.Fatalf("create status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var resp struct {
		SessionID string `json:"sessionId"`
		StreamURL string `json:"streamURL"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.SessionID == "" || resp.StreamURL == "" {
		t.Fatalf("sessionId=%q streamURL=%q, both must be non-empty", resp.SessionID, resp.StreamURL)
	}
	return resp.SessionID
}

func postSpeak(t *testing.T, r *gin.Engine, id, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/livestream/sessions/"+id+"/speak", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", authHeader(t))
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	return rec
}

func postClose(t *testing.T, r *gin.Engine, id string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/livestream/sessions/"+id+"/close", nil)
	req.Header.Set("Authorization", authHeader(t))
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	return rec
}

func TestCreateUnavailableWhenProviderNil(t *testing.T) {
	rec := postSession(t, testRouter(nil))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
}

func TestCreateProviderError(t *testing.T) {
	r := testRouter(&fakeProvider{startErr: errors.New("vendor down")})
	rec := postSession(t, r)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
}

func TestCreateReturnsSession(t *testing.T) {
	r := testRouter(&fakeProvider{session: &fakeSession{streamURL: "https://example.com/stream.mp4"}})
	createAndGetID(t, r) // 内含 200 + 非空校验
}

func TestSpeakOK(t *testing.T) {
	r := testRouter(&fakeProvider{session: &fakeSession{streamURL: "https://example.com/stream.mp4"}})
	id := createAndGetID(t, r)
	rec := postSpeak(t, r, id, `{"text":"请介绍一下你自己"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
}

func TestSpeakEmptyText(t *testing.T) {
	r := testRouter(&fakeProvider{session: &fakeSession{streamURL: "https://example.com/stream.mp4"}})
	id := createAndGetID(t, r)
	rec := postSpeak(t, r, id, `{"text":"  "}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
}

func TestSpeakUnknownSession(t *testing.T) {
	r := testRouter(&fakeProvider{session: &fakeSession{streamURL: "https://example.com/stream.mp4"}})
	rec := postSpeak(t, r, "does-not-exist", `{"text":"hi"}`)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
}

func TestSpeakProviderError(t *testing.T) {
	r := testRouter(&fakeProvider{session: &fakeSession{streamURL: "https://example.com/stream.mp4", speakErr: errors.New("speak down")}})
	id := createAndGetID(t, r)
	rec := postSpeak(t, r, id, `{"text":"hi"}`)
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
}

func TestCloseRemovesSession(t *testing.T) {
	r := testRouter(&fakeProvider{session: &fakeSession{streamURL: "https://example.com/stream.mp4"}})
	id := createAndGetID(t, r)
	if rec := postClose(t, r, id); rec.Code != http.StatusOK {
		t.Fatalf("close status = %d, body = %s", rec.Code, rec.Body.String())
	}
	rec := postSpeak(t, r, id, `{"text":"hi"}`)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("speak after close = %d, want 404", rec.Code)
	}
}

func TestUnauthorized(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/api/livestream/sessions", bytes.NewBufferString(`{}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	testRouter(nil).ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
}

func TestSignReturnsCredentials(t *testing.T) {
	r := testRouter(&fakeProvider{session: &fakeSession{streamURL: "https://example.com/stream.mp4"}})
	req := httptest.NewRequest(http.MethodGet, "/api/livestream/sign", nil)
	req.Header.Set("Authorization", authHeader(t))
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var resp struct {
		AppKey            string `json:"appkey"`
		Timestamp         string `json:"timestamp"`
		Signature         string `json:"signature"`
		VirtualmanProject string `json:"virtualmanProjectId"`
		UserID            string `json:"userId"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.AppKey == "" || resp.Timestamp == "" || resp.Signature == "" {
		t.Fatalf("credentials must be non-empty: %+v", resp)
	}
	if resp.VirtualmanProject == "" || resp.UserID == "" {
		t.Fatalf("projectId/userId must be non-empty: %+v", resp)
	}
}
