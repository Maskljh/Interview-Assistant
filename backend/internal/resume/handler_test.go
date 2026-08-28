package resume_test

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/interview-assistant/backend/internal/db"
	"github.com/interview-assistant/backend/internal/resume"
	"github.com/interview-assistant/backend/internal/auth"
)

func testDB(t *testing.T) *sql.DB {
	t.Helper()
	dsn := os.Getenv("MYSQL_DSN")
	if dsn == "" {
		dsn = "root:123456@tcp(127.0.0.1:3306)/interview?parseTime=true&charset=utf8mb4"
	}
	sqlDB, err := db.Open(dsn)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() {
		_, _ = sqlDB.Exec(`
			DELETE r FROM resume_files r
			INNER JOIN users u ON u.id = r.user_id
			WHERE u.email LIKE 'test-resume-%@example.com'`)
		_, _ = sqlDB.Exec("DELETE FROM users WHERE email LIKE 'test-resume-%@example.com'")
		sqlDB.Close()
	})
	return sqlDB
}

type fakeUploader struct{}

func (fakeUploader) Upload(userID int64, kind, filename, contentType string, r io.Reader, size int64) (string, string, error) {
	return "resume/" + filename, "/api/uploads/object?key=resume/" + filename, nil
}

func newRouter(t *testing.T, sqlDB *sql.DB) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	r := gin.New()
	secret := "test-secret"

	resume.RegisterRoutes(r, sqlDB, secret, fakeUploader{})
	return r
}

// register inserts a user directly and returns an app JWT for that user
// (email/password auth was removed in favor of WPS OAuth).
func register(t *testing.T, sqlDB *sql.DB, email string) string {
	t.Helper()
	secret := "test-secret"
	res, err := sqlDB.Exec(
		"INSERT INTO users (email, password_hash, username) VALUES (?, 'not-a-real-hash', ?)",
		email, "测试用户",
	)
	if err != nil {
		t.Fatalf("insert user %s: %v", email, err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		t.Fatalf("last insert id: %v", err)
	}
	token, err := auth.IssueToken(secret, id, email, time.Hour)
	if err != nil {
		t.Fatalf("issue token: %v", err)
	}
	return token
}

func uploadResume(t *testing.T, r *gin.Engine, token, filename, text string) map[string]any {
	t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	fw, _ := mw.CreateFormFile("file", filename)
	_, _ = fw.Write([]byte("%PDF-1.4 fake content"))
	_ = mw.WriteField("text", text)
	_ = mw.Close()

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/resumes", &buf)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	req.Header.Set("Authorization", "Bearer "+token)
	r.ServeHTTP(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("upload status = %d, body = %s", w.Code, w.Body.String())
	}
	var resp map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode upload: %v", err)
	}
	return resp
}

func TestResumeUploadListRenameDelete(t *testing.T) {
	sqlDB := testDB(t)
	r := newRouter(t, sqlDB)
	token := register(t, sqlDB, "test-resume-flow@example.com")

	// 上传
	item := uploadResume(t, r, token, "产品经理简历.pdf", "候选人：张三，3 年增长经验")
	if item["name"] != "产品经理简历.pdf" {
		t.Fatalf("name = %v", item["name"])
	}
	if item["resume_text"] != "候选人：张三，3 年增长经验" {
		t.Fatalf("resume_text = %v", item["resume_text"])
	}
	id := int64(item["id"].(float64))

	// 列表
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/resumes", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("list status = %d", w.Code)
	}
	var list struct {
		Items []map[string]any `json:"items"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &list); err != nil {
		t.Fatalf("decode list: %v", err)
	}
	if len(list.Items) != 1 {
		t.Fatalf("items = %d, want 1", len(list.Items))
	}

	// 重命名
	rb, _ := json.Marshal(map[string]string{"name": "张三-更新版.pdf"})
	w = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPatch, fmt.Sprintf("/api/resumes/%d", id), bytes.NewReader(rb))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("rename status = %d, body = %s", w.Code, w.Body.String())
	}

	// 删除
	w = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodDelete, fmt.Sprintf("/api/resumes/%d", id), nil)
	req.Header.Set("Authorization", "Bearer "+token)
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("delete status = %d, body = %s", w.Code, w.Body.String())
	}

	w = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/api/resumes", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	r.ServeHTTP(w, req)
	var empty struct {
		Items []map[string]any `json:"items"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &empty)
	if len(empty.Items) != 0 {
		t.Fatalf("items after delete = %d, want 0", len(empty.Items))
	}
}

func TestResumeLimitFive(t *testing.T) {
	sqlDB := testDB(t)
	r := newRouter(t, sqlDB)
	token := register(t, sqlDB, "test-resume-limit@example.com")

	for i := 1; i <= 5; i++ {
		uploadResume(t, r, token, fmt.Sprintf("简历%d.pdf", i), fmt.Sprintf("文本%d", i))
	}

	// 第 6 份应被拒绝
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	fw, _ := mw.CreateFormFile("file", "简历6.pdf")
	_, _ = fw.Write([]byte("x"))
	_ = mw.WriteField("text", "文本6")
	_ = mw.Close()
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/resumes", &buf)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	req.Header.Set("Authorization", "Bearer "+token)
	r.ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("6th upload status = %d, want 400; body = %s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "5") {
		t.Fatalf("limit error should mention 5, got %s", w.Body.String())
	}
}

func TestResumeUploadRejectsOver10MB(t *testing.T) {
	sqlDB := testDB(t)
	r := newRouter(t, sqlDB)
	token := register(t, sqlDB, "test-resume-big@example.com")

	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	fw, _ := mw.CreateFormFile("file", "big-resume.pdf")
	// 11MB 内容，超过 10MB 上限
	_, _ = fw.Write(bytes.Repeat([]byte("A"), 11*1024*1024))
	_ = mw.WriteField("text", "big resume")
	_ = mw.Close()

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/resumes", &buf)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	req.Header.Set("Authorization", "Bearer "+token)
	r.ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("oversize upload status = %d, want 400, body = %s", w.Code, w.Body.String())
	}
}
