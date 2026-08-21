# 真实面经 / 题目导入（OCR / 图片）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 支持用户把真实面经/题目（文本粘贴或图片 OCR）导入私有题库，来源标记 `source='import'`，自动打四维标签，与 `source='interview'` 并存。

**Architecture:** 三段式后端流程：文本/图片 → OCR（阿里云，仅图片）→ LLM 解析出候选题目 → 前端可编辑确认 → `confirm` 入库（`source='import'`、`job_tag` 手动、去重跳过）→ 复用现有 `classifyAsync` 打四维标签。前端在题库页加「导入题目」模态框（输入 → 解析结果 → 确认），`source='import'` 的题目进「独立题目」分组并展示「导入」来源标记。

**Tech Stack:** Go 1.24 + Gin + MySQL（后端）；React 19 + TypeScript + Vite 8 + vitest/jsdom（前端）；DeepSeek LLM（解析与分类）；阿里云 OCR（图片识别，RPC 签名复用 `speech/popSignature` 模式）。

## Global Constraints

- 零改动现有「从面试会话导入」链路（`ImportFromSession`、`InsertBatch` 的 `'interview'` 行为不变）。
- `source` 新取值仅 `'import'`；`source_session_id` 必须为 NULL；`job_tag` 手动透传（可空）。
- 前端用户可见文案精确：`导入题目`、`新增 X 题，跳过 Y 题重复`、`图片识别失败，请改用文本粘贴`、`独立题目`（已有）、`导入`（来源标记）。
- 四维标签只走现有 `classifyAsync`（LLM 自动分类，失败降级 NULL），不做手动维度编辑 UI。
- 图片大小 ≤ 5MB，类型仅 `image/jpeg` / `image/png` / `image/webp`。
- 解析失败降级：返回原文 `raw`，前端进入手动编辑模式；入库照常可用（用户手写题目）。
- 提交信息遵循仓库习惯（`feat(question-bank|import|ocr): ...`）。
- 每个任务须通过对应测试：后端 `go test ./...`、前端 `npm test`；前端任务另须 `npx tsc --noEmit -p tsconfig.app.json`。

---

### Task 1: LLM 解析提示词（后端 `internal/llm`）

**Files:**
- Modify: `backend/internal/llm/prompts.go`
- Test: `backend/internal/llm/prompts_test.go`

**Interfaces:**
- Produces:
  - `type ParseImportOut struct { Items []struct { Question string \`json:"question"\`; Answer string \`json:"answer,omitempty"\` } \`json:"items"\` }`
  - `func ParseImportSystem() string`
  - `func ParseImportUser(text string) string`

- [ ] **Step 1: 写失败测试**

`backend/internal/llm/prompts_test.go`（追加到现有测试）：

```go
func TestParseImportSystem(t *testing.T) {
	s := ParseImportSystem()
	if !strings.Contains(s, "JSON") || !strings.Contains(s, "items") {
		t.Fatalf("ParseImportSystem should instruct JSON output with items, got: %s", s)
	}
	if strings.Contains(s, "expression") || strings.Contains(s, "logic") {
		t.Fatalf("ParseImportSystem should not mention dimension classification, got: %s", s)
	}
}

func TestParseImportUser(t *testing.T) {
	u := ParseImportUser("第一题：请介绍你自己。\n答案：我是……")
	if !strings.Contains(u, "第一题") {
		t.Fatalf("ParseImportUser should embed the source text, got: %s", u)
	}
}
```

（`strings` 已由现有测试导入；若未导入，在文件头补 `"strings"`。）

- [ ] **Step 2: 运行测试确认失败**

Run: `cd backend && go test ./internal/llm/ -run 'TestParseImport' -v`
Expected: FAIL（`ParseImportSystem`/`ParseImportUser` 未定义）

- [ ] **Step 3: 写最小实现**

在 `backend/internal/llm/prompts.go` 末尾追加：

```go
type ParseImportOut struct {
	Items []struct {
		Question string `json:"question"`
		Answer   string `json:"answer,omitempty"`
	} `json:"items"`
}

// ParseImportSystem instructs the model to extract interview questions from a
// real interview transcript (面经). It only extracts; dimension classification
// is a separate later step.
func ParseImportSystem() string {
	return `You are an interview coach. Extract the interview questions from the provided real interview transcript (面经).

Respond with valid JSON only, no markdown fences or extra text. Use this exact schema:
{"items":[{"question":"...","answer":"..."}]}

Rules:
- Extract each interview question asked to the candidate, including follow-ups
- question must be the complete, self-contained question text, verbatim from the source
- answer is optional; include the candidate's answer to that question when present, otherwise omit it
- Skip narrative noise, headings, timestamps, and non-question content
- Do not invent questions that are not in the source
- All question and answer text must be written in Chinese (Simplified) unless the source itself is in another language`
}

// ParseImportUser builds the user prompt with the source text to parse.
func ParseImportUser(text string) string {
	return fmt.Sprintf("Extract the interview questions from this real interview transcript (面经).\n\nSource:\n%s", text)
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd backend && go test ./internal/llm/ -run 'TestParseImport' -v`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add backend/internal/llm/prompts.go backend/internal/llm/prompts_test.go
git commit -m "feat(llm): add ParseImportSystem/User prompts for transcript question extraction"
```

---

### Task 2: 数据库迁移 `011_question_import.sql`

**Files:**
- Create: `backend/migrations/011_question_import.sql`

**Interfaces:**
- Produces: `question_bank.reference TEXT NULL` 列（`source='import'` 时可能非空，存题目原文出处）

- [ ] **Step 1: 写迁移文件**

`backend/migrations/011_question_import.sql`:

```sql
ALTER TABLE question_bank
  ADD COLUMN reference TEXT NULL AFTER user_answer;
```

- [ ] **Step 2: 应用迁移**

```bash
docker compose exec -T mysql mysql -uroot -proot interview < backend/migrations/011_question_import.sql
```

（若用外部 MySQL，用对应客户端执行同一文件。）

- [ ] **Step 3: 验证列存在**

```bash
docker compose exec -T mysql mysql -uroot -proot interview -e "SHOW COLUMNS FROM question_bank LIKE 'reference';"
```
Expected: 一行 `reference | text | YES | (NULL) |`

- [ ] **Step 4: 提交**

```bash
git add backend/migrations/011_question_import.sql
git commit -m "feat(question-bank): add reference column for imported question provenance"
```

---

### Task 3: OCR 客户端（后端新增 `internal/ocr`）

**Files:**
- Create: `backend/internal/ocr/client.go`
- Create: `backend/internal/ocr/client_test.go`

**Interfaces:**
- Consumes: 现有 `speech.popSignature`/`percentEncode` 的签名算法（复制到本包，不跨包依赖）
- Produces:
  - `type Client interface { Recognize(ctx context.Context, image []byte) (string, error) }`
  - `type Config struct { AccessKeyID, AccessKeySecret, Endpoint string }`
  - `func NewClient(cfg Config) (Client, error)` — 凭据不全返回错误
  - `func NewFakeClient() Client` — 测试用，返回固定文本 `OCR fake text`

**阿里云 OCR 说明（实现参考）**：调用 `RecognizeGeneral`（ocr-api 2021-07-07，RPC 风格），`POST https://ocr-api.cn-hangzhou.aliyuncs.com/`，查询参数含 `Action=RecognizeGeneral`、`Version=2021-07-07`、`Format=JSON`、`RegionId=cn-hangzhou`、时间戳、随机 nonce、`SignatureMethod=HMAC-SHA1`、`SignatureVersion=1.0`，最后按 RPC 签名（`GET&%2F&<percent-encoded canonical query>`，用 `AccessKeySecret&` 做 HMAC-SHA1）计算 `Signature`；body 为 JSON `{"body": "<base64 图片>"}`，`Content-Type: application/json`。响应 `{ "code": "200", "data": { "wordsResult": [ { "words": "..." } ] } }`。签名算法与 `backend/internal/speech/aliyun.go` 的 `popSignature`/`percentEncode` 完全一致，直接复制适配。

