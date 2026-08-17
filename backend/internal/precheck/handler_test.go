package precheck_test

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
	"github.com/interview-assistant/backend/internal/precheck"
)

type fakeLLM struct {
	out string
	err error
}

func (f *fakeLLM) ChatJSON(ctx context.Context, system, user string, out any) error {
	if f.err != nil {
		return f.err
	}
	return json.Unmarshal([]byte(f.out), out)
}

func testRouter(llmClient *fakeLLM) *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	precheck.RegisterRoutes(r, llmClient, "test-secret")
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

func postPrecheck(t *testing.T, r *gin.Engine, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/precheck", bytes.NewReader([]byte(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", authHeader(t))
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func TestPrecheckReturnsMatch(t *testing.T) {
	r := testRouter(&fakeLLM{out: `{"match_score":72,"gaps":["缺少K8s经验"],"suggestions":["补K8s项目"]}`})
	w := postPrecheck(t, r, `{"job_jd":"Backend engineer","resume_text":"Go, SQL"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", w.Code, w.Body.String())
	}
	var out precheck.PreCheckOut
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if out.MatchScore != 72 || len(out.Gaps) != 1 || out.Gaps[0] != "缺少K8s经验" {
		t.Fatalf("out = %+v", out)
	}
}

func TestPrecheckMissingJDFails(t *testing.T) {
	r := testRouter(&fakeLLM{out: `{}`})
	w := postPrecheck(t, r, `{"job_jd":""}`)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", w.Code)
	}
}

func TestPrecheckLLMFailureReturns502(t *testing.T) {
	r := testRouter(&fakeLLM{err: errors.New("boom")})
	w := postPrecheck(t, r, `{"job_jd":"Backend engineer"}`)
	if w.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502", w.Code)
	}
}
