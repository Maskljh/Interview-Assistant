package ocr_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/interview-assistant/backend/internal/auth"
	"github.com/interview-assistant/backend/internal/ocr"
)

// fakeClient returns a fixed text; implements ocr.Client.
type fakeClient struct{}

func (f *fakeClient) Recognize(ctx context.Context, image []byte) (string, error) {
	return "识别出的 JD 文本", nil
}

// errClient fails recognition; implements ocr.Client.
type errClient struct{}

func (e *errClient) Recognize(ctx context.Context, image []byte) (string, error) {
	return "", fmt.Errorf("recognize failed")
}

// A valid 1x1 PNG (detected by http.DetectContentType as image/png).
const validPNG = "\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\nIDATx\x9cc\x00\x01\x00\x00\x05\x00\x01\r\n\x2d\xb4\x00\x00\x00\x00IEND\xaeB`\x82"

func testRouter(t *testing.T, client ocr.Client) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	r := gin.New()
	ocr.RegisterRoutes(r, "test-secret", client)
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

func newMultipartImage(t *testing.T, content []byte) (*bytes.Buffer, string) {
	t.Helper()
	var body bytes.Buffer
	w := multipart.NewWriter(&body)
	part, err := w.CreateFormFile("file", "jd.png")
	if err != nil {
		t.Fatalf("create form file: %v", err)
	}
	if _, err := part.Write(content); err != nil {
		t.Fatalf("write form file: %v", err)
	}
	if err := w.Close(); err != nil {
		t.Fatalf("close multipart: %v", err)
	}
	return &body, w.FormDataContentType()
}

func doRecognize(t *testing.T, r *gin.Engine, content []byte) *httptest.ResponseRecorder {
	t.Helper()
	body, contentType := newMultipartImage(t, content)
	req := httptest.NewRequest(http.MethodPost, "/api/ocr/recognize", body)
	req.Header.Set("Content-Type", contentType)
	req.Header.Set("Authorization", authHeader(t))
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	return rec
}

func TestRecognizeImageReturnsText(t *testing.T) {
	r := testRouter(t, &fakeClient{})
	rec := doRecognize(t, r, []byte(validPNG))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200, body = %s", rec.Code, rec.Body.String())
	}
	var resp struct {
		Text string `json:"text"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp.Text != "识别出的 JD 文本" {
		t.Fatalf("text = %q, want %q", resp.Text, "识别出的 JD 文本")
	}
}

func TestRecognizeNilClientReturns502(t *testing.T) {
	r := testRouter(t, nil)
	rec := doRecognize(t, r, []byte(validPNG))

	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502, body = %s", rec.Code, rec.Body.String())
	}
	var resp struct {
		Error string `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp.Error != "image recognition unavailable, please use text input" {
		t.Fatalf("error = %q, want image recognition unavailable, please use text input", resp.Error)
	}
}

func TestRecognizeClientErrorReturns502(t *testing.T) {
	r := testRouter(t, &errClient{})
	rec := doRecognize(t, r, []byte(validPNG))

	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502, body = %s", rec.Code, rec.Body.String())
	}
	var resp struct {
		Error string `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp.Error != "image recognition unavailable, please use text input" {
		t.Fatalf("error = %q, want image recognition unavailable, please use text input", resp.Error)
	}
}

func TestRecognizeOversizedReturns400(t *testing.T) {
	r := testRouter(t, &fakeClient{})
	// JPEG header so the file would pass MIME validation if it ever reached the
	// type check; the size check (maxImageBytes = 5<<20) must reject it first.
	content := append([]byte("\xff\xd8\xff\xe0"), bytes.Repeat([]byte{0x00}, 5<<20+1)...)
	rec := doRecognize(t, r, content)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400, body = %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "image is too large") {
		t.Fatalf("body = %s, want image is too large", rec.Body.String())
	}
}

func TestRecognizeNonImageReturns400(t *testing.T) {
	r := testRouter(t, &fakeClient{})
	rec := doRecognize(t, r, []byte("plain text, not an image"))

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400, body = %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "unsupported image type") {
		t.Fatalf("body = %s, want unsupported image type", rec.Body.String())
	}
}

func TestRecognizeMissingFileReturns400(t *testing.T) {
	r := testRouter(t, &fakeClient{})

	var body bytes.Buffer
	w := multipart.NewWriter(&body)
	if err := w.Close(); err != nil {
		t.Fatalf("close multipart: %v", err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/ocr/recognize", &body)
	req.Header.Set("Content-Type", w.FormDataContentType())
	req.Header.Set("Authorization", authHeader(t))
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400, body = %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "file is required") {
		t.Fatalf("body = %s, want file is required", rec.Body.String())
	}
}