- [ ] **Step 1: 写失败测试**

`backend/internal/ocr/client_test.go`:

```go
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
```

（`io`、`strings` 需在文件头导入。）

- [ ] **Step 2: 运行测试确认失败**

Run: `cd backend && go test ./internal/ocr/ -v`
Expected: FAIL（包不存在 / 类型未定义）

- [ ] **Step 3: 写实现**

`backend/internal/ocr/client.go`:

```go
package ocr

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"
)

const defaultEndpoint = "https://ocr-api.cn-hangzhou.aliyuncs.com/"

type Client interface {
	Recognize(ctx context.Context, image []byte) (string, error)
}

type Config struct {
	AccessKeyID     string
	AccessKeySecret string
	Endpoint        string
}

type aliyunClient struct {
	cfg        Config
	httpClient *http.Client
}

func NewClient(cfg Config) (Client, error) {
	if cfg.AccessKeyID == "" || cfg.AccessKeySecret == "" {
		return nil, fmt.Errorf("aliyun ocr credentials required")
	}
	if cfg.Endpoint == "" {
		cfg.Endpoint = defaultEndpoint
	}
	return &aliyunClient{
		cfg:        cfg,
		httpClient: &http.Client{Timeout: 30 * time.Second},
	}, nil
}

func NewFakeClient() Client {
	return &fakeClient{}
}

type fakeClient struct{}

func (f *fakeClient) Recognize(ctx context.Context, image []byte) (string, error) {
	return "OCR fake text", nil
}

func (c *aliyunClient) Recognize(ctx context.Context, image []byte) (string, error) {
	params := map[string]string{
		"AccessKeyId":      c.cfg.AccessKeyID,
		"Action":           "RecognizeGeneral",
		"Version":          "2021-07-07",
		"Format":           "JSON",
		"RegionId":         "cn-hangzhou",
		"Timestamp":        time.Now().UTC().Format("2006-01-02T15:04:05Z"),
		"SignatureMethod":  "HMAC-SHA1",
		"SignatureVersion": "1.0",
		"SignatureNonce":   randomHex(),
	}
	params["Signature"] = popSignature(params, c.cfg.AccessKeySecret)

	query := url.Values{}
	for k, v := range params {
		query.Set(k, v)
	}
	payload, err := json.Marshal(map[string]string{"body": base64.StdEncoding.EncodeToString(image)})
	if err != nil {
		return "", err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.cfg.Endpoint+"?"+query.Encode(), bytes.NewReader(payload))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return "", err
	}
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("aliyun ocr http %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}

	var out struct {
		Code string `json:"code"`
		Data struct {
			WordsResult []struct {
				Words string `json:"words"`
			} `json:"wordsResult"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return "", err
	}
	if out.Code != "" && out.Code != "200" {
		return "", fmt.Errorf("aliyun ocr code %s", out.Code)
	}
	var lines []string
	for _, w := range out.Data.WordsResult {
		if strings.TrimSpace(w.Words) != "" {
			lines = append(lines, strings.TrimSpace(w.Words))
		}
	}
	if len(lines) == 0 {
		return "", fmt.Errorf("aliyun ocr returned no text")
	}
	return strings.Join(lines, "\n"), nil
}

func popSignature(params map[string]string, secret string) string {
	keys := make([]string, 0, len(params))
	for k := range params {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, k := range keys {
		parts = append(parts, percentEncode(k)+"="+percentEncode(params[k]))
	}
	canonicalized := strings.Join(parts, "&")
	stringToSign := "GET&%2F&" + percentEncode(canonicalized)

	mac := hmac.New(sha1.New, []byte(secret+"&"))
	_, _ = mac.Write([]byte(stringToSign))
	return base64.StdEncoding.EncodeToString(mac.Sum(nil))
}

func percentEncode(s string) string {
	const hexDigits = "0123456789ABCDEF"
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') ||
			c == '-' || c == '_' || c == '.' || c == '~' {
			b.WriteByte(c)
			continue
		}
		b.WriteByte('%')
		b.WriteByte(hexDigits[c>>4])
		b.WriteByte(hexDigits[c&0x0f])
	}
	return b.String()
}

