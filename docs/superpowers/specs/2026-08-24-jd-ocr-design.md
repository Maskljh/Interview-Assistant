# 新建面试 JD 支持图片 OCR — 设计文档

日期：2026-08-24 · 版本：v1 · 状态：待用户审阅

## 背景与目标

新建面试时，职位描述（JD）目前只能**粘贴文本**或**上传 .txt/.md/.pdf/.docx 文件**（`CreateInterviewPage.handleJdFile` 用 `extractResumeText` 提取文字，**不支持图片**）。用户经常遇到从招聘 App / 网页截图 JD 的情况，手动打字费时且易错。

目标：新建面试页的职位描述区**新增图片上传**，用已实现的阿里云 OCR 识别图片文字，**自动填入 JD 文本框**（用户可继续编辑），免去手动录入。

## 已确认决策

| 项 | 决策 | 说明 |
|---|---|---|
| 范围 | 仅 JD 支持图片 OCR | 简历（resume）保持不变 |
| 结果处理 | OCR 识别后自动填入 JD 文本框 | 填入后可继续编辑 |
| 图片存档 | 不上传 OSS | 识别文本即用即弃，与题库导入的 `reference` 无关 |

## 现状（关键事实）

| 项 | 现状 |
|---|---|
| OCR 能力 | `internal/ocr` 已实现（`Client.Recognize(ctx, image) → text`），内部用阿里云官方 SDK，真实调用已验证可用 |
| OCR 注入 | `main.go:69-83` 构造 `ocrClient`，注入 `question.RegisterRoutes`（题库导入用 `ParseFromImage`） |
| 题库导入接口 | `POST /api/questions/import/parse`：图片 → OCR + **LLM 解析抽题**（对 JD 不合适，JD 是职位描述不是题目） |
| speech handler 模式 | `internal/speech/handler.go`：`RegisterRoutes(r, secret, client)` + multipart `FormFile`，是新增 OCR handler 的参考 |
| 前端 JD 文件 | `CreateInterviewPage.handleJdFile`（:127-162）用 `extractResumeText`，accept 无图片类型 |

## 改动设计

### 1. 后端：新增纯 OCR 识别接口

**新增 `backend/internal/ocr/handler.go`**：

- `POST /api/ocr/recognize`（受 JWT 保护）
  - 请求：multipart 上传 `file`（图片）
  - 校验：大小 ≤ 5MB、`http.DetectContentType` ∈ `image/jpeg` / `image/png` / `image/webp`
  - 调用 `client.Recognize(ctx, image)` → `{"text": "识别文本"}`
  - `client == nil`（OCR 未配置）→ `502 {"error":"image recognition unavailable, please use text input"}`
  - 图片超限 → `400 {"error":"image is too large"}`；类型不符 → `400 {"error":"unsupported image type"}`
- `RegisterRoutes(r *gin.Engine, secret string, client Client)`，路由组 `/api/ocr`
- 复用现有 `ocr.Client` 接口与 `main.go` 的 `ocrClient`（**不重复构造**）

**`backend/cmd/server/main.go`**：在 `question.RegisterRoutes` 附近加：

```go
	ocr.RegisterRoutes(r, cfg.JWTSecret, ocrClient)
```

### 2. 前端：新建面试页 JD 区加图片上传

**`frontend/src/api/ocr.ts`（新增）**：

```ts
export async function recognizeImage(file: File): Promise<{ text: string }>
```

- multipart 原生 fetch（同 `parseImportImage` 模式，避免 JSON Content-Type）
- 错误映射：502/不可用时提示「图片识别失败，请改用文本粘贴」

**`frontend/src/pages/CreateInterviewPage.tsx`**：

- JD 字段区（`job-jd` textarea 下方，现有「上传 .txt/.pdf/.docx」文件行旁）新增「或上传 JD 图片」文件选择：
  - `accept="image/jpeg,image/png,image/webp"`
  - 选择后调 `recognizeImage(file)` → `setJobJd(text)` → `setPrecheckStale(true)` → 显示识别字数
  - 错误处理：OCR 不可用提示「图片识别失败，请改用文本粘贴」；成功填入后可继续编辑
- 新增 state：`jdOcrName`（识别文件名）、`jdOcrRecognizing`（识别中标记）
- 保留现有 `handleJdFile`（.txt/.pdf/.docx 解析）不变——**新增独立处理函数**，互不干扰

### 3. 错误处理与降级

| 场景 | 行为 |
|---|---|
| OCR 未配置 / 调用失败 | 明确提示「图片识别失败，请改用文本粘贴」，JD 文本框保持原值 |
| 图片超限 / 类型不符 | 前端先校验（5MB、type），后端兜底 400 |
| 识别文本为空 | 提示「未识别到文字，请尝试更清晰的图片」 |
| 识别后用户编辑 | 文本在 textarea 中，可随意修改（与手动粘贴一致） |

### 4. 测试

**后端**（`internal/ocr/handler_test.go`）：
- multipart 图片 → 200 `{"text":"..."}`（fake OCR client）
- 无 OCR client → 502
- 超大文件 → 400；非图片类型 → 400

**前端**（vitest）：
- `recognizeImage` API 客户端测试（multipart、错误映射）
- `CreateInterviewPage`：选图片 → mock recognizeImage 返回文本 → 断言 `jobJd` 填入

### 5. 验收标准

- [ ] 新建面试页 JD 区有「上传 JD 图片」入口
- [ ] 选择 JD 截图 → OCR 识别 → 文本自动填入职位描述文本框
- [ ] 填入后可继续编辑，precheck 标记为 stale
- [ ] OCR 不可用时明确提示「图片识别失败，请改用文本粘贴」，文本粘贴不受影响
- [ ] 简历区无图片上传（保持现状）
- [ ] 后端 `go test ./...`、前端 `npm test`、`npm run build` 通过

## 非目标（YAGNI）

- 简历不支持图片 OCR
- 图片不上传 OSS 存档
- 不做 OCR 前的预览/确认弹窗（自动填入，用户可改）
- 不改题库导入的 OCR 链路（`/api/questions/import/parse` 保持原样）
- 不引入 OCR 结果缓存 / 历史记录
