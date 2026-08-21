# 简历 / JD 文件上传 OSS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 支持简历/JD 原文件上传阿里云 OSS 存档，前端直传 + 后端预签名，文件 URL 存库，详情页可查看原文件。

**Architecture:** 后端新 `internal/upload` 模块提供 `POST /api/uploads/sign`（JWT 保护，用 aliyun-oss-go-sdk 生成预签名 PUT URL）；前端 `signUpload` 取签名后 fetch PUT 直传 OSS，提交创建面试时带对象 URL；`interview_sessions` 新增 `resume_file_url`/`jd_file_url` 列。

**Tech Stack:** Go/Gin（后端）、aliyun-oss-go-sdk、React 19 + TS + Vite（前端）、MySQL migration、vitest。

## Global Constraints

- 前端本地解析逻辑（`extractResumeText`）保留，文本仍用于匹配度与出题。
- 敏感凭据仅写 `.env`（已被 gitignore），任何 commit 不得含真实 AK/SK。
- 签名接口仅登录用户可用（JWT 中间件）。
- 对象 key 前缀 `uploads/{userId}/`，UUID 重命名保留扩展名；PUT URL 有效期 300s；size ≤ 10MB；扩展名 `.txt .md .pdf .docx`；`kind` ∈ {resume, jd}。
- 中文用户可见文案。
- 不选文件时行为与现状完全一致（无回归）。
- 后端测试 `go test ./...`、前端 `npm test` + `npm run build`。

---

### Task 1: 后端 config OSS 配置 + upload 签名模块

**Files:**
- Modify: `backend/internal/config/config.go`
- Create: `backend/internal/upload/service.go`
- Create: `backend/internal/upload/handler.go`
- Modify: `backend/cmd/server/main.go`
- Test: `backend/internal/upload/service_test.go`

**Interfaces:**
- Produces:
  - `config.Config` 新增字段：`OSSBucket`, `OSSRegion`, `OSSEndpoint`, `OSSAccessKeyID`, `OSSAccessKeySecret`（从 env `OSS_BUCKET`/`OSS_REGION`/`OSS_ENDPOINT`/`OSS_ACCESS_KEY_ID`/`OSS_ACCESS_KEY_SECRET`）
  - `upload.NewService(cfg OSSConfig, userID int64)` → `*Service`，其中 `OSSConfig{ Bucket, Region, Endpoint, AccessKeyID, AccessKeySecret string }`
  - `upload.SignUpload(kind, filename, contentType string, size int64) (key, putURL, objectURL string, expiresIn int, err error)`
  - `upload.RegisterRoutes(r *gin.Engine, secret string, svc *Service)`

- [ ] **Step 1: config 新增 OSS 字段**

`backend/internal/config/config.go`：
- `Config` 结构体新增：
```go
	OSSBucket          string
	OSSRegion          string
	OSSEndpoint        string
	OSSAccessKeyID     string
	OSSAccessKeySecret string
```
- `Load()` 内新增：
```go
		OSSBucket:          os.Getenv("OSS_BUCKET"),
		OSSRegion:          os.Getenv("OSS_REGION"),
		OSSEndpoint:        os.Getenv("OSS_ENDPOINT"),
		OSSAccessKeyID:     os.Getenv("OSS_ACCESS_KEY_ID"),
		OSSAccessKeySecret: os.Getenv("OSS_ACCESS_KEY_SECRET"),
```

- [ ] **Step 2: 写 service_test（失败先行）**

`backend/internal/upload/service_test.go`:
```go
package upload

import (
	"testing"
)

func TestValidateSignRequest(t *testing.T) {
	cases := []struct {
		name        string
		kind        string
		filename    string
		contentType string
		size        int64
		wantErr     bool
	}{
		{"resume pdf ok", "resume", "a.pdf", "application/pdf", 1024, false},
		{"jd txt ok", "jd", "b.txt", "text/plain", 1024, false},
		{"bad kind", "other", "a.pdf", "application/pdf", 1024, true},
		{"bad ext", "resume", "a.exe", "application/octet-stream", 1024, true},
		{"too big", "resume", "a.pdf", "application/pdf", 11 * 1024 * 1024, true},
		{"empty filename", "resume", "", "application/pdf", 1024, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := validateSignRequest(tc.kind, tc.filename, tc.contentType, tc.size)
			if (err != nil) != tc.wantErr {
				t.Fatalf("validateSignRequest(%q,%q,%q,%d) err=%v wantErr=%v", tc.kind, tc.filename, tc.contentType, tc.size, err, tc.wantErr)
			}
		})
	}
}
```