func randomHex() string {
	var buf [16]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(buf[:])
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd backend && go test ./internal/ocr/ -v`
Expected: PASS（2 测试）

- [ ] **Step 5: 提交**

```bash
git add backend/internal/ocr/
git commit -m "feat(ocr): Aliyun OCR RecognizeGeneral client with RPC signature"
```

---

### Task 4: 导入服务（后端 `internal/question` 扩展：解析 + 确认入库）

**Files:**
- Modify: `backend/internal/question/service.go`
- Modify: `backend/internal/question/repo.go`
- Modify: `backend/internal/question/models.go`
- Test: `backend/internal/question/service_test.go`

**Interfaces:**
- Consumes: `llm.ParseImportOut`、`llm.ParseImportSystem`/`ParseImportUser`（Task 1）；`ocr.Client`（Task 3）；现有 `classifyAsync`、`repo.InsertBatch`。
- Produces:
  - `type ParsedQuestion struct { Question string; Answer string; Reference string }`
  - `type ParseResult struct { Items []ParsedQuestion; Raw string; OcrText string }`
  - `type ImportResult struct { Imported, Skipped int }`
  - `func (s *Service) ParseFromText(ctx context.Context, text string) (ParseResult, error)`
  - `func (s *Service) ParseFromImage(ctx context.Context, image []byte) (ParseResult, error)`
  - `func (s *Service) ImportConfirmed(ctx context.Context, userID int64, items []ParsedQuestion, jobTag string) (ImportResult, error)`

- [ ] **Step 1: 写失败测试**

在 `backend/internal/question/service_test.go` 追加：

```go
type parseLLM struct{ out llm.ParseImportOut }

func (p *parseLLM) ChatJSON(ctx context.Context, system, user string, out any) error {
	dest, ok := out.(*llm.ParseImportOut)
	if !ok {
		return fmt.Errorf("unexpected out type")
	}
	*dest = p.out
	return nil
}

func TestImportConfirmedStoresImportSource(t *testing.T) {
	sqlDB := testDB(t)
	r := testRouter(t, sqlDB, nil)

	const email = "test-import-confirm@example.com"
	_ = registerUser(t, r, email)
	userID := userIDByEmail(t, sqlDB, email)

	svc := question.NewService(sqlDB, nil)
	_, err := svc.ImportConfirmed(context.Background(), userID, []question.ParsedQuestion{
		{Question: "导入题A", Answer: "答A", Reference: "出处A"},
		{Question: "导入题B"},
	}, "后端开发")
	if err != nil {
		t.Fatalf("import confirmed: %v", err)
	}

	var source, ref sql.NullString
	var sessionID sql.NullInt64
	if err := sqlDB.QueryRow(`SELECT source, source_session_id, reference FROM question_bank WHERE user_id = ? AND question = ?`, userID, "导入题A").Scan(&source, &sessionID, &ref); err != nil {
		t.Fatalf("query imported row: %v", err)
	}
	if !source.Valid || source.String != "import" {
		t.Fatalf("source = %v, want import", source)
	}
	if sessionID.Valid {
		t.Fatalf("source_session_id should be NULL, got %d", sessionID.Int64)
	}
	if !ref.Valid || ref.String != "出处A" {
		t.Fatalf("reference = %v, want 出处A", ref)
	}
}

func TestImportConfirmedDeduplicates(t *testing.T) {
	sqlDB := testDB(t)
	r := testRouter(t, sqlDB, nil)

	const email = "test-import-confirm-dedupe@example.com"
	_ = registerUser(t, r, email)
	userID := userIDByEmail(t, sqlDB, email)

	svc := question.NewService(sqlDB, nil)
	items := []question.ParsedQuestion{{Question: "重复题", Answer: "答", Reference: ""}}
	first, err := svc.ImportConfirmed(context.Background(), userID, items, "")
	if err != nil || first.Imported != 1 {
		t.Fatalf("first import = %+v, err = %v", first, err)
	}
	second, err := svc.ImportConfirmed(context.Background(), userID, items, "")
	if err != nil {
		t.Fatalf("second import: %v", err)
	}
	if second.Imported != 0 || second.Skipped != 1 {
		t.Fatalf("second import = %+v, want imported=0 skipped=1", second)
	}
}

func TestImportConfirmedEmptyRejected(t *testing.T) {
	sqlDB := testDB(t)
	svc := question.NewService(sqlDB, nil)
	_, err := svc.ImportConfirmed(context.Background(), 1, nil, "")
	if !errors.Is(err, question.ErrInvalidInput) {
		t.Fatalf("err = %v, want ErrInvalidInput", err)
	}
}

func TestImportConfirmedClassifiesDimensions(t *testing.T) {
	sqlDB := testDB(t)
	classOut := llm.ClassifyOut{}
	classOut.Classifications = append(classOut.Classifications, struct {
		Question  string `json:"question"`
		Dimension string `json:"dimension"`
	}{Question: "导入分类题", Dimension: "content"})
	r := testRouter(t, sqlDB, &classifyingLLM{out: classOut})

	const email = "test-import-confirm-classify@example.com"
	_ = registerUser(t, r, email)
	userID := userIDByEmail(t, sqlDB, email)

	svc := question.NewService(sqlDB, &classifyingLLM{out: classOut})
	if _, err := svc.ImportConfirmed(context.Background(), userID, []question.ParsedQuestion{{Question: "导入分类题"}}, ""); err != nil {
		t.Fatalf("import: %v", err)
	}

	var dim sql.NullString
	if err := sqlDB.QueryRow(`SELECT dimension FROM question_bank WHERE user_id = ? AND question = ?`, userID, "导入分类题").Scan(&dim); err != nil {
		t.Fatalf("read dimension: %v", err)
	}
	if !dim.Valid || dim.String != "content" {
		t.Fatalf("dimension = %v, want content", dim)
	}
}

func TestParseFromTextStructuredAndFallback(t *testing.T) {
	sqlDB := testDB(t)

	// 成功：LLM 返回结构化
	svcOut := parseLLM{out: llm.ParseImportOut{}}
	svcOut.out.Items = append(svcOut.out.Items, struct {
		Question string `json:"question"`
		Answer   string `json:"answer,omitempty"`
	}{Question: "Q1", Answer: "A1"})
	svc := question.NewService(sqlDB, &svcOut)
	res, err := svc.ParseFromText(context.Background(), "面经原文")
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(res.Items) != 1 || res.Items[0].Question != "Q1" {
		t.Fatalf("items = %+v, want one Q1", res.Items)
	}

	// 失败降级：LLM 报错 → 返回 raw
	svc = question.NewService(sqlDB, failingLLM{})
	res, err = svc.ParseFromText(context.Background(), "无法解析的原文")
	if err != nil {
		t.Fatalf("fallback parse should not error, got %v", err)
	}
	if len(res.Items) != 0 || res.Raw != "无法解析的原文" {
		t.Fatalf("fallback = %+v, want empty items + raw", res)
	}
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd backend && go test ./internal/question/ -run 'TestImportConfirmed|TestParseFromText' -v`
Expected: FAIL（`ParsedQuestion` 等未定义 / `ImportConfirmed` 不存在）

- [ ] **Step 3: 扩展 models.go**

`backend/internal/question/models.go` 追加：

```go
type ParsedQuestion struct {
	Question  string
	Answer    string
	Reference string
}

type ParseResult struct {
	Items   []ParsedQuestion
	Raw     string
	OcrText string
}

type ImportResult struct {
	Imported int
	Skipped  int
}
```

同时给 `Item` 增加 `Reference *string` 字段（JSON `reference`）：

```go
	Reference       *string   `json:"reference"`
```

- [ ] **Step 4: 扩展 repo.go — InsertImportedBatch + 读取 reference**

在 `repo.go` 追加（保持 `InsertBatch` 不变）：

```go
// InsertImportedBatch inserts user-confirmed imported questions with
// source='import', source_session_id NULL, and an optional reference. It
// reuses the exact-question-text dedupe rule and returns imported/skipped.
func (r *Repo) InsertImportedBatch(userID int64, questions []ParsedQuestion, jobTag string) (ImportResult, error) {
	if len(questions) == 0 {
		return ImportResult{}, nil
	}
	tx, err := r.db.Begin()
	if err != nil {
		return ImportResult{}, err
	}
	defer tx.Rollback()

	var res ImportResult
	for _, q := range questions {
		if strings.TrimSpace(q.Question) == "" {
			continue
		}
		var exists int
		if err := tx.QueryRow(
			`SELECT COUNT(*) FROM question_bank WHERE user_id = ? AND question = ?`,
			userID, q.Question,
		).Scan(&exists); err != nil {
			return ImportResult{}, err
		}
		if exists > 0 {
			res.Skipped++
			continue
		}
		_, err := tx.Exec(
			`INSERT INTO question_bank (user_id, question, answer, user_answer, source, source_session_id, job_tag, reference, starred)
			 VALUES (?, ?, ?, NULL, 'import', NULL, ?, ?, 0)`,
			userID, q.Question, nullStr(q.Answer), nullStr(jobTag), nullStr(q.Reference),
		)
		if err != nil {
			return ImportResult{}, err
		}
		res.Imported++
	}
	if err := tx.Commit(); err != nil {
		return ImportResult{}, err
	}
	return res, nil
}
```

修改 `List` / `GetByID` / `ListByDimensionForFocused` 的 SELECT 与 `scanItem`，把 `reference` 加入（放在 `dimension` 之后、`starred` 之前）：

- 三处 SELECT 的列清单 `..., dimension, starred, ...` → `..., dimension, reference, starred, ...`
- `scanItem` 增加 `var reference sql.NullString`，Scan 顺序与 SELECT 一致，`if reference.Valid { item.Reference = &reference.String }`

- [ ] **Step 5: 扩展 service.go**

`backend/internal/question/service.go`：

1. import 增加 `"github.com/interview-assistant/backend/internal/ocr"`（`Service` 结构体与 `SetOCR` 需要）。
2. `Service` 增加 `ocr ocr.Client` 字段；新增 setter（沿用 `interview.Service.SetEvaluator` 模式，避免改 `NewService` 签名导致所有调用点变动）：

```go
func (s *Service) SetOCR(c ocr.Client) {
	s.ocr = c
}
```

3. `ImportFromSession` 内部不受影响（`InsertBatch` 不变）。
4. 追加方法：

```go
// ParseFromText extracts candidate questions from a transcript using the LLM.
// On LLM failure it degrades to returning the raw text for manual editing;
// it never fails the request.
func (s *Service) ParseFromText(ctx context.Context, text string) (ParseResult, error) {
	text = strings.TrimSpace(text)
	if text == "" {
		return ParseResult{}, ErrInvalidInput
	}
	var out llm.ParseImportOut
	if err := s.llm.ChatJSON(ctx, llm.ParseImportSystem(), llm.ParseImportUser(text), &out); err != nil {
		return ParseResult{Raw: text}, nil // 降级：返回原文供手动编辑
	}
	var res ParseResult
	for _, it := range out.Items {
		q := strings.TrimSpace(it.Question)
		if q == "" {
			continue
		}
		res.Items = append(res.Items, ParsedQuestion{
			Question: q,
			Answer:   strings.TrimSpace(it.Answer),
		})
	}
	if len(res.Items) == 0 {
		res.Raw = text
	}
	return res, nil
}

// ParseFromImage OCRs an image then runs ParseFromText on the recognized text.
func (s *Service) ParseFromImage(ctx context.Context, image []byte) (ParseResult, error) {
	if s.ocr == nil {
		return ParseResult{}, ErrOCRUnavailable
	}
	text, err := s.ocr.Recognize(ctx, image)
	if err != nil {
		return ParseResult{}, ErrOCRUnavailable
	}
	res, err := s.ParseFromText(ctx, text)
	res.OcrText = text
	return res, err
}

// ImportConfirmed inserts user-confirmed parsed questions with source='import'
// and classifies their dimensions via the existing async pipeline.
func (s *Service) ImportConfirmed(ctx context.Context, userID int64, items []ParsedQuestion, jobTag string) (ImportResult, error) {
	if len(items) == 0 {
		return ImportResult{}, ErrInvalidInput
	}
	res, err := s.repo.InsertImportedBatch(userID, items, jobTag)
	if err != nil {
		return ImportResult{}, err
	}
	if res.Imported > 0 {
		texts := make([]string, 0, len(items))
		for _, it := range items {
			if strings.TrimSpace(it.Question) != "" {
				texts = append(texts, it.Question)
			}
		}
		s.classifyAsync(userID, texts) // best-effort dimension tagging
	}
	return res, nil
}
```

4. 在 `ErrNotFound`/`ErrInvalidInput` 旁追加：

```go
	ErrOCRUnavailable = errors.New("ocr unavailable")
```

- [ ] **Step 6: 全量后端测试（含既有测试回归）**

Run: `cd backend && go test ./...`
Expected: PASS（`NewService` 签名未变，所有既有调用点与测试无需改动）

> `main.go` 只需在 Task 6 调用 `svc.SetOCR(ocrClient)` 接线，本任务无编译风险。

- [ ] **Step 7: 提交**

```bash
git add backend/internal/question/
git commit -m "feat(question-bank): import parse + confirm service with import source tagging"
```

---

### Task 5: 导入接口（后端 handler）

**Files:**
- Modify: `backend/internal/question/handler.go`
- Test: `backend/internal/question/service_test.go`（追加 handler 测试）

**Interfaces:**
- Consumes: `Service.ParseFromText`/`ParseFromImage`/`ImportConfirmed`、`question.ImportResult`
- Produces: 两个路由：
  - `POST /api/questions/import/parse`（JSON `{text}` 或 multipart `file`；响应 `{items, raw, ocr_text}`）
  - `POST /api/questions/import/confirm`（JSON `{items, job_tag}`；响应 `{imported, skipped}`）

- [ ] **Step 1: 写失败测试**

`backend/internal/question/service_test.go` 追加：

```go
func TestImportParseTextHandler(t *testing.T) {
	sqlDB := testDB(t)
	svcOut := parseLLM{out: llm.ParseImportOut{}}
	svcOut.out.Items = append(svcOut.out.Items, struct {
		Question string `json:"question"`
		Answer   string `json:"answer,omitempty"`
	}{Question: "解析题", Answer: "解析答案"})
	r := testRouter(t, sqlDB, &svcOut)

	token := registerUser(t, r, "test-import-parse@example.com")
	body, _ := json.Marshal(map[string]string{"text": "面经内容"})
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/questions/import/parse", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("parse status = %d, body = %s", w.Code, w.Body.String())
	}
	var resp struct {
		Items []struct {
			Question string `json:"question"`
			Answer   string `json:"answer"`
		} `json:"items"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode parse: %v", err)
	}
	if len(resp.Items) != 1 || resp.Items[0].Question != "解析题" {
		t.Fatalf("items = %+v", resp.Items)
	}
}

func TestImportConfirmHandler(t *testing.T) {
	sqlDB := testDB(t)
	r := testRouter(t, sqlDB, nil)

	token := registerUser(t, r, "test-import-confirm-h@example.com")
	body, _ := json.Marshal(map[string]any{
		"items": []map[string]any{
			{"question": "接口入库题", "answer": "答", "reference": "出处"},
		},
		"job_tag": "前端开发",
	})
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/questions/import/confirm", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("confirm status = %d, body = %s", w.Code, w.Body.String())
	}
	var resp struct {
		Imported int `json:"imported"`
		Skipped  int `json:"skipped"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode confirm: %v", err)
	}
	if resp.Imported != 1 || resp.Skipped != 0 {
		t.Fatalf("imported=%d skipped=%d, want 1/0", resp.Imported, resp.Skipped)
	}

	items := listQuestions(t, r, token, "")
	found := false
	for _, it := range items {
		if it.Question == "接口入库题" {
			found = true
			if it.Source != "import" {
				t.Fatalf("source = %q, want import", it.Source)
			}
		}
	}
	if !found {
		t.Fatal("imported question not in list")
	}
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd backend && go test ./internal/question/ -run 'TestImportParse|TestImportConfirm' -v`
Expected: FAIL（路由不存在 → 404）

- [ ] **Step 3: 扩展 handler.go**

`backend/internal/question/handler.go`：

1. `RegisterRoutes` 中追加（在 `POST /from-session/:sessionId` 附近）：

```go
	protected.POST("/import/parse", h.ImportParse)
	protected.POST("/import/confirm", h.ImportConfirm)
```

2. 追加 handler 与请求类型：

```go
const maxImportImageBytes = 5 << 20

type parseRequest struct {
	Text string `json:"text"`
}

type confirmItem struct {
	Question  string `json:"question"`
	Answer    string `json:"answer"`
	Reference string `json:"reference"`
}

type confirmRequest struct {
	Items  []confirmItem `json:"items"`
	JobTag string        `json:"job_tag"`
}

func (h *Handler) ImportParse(c *gin.Context) {
	_, ok := c.Get("userID")
	if !ok {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
		return
	}

	// 图片（multipart）或文本（JSON）二选一
	var res question.ParseResult
	if strings.HasPrefix(c.GetHeader("Content-Type"), "multipart/form-data") {
		file, err := c.FormFile("file")
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "file is required"})
			return
		}
		if file.Size > maxImportImageBytes {
			c.JSON(http.StatusBadRequest, gin.H{"error": "image is too large"})
			return
		}
		f, err := file.Open()
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "could not read image"})
			return
		}
		defer f.Close()
		image, err := io.ReadAll(f)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "could not read image"})
			return
		}
		res, err = h.svc.ParseFromImage(c.Request.Context(), image)
		if errors.Is(err, question.ErrOCRUnavailable) {
			c.JSON(http.StatusBadGateway, gin.H{"error": "image recognition unavailable, please use text input"})
			return
		}
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "could not parse image"})
			return
		}
	} else {
		var req parseRequest
		if err := c.ShouldBindJSON(&req); err != nil || strings.TrimSpace(req.Text) == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "text is required"})
			return
		}
		var err error
		res, err = h.svc.ParseFromText(c.Request.Context(), req.Text)
		if errors.Is(err, question.ErrInvalidInput) {
			c.JSON(http.StatusBadRequest, gin.H{"error": "text is required"})
			return
		}
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "could not parse text"})
			return
		}
	}

	type itemJSON struct {
		Question string `json:"question"`
		Answer   string `json:"answer,omitempty"`
	}
	items := make([]itemJSON, 0, len(res.Items))
	for _, it := range res.Items {
		items = append(items, itemJSON{Question: it.Question, Answer: it.Answer})
	}
	c.JSON(http.StatusOK, gin.H{
		"items":    items,
		"raw":      res.Raw,
		"ocr_text": res.OcrText,
	})
}

