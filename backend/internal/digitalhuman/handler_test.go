package digitalhuman_test

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
	"github.com/interview-assistant/backend/internal/digitalhuman"
)

type fakeProvider struct {
	submitTaskID string
	submitErr    error
	resultStatus digitalhuman.Status
	resultURL    string
	resultErr    error
}

func (f *fakeProvider) Submit(ctx context.Context, text string) (string, error) {
	return f.submitTaskID, f.submitErr
}

func (f *fakeProvider) Result(ctx context.Context, taskID string) (digitalhuman.Status, string, error) {
	return f.resultStatus, f.resultURL, f.resultErr
}

func testRouter(p digitalhuman.Provider) *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	digitalhuman.RegisterRoutes(r, "test-secret", p)
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

func postVideo(t *testing.T, r *gin.Engine, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/digital-human/videos", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", authHeader(t))
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	return rec
}

func getVideo(t *testing.T, r *gin.Engine, taskID string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/digital-human/videos/"+taskID, nil)
	req.Header.Set("Authorization", authHeader(t))
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	return rec
}

func TestSubmitUnavailableWhenProviderNil(t *testing.T) {
	rec := postVideo(t, testRouter(nil), `{"text":"请介绍一下你自己"}`)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
}

func TestSubmitReturnsTaskID(t *testing.T) {
	r := testRouter(&fakeProvider{submitTaskID: "task-1"})
	rec := postVideo(t, r, `{"text":"请介绍一下你自己"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var resp struct {
		TaskID string `json:"taskId"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp.TaskID != "task-1" {
		t.Fatalf("taskId = %q, want task-1", resp.TaskID)
	}
}

func TestSubmitRejectsEmptyText(t *testing.T) {
	rec := postVideo(t, testRouter(&fakeProvider{submitTaskID: "task-1"}), `{"text":""}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
}

func TestSubmitProviderError(t *testing.T) {
	r := testRouter(&fakeProvider{submitErr: errors.New("vendor down")})
	rec := postVideo(t, r, `{"text":"请介绍一下你自己"}`)
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
}

func TestResultCompleted(t *testing.T) {
	r := testRouter(&fakeProvider{resultStatus: digitalhuman.StatusCompleted, resultURL: "https://cdn.example.com/v.mp4"})
	rec := getVideo(t, r, "task-1")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var resp struct {
		Status   string `json:"status"`
		VideoURL string `json:"videoURL"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp.Status != "completed" || resp.VideoURL != "https://cdn.example.com/v.mp4" {
		t.Fatalf("got status=%q videoURL=%q", resp.Status, resp.VideoURL)
	}
}

func TestResultPending(t *testing.T) {
	r := testRouter(&fakeProvider{resultStatus: digitalhuman.StatusPending})
	rec := getVideo(t, r, "task-1")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if !bytes.Contains(rec.Body.Bytes(), []byte(`"status":"pending"`)) {
		t.Fatalf("body = %s, want status pending", rec.Body.String())
	}
	if bytes.Contains(rec.Body.Bytes(), []byte("videoURL")) {
		t.Fatalf("body = %s, pending 不应带 videoURL", rec.Body.String())
	}
}

func TestResultFailedOmitsVideoURL(t *testing.T) {
	r := testRouter(&fakeProvider{resultStatus: digitalhuman.StatusFailed, resultURL: "https://cdn.example.com/v.mp4"})
	rec := getVideo(t, r, "task-1")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if !bytes.Contains(rec.Body.Bytes(), []byte(`"status":"failed"`)) {
		t.Fatalf("body = %s, want status failed", rec.Body.String())
	}
	if bytes.Contains(rec.Body.Bytes(), []byte("videoURL")) {
		t.Fatalf("body = %s, failed 状态不应带 videoURL", rec.Body.String())
	}
}

func TestResultUnavailableWhenProviderNil(t *testing.T) {
	rec := getVideo(t, testRouter(nil), "task-1")
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
}

func TestUnauthorized(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/api/digital-human/videos", bytes.NewBufferString(`{"text":"x"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	testRouter(nil).ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
}