- [ ] **Step 3: 运行确认失败**

Run (in `backend/`): `go test ./internal/upload/ -run TestValidateSignRequest`
Expected: FAIL（package 不存在）

- [ ] **Step 4: 实现 service.go**

`backend/internal/upload/service.go`:
```go
package upload

import (
	"fmt"
	"strings"
	"time"

	"github.com/aliyun/aliyun-oss-go-sdk/oss"
)

const (
	MaxFileSize = 10 * 1024 * 1024 // 10MB
	PutURLTTL   = 5 * time.Minute

	KindResume = "resume"
	KindJD     = "jd"
)

var allowedExts = map[string]bool{
	".txt": true, ".md": true, ".pdf": true, ".docx": true,
}

var allowedContentTypes = map[string]bool{
	"text/plain":  true,
	"text/markdown": true,
	"application/pdf": true,
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document": true,
	"application/msword": true,
}

func validateSignRequest(kind, filename, contentType string, size int64) error {
	if kind != KindResume && kind != KindJD {
		return fmt.Errorf("invalid kind")
	}
	if size <= 0 || size > MaxFileSize {
		return fmt.Errorf("invalid size")
	}
	dot := strings.LastIndexByte(filename, '.')
	if dot < 0 {
		return fmt.Errorf("unsupported file type")
	}
	ext := strings.ToLower(filename[dot:])
	if !allowedExts[ext] {
		return fmt.Errorf("unsupported file type")
	}
	if contentType != "" && !allowedContentTypes[contentType] {
		return fmt.Errorf("unsupported content type")
	}
	return nil
}

type OSSConfig struct {
	Bucket          string
	Region          string
	Endpoint        string
	AccessKeyID     string
	AccessKeySecret string
}

type Service struct {
	cfg    OSSConfig
	userID int64
}

func NewService(cfg OSSConfig, userID int64) *Service {
	return &Service{cfg: cfg, userID: userID}
}

func (s *Service) SignUpload(kind, filename, contentType string, size int64) (key, putURL, objectURL string, expiresIn int, err error) {
	if err = validateSignRequest(kind, filename, contentType, size); err != nil {
		return "", "", "", 0, err
	}
	client, err := oss.New(s.cfg.Endpoint, s.cfg.AccessKeyID, s.cfg.AccessKeySecret)
	if err != nil {
		return "", "", "", 0, err
	}
	bucket, err := client.Bucket(s.cfg.Bucket)
	if err != nil {
		return "", "", "", 0, err
	}

	dot := strings.LastIndexByte(filename, '.')
	ext := strings.ToLower(filename[dot:])
	key = fmt.Sprintf("uploads/%d/%d%s", s.userID, time.Now().UnixNano(), ext)

	putURL, err = bucket.SignURL(key, oss.HTTPPut, PutURLTTL)
	if err != nil {
		return "", "", "", 0, err
	}
	objectURL = s.cfg.Endpoint + "/" + key
	return key, putURL, objectURL, int(PutURLTTL.Seconds()), nil
}
```

> 注意：`oss.HTTPPut` 签名 URL 会带 `?OSSAccessKeyId=...&Expires=...&Signature=...`。objectURL 用 endpoint + key 拼接（不带头尾斜杠问题：endpoint 已含 `https://`，key 无前导 `/`，中间加 `/`）。

- [ ] **Step 5: handler.go**

`backend/internal/upload/handler.go`:
```go
package upload

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/interview-assistant/backend/internal/auth"
)

type signRequest struct {
	Kind        string `json:"kind"`
	Filename    string `json:"filename"`
	ContentType string `json:"content_type"`
	Size        int64  `json:"size"`
}

type signResponse struct {
	Key       string `json:"key"`
	PutURL    string `json:"put_url"`
	ObjectURL string `json:"object_url"`
	ExpiresIn int    `json:"expires_in"`
}

func RegisterRoutes(r *gin.Engine, secret string, svc *Service) {
	g := r.Group("/api/uploads")
	g.Use(auth.Middleware(secret))
	g.POST("/sign", func(c *gin.Context) {
		userID, ok := c.Get("userID")
		if !ok {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
			return
		}
		var req signRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request"})
			return
		}
		key, putURL, objectURL, expiresIn, err := svc.SignUpload(req.Kind, req.Filename, req.ContentType, req.Size)
		if err != nil {
			msg := err.Error()
			status := http.StatusBadRequest
			if msg == "oss not configured" {
				status = http.StatusServiceUnavailable
			}
			c.JSON(status, gin.H{"error": msg})
			return
		}
		c.JSON(http.StatusOK, signResponse{Key: key, PutURL: putURL, ObjectURL: objectURL, ExpiresIn: expiresIn})
	})
}
```

