package ocr_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/interview-assistant/backend/internal/ocr"
)

func TestRecognize(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// 校验签名查询参数存在
		if r.URL.Query().Get("Action") != "RecognizeGeneral" {
			t.Fatalf("Action = %q, want RecognizeGeneral", r.URL.Query().Get("Action"))
		}
		if r.URL.Query().Get("Version") != "2021-07-07" {
			t.Fatalf("Version = %q, want 2021-07-07", r.URL.Query().Get("Version"))
		}
		if r.URL.Query().Get("Signature") == "" {
			t.Fatal("expected Signature query param")
		}
		var req struct {
			Body string `json:"body"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Fatalf("decode request body: %v", err)
		}
		if req.Body == "" {
			t.Fatal("expected base64 image body")
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"code":"200","data":{"wordsResult":[{"words":"面试题一"},{"words":"面试题二"}]}}`))
	}))
	defer srv.Close()

	c, err := ocr.NewClient(ocr.Config{
		AccessKeyID:     "ak",
		AccessKeySecret: "sk",
		Endpoint:        srv.URL,
	})
	if err != nil {
		t.Fatalf("new client: %v", err)
	}
	text, err := c.Recognize(context.Background(), []byte("fake-image-bytes"))
	if err != nil {
		t.Fatalf("recognize: %v", err)
	}
	if text != "面试题一\n面试题二" {
		t.Fatalf("text = %q, want 面试题一\\n面试题二", text)
	}
}

func TestNewClientRequiresCredentials(t *testing.T) {
	if _, err := ocr.NewClient(ocr.Config{}); err == nil {
		t.Fatal("expected error when credentials missing")
	}
}