func (h *Handler) ImportConfirm(c *gin.Context) {
	userID, ok := c.Get("userID")
	if !ok {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
		return
	}
	var req confirmRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request"})
		return
	}
	items := make([]question.ParsedQuestion, 0, len(req.Items))
	for _, it := range req.Items {
		items = append(items, question.ParsedQuestion{
			Question:  it.Question,
			Answer:    it.Answer,
			Reference: it.Reference,
		})
	}
	res, err := h.svc.ImportConfirmed(c.Request.Context(), userID.(int64), items, req.JobTag)
	if errors.Is(err, question.ErrInvalidInput) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "items are required"})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not import questions"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"imported": res.Imported, "skipped": res.Skipped})
}
```

3. 文件头 import 增加 `"io"`、`"strings"`。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd backend && go test ./internal/question/ -run 'TestImportParse|TestImportConfirm' -v`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add backend/internal/question/handler.go backend/internal/question/service_test.go
git commit -m "feat(question-bank): import parse and confirm HTTP endpoints"
```

---

### Task 6: 接线（main.go 配置 + OCR 客户端注入）

**Files:**
- Modify: `backend/cmd/server/main.go`
- Modify: `backend/internal/config/config.go`
- Modify: `.env.example`（仓库根）

**Interfaces:**
- Consumes: `ocr.NewClient`、`ocr.Config`、`question.SetOCR`、`question.NewService`（签名不变）
- Produces: `cfg.OCRAccessKeyID`/`OCRAccessKeySecret`/`OCREndpoint`；`question.RegisterRoutes` 增加第 5 参 `ocrClient ocr.Client`

- [ ] **Step 1: 扩展 config.go**

`backend/internal/config/config.go`：

```go
	OCRAccessKeyID     string
	OCRAccessKeySecret string
	OCREndpoint        string