- [ ] **Step 6: main.go 注册路由 + 处理未配置**

`backend/cmd/server/main.go`：
- 在 `svc` 初始化附近新增：
```go
	uploadSvc := upload.NewService(upload.OSSConfig{
		Bucket:          cfg.OSSBucket,
		Region:          cfg.OSSRegion,
		Endpoint:        cfg.OSSEndpoint,
		AccessKeyID:     cfg.OSSAccessKeyID,
		AccessKeySecret: cfg.OSSAccessKeySecret,
	}, 0)
```
- import 加 `"github.com/interview-assistant/backend/internal/upload"`
- 路由注册处加：`upload.RegisterRoutes(r, cfg.JWTSecret, uploadSvc)`

> service.go 中应处理 bucket/endpoint 为空的情况：在 `SignUpload` 开头检查 `s.cfg.Endpoint == "" || s.cfg.Bucket == "" || s.cfg.AccessKeyID == ""` 返回 `errors.New("oss not configured")`。此逻辑由 implementer 补全（见 Step 4 说明）。

- [ ] **Step 7: 测试 + 构建**

Run (in `backend/`): `go test ./internal/upload/...`
Expected: PASS（validateSignRequest 6 用例）
Run: `go build ./...`
Expected: 成功

- [ ] **Step 8: 提交**

```bash
git add backend/internal/config/config.go backend/internal/upload/ backend/cmd/server/main.go
git commit -m "feat(upload): OSS presigned upload sign endpoint"
```

---

### Task 2: interview 模块扩展 file_url 字段 + migration

**Files:**
- Create: `backend/migrations/010_oss_urls.sql`
- Modify: `backend/internal/interview/models.go`
- Modify: `backend/internal/interview/repo.go`
- Modify: `backend/internal/interview/service.go`
- Modify: `backend/internal/interview/handler.go`

**Interfaces:**
- Consumes: 无新依赖（本任务在现有 interview 模块内）
- Produces:
  - `Session.ResumeFileURL *string`、`Session.JDFileURL *string`
  - `createRequest.ResumeFileURL *string`、`createRequest.JDFileURL *string`（json `resume_file_url`/`jd_file_url`）
  - `sessionResponse.ResumeFileURL *string`、`sessionResponse.JDFileURL *string`（json 同名）

- [ ] **Step 1: migration 文件**

`backend/migrations/010_oss_urls.sql`:
```sql
ALTER TABLE interview_sessions
  ADD COLUMN resume_file_url VARCHAR(1024) NULL AFTER resume_text,
  ADD COLUMN jd_file_url VARCHAR(1024) NULL AFTER job_jd;
```

- [ ] **Step 2: 读 repo.go 与 service.go 现状**

先读 `backend/internal/interview/repo.go` 与 `service.go`，确定 `Session` 结构体的 SQL 扫描列、`Create` 方法的 INSERT 语句、`Get` 的 SELECT 列。

- [ ] **Step 3: models.go 加字段**

`Session` 结构体新增：
```go
	ResumeFileURL *string
	JDFileURL     *string
```

- [ ] **Step 4: repo.go 更新 SQL**

- `INSERT` 语句加 `resume_file_url, jd_file_url` 列与 `?` 占位符
- `SELECT` 语句（Get/List/ScanSession）加两列
- 扫描目标加 `&s.ResumeFileURL, &s.JDFileURL`

- [ ] **Step 5: service.go Create 传递**

`Create(...)` 方法签名加 `resumeFileURL, jdFileURL *string` 参数，透传到 repo。

- [ ] **Step 6: handler.go**

- `createRequest` 加：
```go
	ResumeFileURL *string `json:"resume_file_url"`
	JDFileURL     *string `json:"jd_file_url"`
```
- `Create` 调用 `h.svc.Create(..., req.ResumeFileURL, req.JDFileURL)`
- `sessionResponse` 加两字段；`toSessionResponse` 赋值 `session.ResumeFileURL`、`session.JDFileURL`

