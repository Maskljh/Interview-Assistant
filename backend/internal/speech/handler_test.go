package speech_test

import (
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/interview-assistant/backend/internal/auth"
	"github.com/interview-assistant/backend/internal/speech"
)

func testRouter(client speech.Client) *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	speech.RegisterRoutes(r, "test-secret", client)
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

func TestASRReturnsText(t *testing.T) {
	r := testRouter(speech.NewFakeClient())
	var body bytes.Buffer
	w := multipart.NewWriter(&body)
	part, err := w.CreateFormFile("audio", "answer.pcm")
	if err != nil {
		t.Fatalf("create form file: %v", err)
	}
	_, _ = part.Write([]byte{0x00, 0x01, 0x02})
	if err := w.Close(); err != nil {
		t.Fatalf("close multipart: %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/api/speech/asr", &body)
	req.Header.Set("Content-Type", w.FormDataContentType())
	req.Header.Set("Authorization", authHeader(t))
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var resp struct {
		Text string `json:"text"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp.Text != "你好" {
		t.Fatalf("text = %q, want 你好", resp.Text)
	}
}

func TestASREmptyAudio400(t *testing.T) {
	r := testRouter(speech.NewFakeClient())
	var body bytes.Buffer
	w := multipart.NewWriter(&body)
	if _, err := w.CreateFormFile("audio", "empty.pcm"); err != nil {
		t.Fatalf("create form file: %v", err)
	}
	if err := w.Close(); err != nil {
		t.Fatalf("close multipart: %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/api/speech/asr", &body)
	req.Header.Set("Content-Type", w.FormDataContentType())
	req.Header.Set("Authorization", authHeader(t))
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400, body = %s", rec.Code, rec.Body.String())
	}
}

func TestTTSReturnsMPEG(t *testing.T) {
	r := testRouter(speech.NewFakeClient())
	payload, _ := json.Marshal(map[string]string{"text": "请介绍一下你自己"})
	req := httptest.NewRequest(http.MethodPost, "/api/speech/tts", bytes.NewReader(payload))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", authHeader(t))
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if rec.Header().Get("Content-Type") != "audio/mpeg" {
		t.Fatalf("Content-Type = %q, want audio/mpeg", rec.Header().Get("Content-Type"))
	}
	if rec.Body.Len() == 0 {
		t.Fatal("TTS body is empty")
	}
}

func TestTTSEmptyText400(t *testing.T) {
	r := testRouter(speech.NewFakeClient())
	payload, _ := json.Marshal(map[string]string{"text": ""})
	req := httptest.NewRequest(http.MethodPost, "/api/speech/tts", bytes.NewReader(payload))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", authHeader(t))
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400, body = %s", rec.Code, rec.Body.String())
	}
}

func TestSpeechUnavailable502(t *testing.T) {
	r := testRouter(nil)
	payload, _ := json.Marshal(map[string]string{"text": "hello"})
	req := httptest.NewRequest(http.MethodPost, "/api/speech/tts", bytes.NewReader(payload))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", authHeader(t))
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502, body = %s", rec.Code, rec.Body.String())
	}
	var resp struct {
		Error string `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp.Error != "speech service unavailable" {
		t.Fatalf("error = %q, want speech service unavailable", resp.Error)
	}
}