```

`Load()` 中：

```go
		OCRAccessKeyID:     getenv("ALIYUN_OCR_ACCESS_KEY_ID", os.Getenv("ALIYUN_ACCESS_KEY_ID")),
		OCRAccessKeySecret: getenv("ALIYUN_OCR_ACCESS_KEY_SECRET", os.Getenv("ALIYUN_ACCESS_KEY_SECRET")),
		OCREndpoint:        os.Getenv("ALIYUN_OCR_ENDPOINT"),
```

> 默认回退到现有 `ALIYUN_ACCESS_KEY_ID/SECRET`（与语音共用），可用独立的 `ALIYUN_OCR_*` 覆盖。

- [ ] **Step 2: 更新 main.go**

`backend/cmd/server/main.go`：

1. import 增加 `"github.com/interview-assistant/backend/internal/ocr"`。
2. 在 speech client 接线之后、`svc := interview.NewService(...)` 之前：

```go
	var ocrClient ocr.Client
	if cfg.OCRAccessKeyID != "" && cfg.OCRAccessKeySecret != "" {
		oc, err := ocr.NewClient(ocr.Config{
			AccessKeyID:     cfg.OCRAccessKeyID,
			AccessKeySecret: cfg.OCRAccessKeySecret,
			Endpoint:        cfg.OCREndpoint,
		})
		if err != nil {
			log.Fatalf("ocr client: %v", err)
		}
		ocrClient = oc
		log.Println("Aliyun OCR client enabled")
	} else {
		log.Println("warning: Aliyun OCR credentials not set; /api/questions/import/parse image input returns 502")
	}
```

3. 把 `question.RegisterRoutes(r, sqlDB, cfg.JWTSecret, llmClient)` 改为（签名增加第 5 参，见 Step 3）：

```go
	question.RegisterRoutes(r, sqlDB, cfg.JWTSecret, llmClient, ocrClient)
```

- [ ] **Step 3: 更新 RegisterRoutes 签名**

`backend/internal/question/handler.go`：

1. import 增加 `"github.com/interview-assistant/backend/internal/ocr"`。
2. `RegisterRoutes` 签名增加第 5 参 `ocrClient ocr.Client`，并在内部 `svc := NewService(db, llmClient)` 后调用 `svc.SetOCR(ocrClient)`：

```go
func RegisterRoutes(r *gin.Engine, db *sql.DB, secret string, llmClient llm.Client, ocrClient ocr.Client) {
	svc := NewService(db, llmClient)
	svc.SetOCR(ocrClient)
	h := NewHandler(svc)
	protected := r.Group("/api/questions")
	protected.Use(auth.Middleware(secret))
	protected.GET("", h.List)
	protected.POST("/from-session/:sessionId", h.ImportFromSession)
	protected.POST("/import/parse", h.ImportParse)
	protected.POST("/import/confirm", h.ImportConfirm)
	protected.POST("/question-bank/focused", h.Focused)
	protected.PATCH("/:id", h.Patch)
	protected.DELETE("/:id", h.Delete)
	protected.POST("/batch-delete", h.BatchDelete)
}
```

3. 更新测试的 `testRouter`（`backend/internal/question/service_test.go`）：

```go
	question.RegisterRoutes(r, sqlDB, secret, llmClient, nil)