- [ ] **Step 7: 测试 + 构建**

Run (in `backend/`): `go build ./...`
Expected: 成功
Run: `go test ./internal/interview/...`
Expected: PASS（现有测试，新增字段不影响）

> 注意：若 repo_test 用固定列断言，需同步更新。以现有测试实际结构为准。

- [ ] **Step 8: 提交**

```bash
git add backend/migrations/010_oss_urls.sql backend/internal/interview/
git commit -m "feat(interview): persist resume/jd file URLs on session"
```

---

### Task 3: 前端签名 + 直传 + 创建页集成

**Files:**
- Create: `frontend/src/api/uploads.ts`
- Create: `frontend/src/lib/ossUpload.ts`
- Modify: `frontend/src/api/interviews.ts`
- Modify: `frontend/src/pages/CreateInterviewPage.tsx`

**Interfaces:**
- Consumes: 后端 `POST /api/uploads/sign`、`POST /api/interviews` 新字段
- Produces:
  - `signUpload(kind: 'resume' | 'jd', file: File): Promise<{ key: string; put_url: string; object_url: string; expires_in: number }>`
  - `uploadToOSS(putUrl: string, file: File, onProgress?: (pct: number) => void): Promise<void>`

- [ ] **Step 1: uploads.ts**

`frontend/src/api/uploads.ts`:
```ts
import { request } from './client';

export interface SignUploadOut {
  key: string;
  put_url: string;
  object_url: string;
  expires_in: number;
}

export type UploadKind = 'resume' | 'jd';

export async function signUpload(kind: UploadKind, file: File): Promise<SignUploadOut> {
  return request('/api/uploads/sign', {
    method: 'POST',
    body: JSON.stringify({
      kind,
      filename: file.name,
      content_type: file.type || 'application/octet-stream',
      size: file.size,
    }),
  });
}
```

> 注意：需确认 `request` 是否在 `./client` 导出且能传 `application/json`。若 client 的 fetchJSON 已设 Content-Type: application/json，直接使用。Implementer 读 `frontend/src/api/client.ts` 确认导出名与签名。

- [ ] **Step 2: ossUpload.ts**

`frontend/src/lib/ossUpload.ts`:
```ts
export async function uploadToOSS(
  putUrl: string,
  file: File,
  onProgress?: (pct: number) => void,
): Promise<void> {
  const res = await fetch(putUrl, {
    method: 'PUT',
    body: file,
    headers: { 'Content-Type': file.type || 'application/octet-stream' },
  });
  if (!res.ok) {
    throw new Error(`上传失败（${res.status}）`);
  }
  onProgress?.(100);
}
```
> 说明：fetch 上传的进度监听用 `XMLHttpRequest` 更准确，但 fetch 简化实现（无进度回调仍可用）；若需真实进度，implementer 可改用 XHR 的 `upload.onprogress`。spec 要求显示进度，建议用 XHR：
```ts
export function uploadToOSS(
  putUrl: string,
  file: File,
  onProgress?: (pct: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', putUrl);
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) {
        onProgress(Math.round((e.loaded / e.total) * 100));
      }
    };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`上传失败（${xhr.status}）`)));
    xhr.onerror = () => reject(new Error('网络异常，上传失败'));
    xhr.send(file);
  });
}
```

- [ ] **Step 3: interviews.ts**

`createInterview` 请求体加 `resume_file_url`、`jd_file_url`。读现有 `createInterview` 签名后扩展参数（可加可选参数 `resumeFileUrl?: string`、`jdFileUrl?: string`）。

- [ ] **Step 4: CreateInterviewPage.tsx 集成**

- 状态新增：
```ts
const [resumeUploading, setResumeUploading] = useState(false);
const [resumeFileUrl, setResumeFileUrl] = useState('');
const [resumeProgress, setResumeProgress] = useState(0);
const [jdFileName, setJdFileName] = useState('');
const [jdUploading, setJdUploading] = useState(false);
const [jdFileUrl, setJdFileUrl] = useState('');
const [jdProgress, setJdProgress] = useState(0);
```
- `handleResumeFile`：现有解析后，追加上传 OSS：
```ts
const text = await extractResumeText(file);
setResumeText(text);
setResumeFileName(file.name);
setResumeUploading(true);
setResumeProgress(0);
try {
  const sign = await signUpload('resume', file);
  await uploadToOSS(sign.put_url, file, (pct) => setResumeProgress(pct));
  setResumeFileUrl(sign.object_url);
} catch (err) {
  // 上传失败不阻断：保留解析文本，仅提示
  setResumeFileUrl('');
  setError(err instanceof Error ? err.message : '简历文件上传失败（文本已解析可用）');
} finally {
  setResumeUploading(false);
}
```
- JD 文件上传：新增 file input（可选），选择后：
  - 读文件文本填入 `jobJd`（复用 `extractResumeText`）
  - 上传 OSS 存 `jdFileUrl`