```

> `SetOCR(nil)` 时图片解析返回 `ErrOCRUnavailable`（handler → 502），文本解析不受影响——测试与生产行为一致。

- [ ] **Step 4: 更新 .env.example**

追加：

```
# 阿里云 OCR（图片导入；缺省回退到上方 ALIYUN_ACCESS_KEY_ID/SECRET）
ALIYUN_OCR_ACCESS_KEY_ID=
ALIYUN_OCR_ACCESS_KEY_SECRET=
ALIYUN_OCR_ENDPOINT=
```

- [ ] **Step 6: 全量后端验证**

Run: `cd backend && go test ./... && go build ./...`
Expected: 全部 PASS、构建成功

- [ ] **Step 7: 提交**

```bash
git add backend/cmd/server/main.go backend/internal/config/config.go backend/internal/question/handler.go backend/internal/question/service_test.go .env.example
git commit -m "feat(import): wire Aliyun OCR client and env config into question service"
```

---

### Task 7: 前端 API 客户端 + source 标签

**Files:**
- Modify: `frontend/src/api/questions.ts`
- Modify: `frontend/src/lib/labels.ts`
- Test: `frontend/src/lib/labels.test.ts`（新建）

**Interfaces:**
- Consumes: `fetchJSON`（`client.ts`）、`getApiBase`/`getToken`/`toUserMessage`（`client.ts`，图片上传用原生 fetch）
- Produces:
  - `export interface ImportItem { question: string; answer?: string; reference?: string }`
  - `export interface ImportParseResult { items: ImportItem[]; raw: string; ocr_text: string }`
  - `export async function parseImportText(text: string): Promise<ImportParseResult>`
  - `export async function parseImportImage(file: File): Promise<ImportParseResult>`
  - `export async function confirmImport(items: ImportItem[], jobTag?: string): Promise<{ imported: number; skipped: number }>`
  - `export const SOURCE_LABELS: Record<string, string>`（`{ interview: '面试', import: '导入' }`）
  - `Question` 接口新增 `reference: string | null`

- [ ] **Step 1: 写失败测试（labels）**

`frontend/src/lib/labels.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { SOURCE_LABELS } from './labels';

describe('SOURCE_LABELS', () => {
  it('maps interview and import sources', () => {
    expect(SOURCE_LABELS.interview).toBe('面试');
    expect(SOURCE_LABELS.import).toBe('导入');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd frontend && npx vitest run src/lib/labels.test.ts`
Expected: FAIL（`SOURCE_LABELS` 未导出）

- [ ] **Step 3: 扩展 labels.ts**

`frontend/src/lib/labels.ts` 末尾追加：

```ts
// 题库题目来源标记（single source of truth 与 backend question_bank.source 一致）
export const SOURCE_LABELS: Record<string, string> = {
  interview: '面试',
  import: '导入',
};
```

- [ ] **Step 4: 扩展 questions.ts**

`frontend/src/api/questions.ts`：

1. `Question` 接口追加 `reference: string | null;`（放在 `dimension` 之后、`starred` 之前）。
2. 顶部 import 改为：

```ts
import { ApiError, fetchJSON, getApiBase, getToken, toUserMessage } from './client';
```

3. 追加类型与函数：

```ts
export interface ImportItem {
  question: string;
  answer?: string;
  reference?: string;
}

export interface ImportParseResult {
  items: ImportItem[];
  raw: string;
  ocr_text: string;
}

export async function parseImportText(text: string): Promise<ImportParseResult> {
  return fetchJSON<ImportParseResult>('/api/questions/import/parse', {
    method: 'POST',
    body: JSON.stringify({ text }),
  });
}

export async function parseImportImage(file: File): Promise<ImportParseResult> {
  // multipart：fetchJSON 会默认加 JSON Content-Type，图片必须走原生 fetch
  const token = getToken();
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(`${getApiBase()}/api/questions/import/parse`, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    body: form,
  });
  if (!res.ok) {
    let message = res.statusText || 'Request failed';
    try {
      const data = (await res.json()) as unknown;
      if (data && typeof data === 'object' && 'error' in data) {
        message = String((data as { error: unknown }).error);
      }
    } catch {
      // keep status text
    }
    throw new ApiError(res.status, toUserMessage(res.status, message), message);
  }
  return (await res.json()) as ImportParseResult;
}

export async function confirmImport(
  items: ImportItem[],
  jobTag?: string,
): Promise<{ imported: number; skipped: number }> {
  return fetchJSON<{ imported: number; skipped: number }>('/api/questions/import/confirm', {
    method: 'POST',
    body: JSON.stringify({ items, job_tag: jobTag ?? '' }),
  });
}
```

> 与 `speech.ts` 的 `transcribeAudio` 模式一致（原生 fetch + FormData，`toUserMessage` 映射错误文案）。

- [ ] **Step 5: 类型检查 + 测试**

Run: `cd frontend && npx tsc --noEmit -p tsconfig.app.json && npm test`
Expected: 无类型错误；`labels.test.ts` PASS

- [ ] **Step 6: 提交**

```bash
git add frontend/src/api/questions.ts frontend/src/lib/labels.ts frontend/src/lib/labels.test.ts
git commit -m "feat(question-bank): frontend import API client and source labels"
```

---

### Task 8: 前端导入流程（模态框组件）

**Files:**
- Create: `frontend/src/components/QuestionImportModal.tsx`
- Modify: `frontend/src/pages/QuestionBankPage.tsx`
- Test: `frontend/src/components/QuestionImportModal.test.tsx`

**Interfaces:**
- Consumes: `parseImportText`/`parseImportImage`/`confirmImport`（Task 7）、`SOURCE_LABELS`（Task 7）
- Produces: `QuestionImportModal` 组件 + `QuestionBankPage` 顶部「导入题目」按钮与刷新回调

- [ ] **Step 1: 写失败测试**

`frontend/src/components/QuestionImportModal.test.tsx`:

```tsx
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import QuestionImportModal from './QuestionImportModal';
import type { ImportItem } from '../api/questions';

vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => false } }));

vi.mock('../api/questions', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return {
    ...actual,
    parseImportText: vi.fn(async (text: string) => ({
      items: [{ question: '解析出的题目', answer: '答案' }] as ImportItem[],
      raw: '',
      ocr_text: '',
    })),
    parseImportImage: vi.fn(async () => ({
      items: [] as ImportItem[],
      raw: '',
      ocr_text: 'OCR 文本',
    })),
    confirmImport: vi.fn(async () => ({ imported: 2, skipped: 1 })),
  };
});