- `handleSubmit`（提交创建）时把 `resumeFileUrl`/`jdFileUrl` 传入 `createInterview`
- 显示上传进度条/百分比文本（如 `上传中… 42%`）

> 说明：需读 CreateInterviewPage 现有的提交函数名（可能是 `handleCreate`/`handleSubmit`）与 JD textarea 结构，按其实际结构调整。中文文案精确：`上传中… {pct}%`、`简历文件上传失败（文本已解析可用）`。

- [ ] **Step 5: 类型检查 + 测试**

Run (in `frontend/`): `npx tsc --noEmit -p tsconfig.app.json`
Expected: 无错误
Run: `npm test`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add frontend/src/api/uploads.ts frontend/src/lib/ossUpload.ts frontend/src/api/interviews.ts frontend/src/pages/CreateInterviewPage.tsx
git commit -m "feat(create): upload resume/JD files to OSS on interview creation"
```

---

### Task 4: 详情页原文件链接

**Files:**
- Modify: `frontend/src/pages/InterviewDetailPage.tsx`

**Interfaces:**
- Consumes: `sessionResponse.ResumeFileURL`/`sessionResponse.JDFileURL`（后端 Get 返回）
- Produces: 无

- [ ] **Step 1: 显示原文件链接**

在 `InterviewDetailPage.tsx` 的 meta/链接区（`.interview-list-links` 或 meta 下方）新增：
```tsx
{(interview.resume_file_url || interview.jd_file_url) && (
  <div className="interview-list-links" style={{ marginBottom: 'var(--space-md)' }}>
    {interview.resume_file_url && (
      <a className="interview-inline-link" href={interview.resume_file_url} target="_blank" rel="noreferrer">
        查看简历原文件
      </a>
    )}
    {interview.jd_file_url && (
      <a className="interview-inline-link" href={interview.jd_file_url} target="_blank" rel="noreferrer">
        查看 JD 原文件
      </a>
    )}
  </div>
)}
```
> 注意：`Interview` 类型（`../api/interviews`）需加 `resume_file_url`/`jd_file_url` 字段。Implementer 读该类型定义并更新。

- [ ] **Step 2: 类型检查 + 测试**

Run (in `frontend/`): `npx tsc --noEmit -p tsconfig.app.json`
Expected: 无错误
Run: `npm test`
Expected: PASS

- [ ] **Step 3: 提交**

```bash
git add frontend/src/api/interviews.ts frontend/src/pages/InterviewDetailPage.tsx
git commit -m "feat(detail): show resume/JD original file links"
```

---

### Task 5: 全量回归验证

**Files:**
- 无代码改动

- [ ] **Step 1: 后端测试**

Run (in `backend/`): `go test ./...`
Expected: 全部 PASS（注意：若 MySQL 环境缺失导致部分测试失败，记录并区分环境问题 vs 代码问题）

- [ ] **Step 2: 前端测试 + 构建**

Run (in `frontend/`): `npm test` + `npm run build`
Expected: 全部 PASS

- [ ] **Step 3: 验证验收标准**

对照 spec 逐条确认（后端 + 前端）：
- config 读取 OSS 配置；缺失时返回 503「oss not configured」（可用临时移除 env 的方式手动验证，或代码审查）
- `POST /api/uploads/sign` 返回 put_url/key/object_url（curl 或 Playwright）
- 直传 OSS 成功、详情页能打开原文件（需真实上传；若环境无网络访问 OSS，说明限制）
- 创建面试带 URL 时正确存库、详情返回
- 不选文件行为不变（回归）

环境提示：后端 9090 + 前端预览 5174。OSS 直传需要真实外网访问阿里云，若沙箱禁止，记录为环境限制并在报告说明。

- [ ] **Step 4: 汇报**

写最终报告至 `.superpowers/sdd/2026-08-20-oss-upload/task-5-report.md`，列出验收逐条结果与验证证据。