function renderModal(open = true, onClose = vi.fn(), onImported = vi.fn()) {
  return render(
    <QuestionImportModal open={open} onClose={onClose} onImported={onImported} />,
  );
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('QuestionImportModal', () => {
  it('renders input step when open', () => {
    renderModal();
    expect(screen.getByText('导入题目')).toBeTruthy();
    expect(screen.getByPlaceholderText(/粘贴面经文本/)).toBeTruthy();
  });

  it('parses text and shows editable candidates', async () => {
    renderModal();
    fireEvent.change(screen.getByPlaceholderText(/粘贴面经文本/), {
      target: { value: '面经原文' },
    });
    fireEvent.click(screen.getByText('解析'));
    await waitFor(() => {
      expect(screen.getByDisplayValue('解析出的题目')).toBeTruthy();
    });
  });

  it('confirms import and reports counts', async () => {
    renderModal();
    fireEvent.change(screen.getByPlaceholderText(/粘贴面经文本/), {
      target: { value: '面经原文' },
    });
    fireEvent.click(screen.getByText('解析'));
    await waitFor(() => {
      expect(screen.getByDisplayValue('解析出的题目')).toBeTruthy();
    });
    fireEvent.click(screen.getByText('确认导入'));
    await waitFor(() => {
      expect(screen.getByText(/新增 2 题，跳过 1 题重复/)).toBeTruthy();
    });
  });
});
```

> 组件内的 `onImported` 会在确认成功后调用；测试断言计数文案。若组件用原生 `window.confirm` 等，按需 mock（参考 `AppNav.test.tsx` 的 `mockConfirm`）。

- [ ] **Step 2: 运行测试确认失败**

Run: `cd frontend && npx vitest run src/components/QuestionImportModal.test.tsx`
Expected: FAIL（组件不存在）

- [ ] **Step 3: 写组件**

`frontend/src/components/QuestionImportModal.tsx`:

```tsx
import { useRef, useState } from 'react';
import {
  confirmImport,
  parseImportImage,
  parseImportText,
  type ImportItem,
  type ImportParseResult,
} from '../api/questions';
import { ApiError } from '../api/client';

interface Props {
  open: boolean;
  onClose: () => void;
  onImported: () => void;
}

type Step = 'input' | 'candidates' | 'done';

export default function QuestionImportModal({ open, onClose, onImported }: Props) {
  const [step, setStep] = useState<Step>('input');
  const [text, setText] = useState('');
  const [jobTag, setJobTag] = useState('');
  const [imageName, setImageName] = useState('');
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [items, setItems] = useState<ImportItem[]>([]);
  const [raw, setRaw] = useState('');
  const [ocrText, setOcrText] = useState('');
  const [parsing, setParsing] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  if (!open) return null;

  async function handleParse() {
    setParsing(true);
    setError('');
    setMessage('');
    try {
      let res: ImportParseResult;
      if (imageFile) {
        res = await parseImportImage(imageFile);
      } else if (text.trim()) {
        res = await parseImportText(text);
      } else {
        setError('请粘贴面经文本或上传图片');
        return;
      }
      setItems(res.items);
      setRaw(res.raw);
      setOcrText(res.ocr_text);
      setStep('candidates'); // 有解析结果进候选编辑；无结果（raw 模式）也进候选区手动整理
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : '解析失败';
      if (msg.includes('改用文本粘贴') || msg.includes('unavailable')) {
        setError('图片识别失败，请改用文本粘贴');
      } else {
        setError(msg);
      }
    } finally {
      setParsing(false);
    }
  }

  function updateItem(index: number, patch: Partial<ImportItem>) {
    setItems((prev) => prev.map((it, i) => (i === index ? { ...it, ...patch } : it)));
  }

  function removeItem(index: number) {
    setItems((prev) => prev.filter((_, i) => i !== index));
  }

  function addItem() {
    setItems((prev) => [...prev, { question: '' }]);
  }

  async function handleConfirm() {
    setParsing(true);
    setError('');
    setMessage('');
    const valid = items.filter((it) => it.question.trim() !== '');
    try {
      const res = await confirmImport(valid, jobTag);
      setMessage(`新增 ${res.imported} 题，跳过 ${res.skipped} 题重复`);
      setStep('done');
      onImported();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '导入失败');
    } finally {
      setParsing(false);
    }
  }

  function reset() {
    setStep('input');
    setText('');
    setJobTag('');
    setImageName('');
    setImageFile(null);
    setItems([]);
    setRaw('');
    setOcrText('');
    setError('');
    setMessage('');
  }

  function close() {
    reset();
    onClose();
  }

  return (
    <div className="import-modal-backdrop" role="dialog" aria-modal="true" aria-label="导入题目">
      <div className="import-modal">
        <div className="import-modal-header">
          <h2>导入题目</h2>
          <button type="button" className="import-modal-close" onClick={close}>
            ✕
          </button>
        </div>

        {step === 'input' && (
          <div className="import-modal-body">
            <div className="interview-field">
              <label htmlFor="import-text">面经文本</label>
              <textarea
                id="import-text"
                rows={6}
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="粘贴面经文本…"
              />
            </div>
            <div className="interview-field">
              <label htmlFor="import-job-tag">岗位标签（可选）</label>
              <input
                id="import-job-tag"
                type="text"
                value={jobTag}
                onChange={(e) => setJobTag(e.target.value)}
                placeholder="例如：后端开发"
              />
            </div>
            <div className="interview-field">
              <label>或上传图片（截图）</label>
              <input
                ref={fileRef}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                onChange={(e) => {
                  const f = e.target.files?.[0] ?? null;
                  if (f && f.size > 5 * 1024 * 1024) {
                    setError('图片不能超过 5MB');
                    return;
                  }
                  setImageFile(f);
                  setImageName(f ? f.name : '');
                }}
              />
              {imageName && <p className="import-file-name">{imageName}</p>}
            </div>
            {error && <p className="interview-error">{error}</p>}
            <div className="import-modal-actions">
              <button
                type="button"
                className="interview-submit"
                disabled={parsing}
                onClick={() => void handleParse()}
              >
                {parsing ? '解析中…' : '解析'}
              </button>
              <button type="button" className="interview-inline-link" onClick={close}>
                取消
              </button>
            </div>
          </div>
        )}

        {step === 'candidates' && (
          <div className="import-modal-body">
            <p className="import-hint">
              已解析 {items.length} 题，可编辑后确认导入。
              {raw && !items.length && ' 自动解析失败，请手动整理以下原文。'}
            </p>
            {raw && !items.length && (
              <textarea rows={6} value={raw} readOnly className="import-raw" />
            )}
            {items.map((it, i) => (
              <div key={i} className="import-candidate">
                <input
                  className="import-candidate-question"
                  value={it.question}
                  onChange={(e) => updateItem(i, { question: e.target.value })}
                  placeholder="题干"
                />
                <textarea
                  rows={2}
                  value={it.answer ?? ''}
                  onChange={(e) => updateItem(i, { answer: e.target.value })}
                  placeholder="参考答案（可选）"
                />
                <input
                  value={it.reference ?? ''}
                  onChange={(e) => updateItem(i, { reference: e.target.value })}
                  placeholder="出处（可选）"
                />
                <button
                  type="button"
                  className="interview-inline-link"
                  onClick={() => removeItem(i)}
                >
                  删除
                </button>
              </div>
            ))}
            {error && <p className="interview-error">{error}</p>}
            <div className="import-modal-actions">
              <button
                type="button"
                className="interview-inline-link"
                onClick={addItem}
                disabled={parsing}
              >
                + 新增题目
              </button>
              <button
                type="button"
                className="interview-submit"
                disabled={parsing || items.filter((x) => x.question.trim()).length === 0}
                onClick={() => void handleConfirm()}
              >
                {parsing ? '导入中…' : '确认导入'}
              </button>
              <button
                type="button"
                className="interview-inline-link"
                onClick={() => setStep('input')}
              >
                返回
              </button>
            </div>
          </div>
        )}

        {step === 'done' && (
          <div className="import-modal-body">
            {message && <p className="interview-success">{message}</p>}
            {error && <p className="interview-error">{error}</p>}
            <div className="import-modal-actions">
              <button type="button" className="interview-submit" onClick={close}>
                完成
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: 接入 QuestionBankPage**

`frontend/src/pages/QuestionBankPage.tsx`：

1. import 增加 `import QuestionImportModal from '../components/QuestionImportModal';`。
2. 组件内加状态 `const [importOpen, setImportOpen] = useState(false);`。
3. 在 `<h1>题库</h1>` 下一行加「导入题目」按钮：

```tsx
        <div className="question-bank-actions question-bank-import-row">
          <button
            type="button"
            className="interview-submit"
            onClick={() => setImportOpen(true)}
          >
            导入题目
          </button>
        </div>
```

4. 在 `<main>` 内末尾、`</main>` 前渲染模态框：

```tsx
        <QuestionImportModal
          open={importOpen}
          onClose={() => setImportOpen(false)}
          onImported={() => void loadQuestions()}
        />
```

- [ ] **Step 5: 类型检查 + 全部前端测试**

Run: `cd frontend && npx tsc --noEmit -p tsconfig.app.json && npm test`
Expected: 无类型错误；全部 PASS

- [ ] **Step 6: 提交**

```bash
git add frontend/src/components/QuestionImportModal.tsx frontend/src/components/QuestionImportModal.test.tsx frontend/src/pages/QuestionBankPage.tsx
git commit -m "feat(question-bank): import modal with parse-edit-confirm flow"
```

---

### Task 9: 来源标记展示（分组 + 详情出处）

**Files:**
- Modify: `frontend/src/pages/QuestionBankPage.tsx`

**Interfaces:**
- Consumes: `SOURCE_LABELS`（Task 7）、`item.reference`（Task 7 的 `Question` 类型）
- Produces: 题库分组标题带「导入」标记；详情题项（若在题库详情展示）显示「出处」

> 注：题库题目详情在 `QuestionBankPage` 自身展开区展示（`question-detail`），并非 `InterviewDetailPage`（后者是面试详情）。因此「出处」展示放在题库页展开区。

- [ ] **Step 1: 题库分组标题来源标记**

`frontend/src/pages/QuestionBankPage.tsx`：

1. import `SOURCE_LABELS` 从 `'../lib/labels'`（与 `DIMENSION_LABELS` 同行追加）。
2. 分组标题（`:275-281` 附近）——`sessionId === null` 且组内题目 `source === 'import'` 时，在「独立题目」后加来源标记：

```tsx
                      <span className="question-group-title">
                        {sessionId
                          ? `面试 #${sessionId}`
                          : `独立题目${SOURCE_LABELS[items[0]?.source ?? ''] ?? ''}`}
                      </span>
```

> `SOURCE_LABELS[source]` 对 `'import'` 返回 `'导入'`，渲染为「独立题目导入」；对 `'interview'` 返回 `'面试'`（分组标题已含面试 #N，仅 null 组无冲突）。

3. 展开区每题（`:325-329` 维度 pill 之后）追加来源 pill：

```tsx
                              {item.source === 'import' && (
                                <span className="mode-pill">
                                  {SOURCE_LABELS.import}
                                </span>
                              )}
```

- [ ] **Step 2: 详情展开区显示出处**

在 `QuestionBankPage` 的 `question-detail` 区块（`:331-353`），在「参考答案」之后追加：

```tsx
                                  {item.reference && (
                                    <div className="question-detail-section">
                                      <span className="question-detail-label">出处</span>
                                      <p className="question-detail-content">
                                        {item.reference}
                                      </p>
                                    </div>
                                  )}
```

- [ ] **Step 3: 类型检查 + 全部前端测试**

Run: `cd frontend && npx tsc --noEmit -p tsconfig.app.json && npm test`
Expected: 无类型错误；全部 PASS（`Question` 类型已含 `reference`，分组逻辑纯展示无测试需改）

- [ ] **Step 4: 提交**

```bash
git add frontend/src/pages/QuestionBankPage.tsx
git commit -m "feat(question-bank): show import source badge and reference provenance"
```

---

### Task 10: 全量回归验证 + 验收

**Files:**
- 无代码改动

- [ ] **Step 1: 后端全量**

Run: `cd backend && go test ./... && go build ./...`
Expected: 全部 PASS、构建成功

- [ ] **Step 2: 前端全量**

Run: `cd frontend && npm test && npm run build`
Expected: 全部 PASS、构建成功（仅既有 chunk 大小提示）

- [ ] **Step 3: 应用迁移**

```bash
docker compose exec -T mysql mysql -uroot -proot interview < backend/migrations/011_question_import.sql
```

- [ ] **Step 4: 对照 spec 逐条验收**

- [ ] 题库页有「导入题目」入口（Task 8）
- [ ] 文本粘贴 → parse → 编辑候选 → confirm → 题库出现题目，`source='import'`（Task 4/5/8）
- [ ] 图片上传 → OCR → parse → 编辑候选 → confirm → 题库出现题目（Task 3/4/5/8）
- [ ] 题库分组/题目展示「导入」来源标记；有 `reference` 时展开显示「出处」（Task 9）
- [ ] 导入题目有 LLM 四维标签（分类成功时）；失败 NULL 不报错（Task 4 `classifyAsync`）
- [ ] 重复导入提示「新增 X 题，跳过 Y 题重复」（Task 4/8）
- [ ] OCR 未配置时图片导入明确报错「图片识别失败，请改用文本粘贴」，文本导入仍可用（Task 5/8）
- [ ] 导入题目可收藏 / 删除 / 参与组卷练习（现有能力，回归确认）

- [ ] **Step 5: 手工冒烟（若后端 + 前端服务可运行）**

前端 `http://127.0.0.1:5174/questions`：点「导入题目」→ 粘贴文本 → 解析 → 编辑 → 确认导入 → 列表出现带「导入」标记的独立题目。OCR 链路需配置 `ALIYUN_OCR_*`（或复用 `ALIYUN_ACCESS_KEY_ID/SECRET`）。

- [ ] **Step 6: 汇报**

写最终报告至 `.superpowers/sdd/2026-08-20-question-import-ocr/task-10-report.md`，列出验收逐条结果与验证证据。
