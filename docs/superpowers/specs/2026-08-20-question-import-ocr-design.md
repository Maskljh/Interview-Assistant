# 真实面经 / 题目导入（OCR / 图片）— 设计文档

日期：2026-08-20 · 版本：v1 · 状态：待用户审阅

## 背景与目标

题库目前**来源单一**：只能通过「从面试会话导入」（`source = 'interview'`）入库，入口在面试详情页。用户无法把自己看到的真实面经 / 题目（截图、文档、文本）加入私有题库进行练习。

目标：支持把真实面经 / 题目导入私有题库，来源标记为「导入」（`source = 'import'`），与「从面试会话导入」并存，解决题库来源单一问题。导入后自动打四维标签，可正常收藏、筛选、删除、组卷练习。

## 已确认决策

| 维度 | 决策 | 说明 |
|---|---|---|
| 输入形式 | 图片（OCR）+ 文本粘贴 | 覆盖截图与纯文本两种真实场景 |
| OCR 引擎 | 阿里云 OCR（后端中转） | 复用阿里云凭据体系，密钥留在服务端 |
| 题目解析 | 后端 LLM 解析 → 前端可编辑候选 → 确认后入库 | 自动化 + 用户控制 |
| 接口形状 | 两段式：`parse` + `confirm` | 解析与入库职责分离 |
| 岗位标签 | 手动输入（可选） | 面经无 JD，无法沿用 `JobTagFromJD` |
| 去重 | 跳过重复 + 提示新增/跳过数 | 与从面试导入一致（按题干原文） |
| 四维标签 | 复用现有 `classifyAsync` LLM 分类管道 | 不新建标签机制 |

## 现状（关键事实）

| 项 | 现状 |
|---|---|
| `question_bank.source` | `VARCHAR(32)`，现仅取值 `'interview'`（`repo.go:186`） |
| 四维标签 | `llm.ClassifyDimensionsSystem/User` + `classifyAsync`（`service.go:106-126`）异步 LLM 分类，失败降级 `dimension = NULL`，不阻塞导入 |
| 去重 | `repo.InsertBatch`（`repo.go:152-198`）：按 `user_id + question` 精确匹配跳过；已存在且 user_answer 为空则补全 |
| 分组 | 前端 `groupBySession`（`QuestionBankPage.tsx:43-58`）按 `source_session_id` 分组，`NULL` 归「独立题目」组 |
| OCR 能力 | 目前无；有阿里云 OSS SDK 依赖与 `upload` 包（`internal/upload`），可作为外部服务接线参考 |
| 外部服务 | 已有 DeepSeek LLM、阿里云语音、WPS、OSS 多种接线模式（`main.go`、`config.go`） |

## 改动设计

### 1. 数据层（后端）

**迁移 `backend/migrations/010_question_import.sql`**：

```sql
ALTER TABLE question_bank
  ADD COLUMN reference TEXT NULL AFTER user_answer;
```

- `reference`：导入题目的原文出处 / 上下文（面经原文片段），供详情展示「出处」。仅 `source = 'import'` 时可能非空。

**`source` 取值变化**（无 schema 改动，`VARCHAR(32)` 已够）：

- `'interview'`：现有，从面试会话导入
- `'import'`：新增，手动 / OCR 导入

前端 `lib/labels.ts` 新增：

```ts
export const SOURCE_LABELS: Record<string, string> = {
  interview: '面试',
  import: '导入',
};
```

### 2. LLM 解析（后端，`internal/llm`）

新增提示词（沿用现有 `ChatJSON` 模式，输出严格 JSON）：

```go
type ParseImportOut struct {
    Items []struct {
        Question string `json:"question"`
        Answer   string `json:"answer,omitempty"`
    } `json:"items"`
}

func ParseImportSystem() string
func ParseImportUser(text string) string
```

规则要点：
- 从面经文本中抽取**面试题目**（区分 Q/A 与叙述性段落噪音）
- `question` 为完整、可直接作答的题干
- `answer` 可空（面经可能只记题不记答）
- 输出严格 JSON，`question` 用原文，不改写
- 中文（简体）

### 3. OCR（后端，新增 `internal/ocr` 或并入 `internal/import`）

**阿里云 OCR 通用文字识别**（`ocr` 包）：

```go
type Client struct { ... }
func NewClient(cfg Config) *Client
func (c *Client) Recognize(ctx context.Context, image []byte) (string, error)
```

- 配置：`ALIYUN_OCR_ACCESS_KEY_ID` / `ALIYUN_OCR_ACCESS_KEY_SECRET`（或复用现有 `ALIYUN_ACCESS_KEY_ID` / `ALIYUN_ACCESS_KEY_SECRET`，二选一，见「开放问题」）
- 未配置 / 调用失败 → 明确报错，前端引导用文本粘贴
- 图片校验：大小 ≤ 5MB，`image/jpeg` / `image/png` / `image/webp`

### 4. 导入服务（后端，`internal/question` 扩展）

新增方法：

```go
// ParseFromText 解析面经文本为候选题目；LLM 失败时降级返回 raw 供手动编辑。
func (s *Service) ParseFromText(ctx context.Context, text string) (ParseResult, error)

// ParseFromImage OCR 图片后走 ParseFromText。
func (s *Service) ParseFromImage(ctx context.Context, image []byte) (ParseResult, error)

// ImportConfirmed 把用户确认的候选题目入库；source='import'，复用 InsertBatch 去重。
func (s *Service) ImportConfirmed(ctx context.Context, userID int64, items []ParsedQuestion, jobTag string) (ImportResult, error)
```

- `InsertBatch` 扩展支持 `source` / `reference` 参数（新增 `InsertImportedBatch` 或给 `InsertBatch` 加参数）
- 入库后复用 `classifyAsync(userID, allTexts)` 做四维 LLM 分类（失败降级 NULL）
- 返回 `{ imported, skipped }`

### 5. 接口层（后端）

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| `POST` | `/api/questions/import/parse` | `{ text: string, job_tag?: string }` 或 `multipart/form-data`（`file` + `job_tag`） | `{ items: [{question, answer?}], raw?: string, ocr_text?: string }` |
| `POST` | `/api/questions/import/confirm` | `{ items: [{question, answer?, reference?}], job_tag?: string }` | `{ imported: number, skipped: number }` |

> parse 接口同时接受 JSON（文本）与 multipart（图片），由 `Content-Type` 分发到 `ParseFromText` / `ParseFromImage`。也可拆成两个路径（`/parse-text`、`/parse-image`），见「开放问题」。

### 6. 前端（`frontend`）

**题库页 `QuestionBankPage.tsx`** 顶部加「导入题目」按钮，打开导入流程（模态框或独立页面，建议模态框）：

1. **输入 Tab**
   - 文本粘贴 textarea
   - 图片上传（拖拽 + 点击选择，预览）
   - 可选「岗位标签」输入框
2. **解析结果 Tab**（parse 成功后）
   - 候选题目列表，每行可编辑题干 / 答案，可删除行、可手动新增行
   - 展示「已解析 X 题」
   - 解析失败时展示 raw 文本供手动整理
3. **确认入库**
   - 调 confirm 接口 → 显示「新增 X 题，跳过 Y 题重复」→ 刷新题库列表

**分组展示**：`source = 'import'` 的题目 `source_session_id = NULL`，天然进「独立题目」组。组标题逻辑保持「面试 #N / 独立题目」，可在「独立题目」旁加来源标记「导入」以便区分（可选项）。

**详情展开**：题项展开区，若 `source === 'import'` 且有 `reference`，展示「出处」区块。

**API 客户端 `frontend/src/api/questions.ts`** 新增：

```ts
parseImportText(text: string, jobTag?: string): Promise<ImportParseResult>
parseImportImage(file: File, jobTag?: string): Promise<ImportParseResult>
confirmImport(items: ImportItem[], jobTag?: string): Promise<{ imported: number; skipped: number }>
```

### 7. 错误处理与降级

| 场景 | 行为 |
|---|---|
| OCR 未配置 / 调用失败 | 明确报错「图片识别失败，请改用文本粘贴」 |
| LLM 解析失败 | 返回原文 `raw`，前端进入手动编辑模式 |
| LLM 四维分类失败 | 题照常入库，`dimension = NULL`（现状即如此） |
| 图片超限 / 类型不符 | 前端先校验，后端再兜底 400 |
| 重复题目 | 跳过，统计 `skipped` 返回前端提示 |

### 8. 测试

**后端**（`service_test.go`、`handler_test.go`）：
- `ImportConfirmed`：入库 `source='import'`、`source_session_id NULL`、`job_tag` 透传、`reference` 落库
- 去重：重复题干跳过、`skipped` 计数正确、已存在且无 user_answer 不覆盖
- `ParseFromText`：LLM 成功 → 结构化；LLM 失败 → 降级 raw
- OCR client：用 fake 服务测试请求/响应解析（沿用 `speech/fake.go` 模式）

**前端**（vitest + jsdom）：
- `SOURCE_LABELS` 映射
- 导入流程组件：parse → 编辑 → confirm 状态流转、错误提示
- 分组展示对 `source='import'` 题目的归属

### 9. 验收标准

- [ ] 题库页有「导入题目」入口
- [ ] 文本粘贴 → parse → 编辑候选 → confirm → 题库出现题目
- [ ] 图片上传 → OCR → parse → 编辑候选 → confirm → 题库出现题目
- [ ] 导入题目 `source='import'`，题库展示来源标记「导入」
- [ ] 导入题目有 LLM 四维标签（分类成功时）；失败则 NULL 不报错
- [ ] 重复导入：提示「新增 X 题，跳过 Y 题重复」
- [ ] 导入题目可收藏 / 删除 / 参与组卷练习（focused）
- [ ] OCR 不可用时明确报错并可改用文本粘贴
- [ ] `npm test`、`npm run build`、后端 `go test ./...` 通过

## 非目标（YAGNI）

- 不做 PDF / Word 文档导入（本期仅图片 + 文本）
- 不做 OSS 中转上传（图片直接 multipart 到后端，后端调 OCR）
- 不做导入题的批量手动维度编辑 UI（沿用自动分类 + 失败降级）
- 不做跨用户共享题库 / 公共题库
- 不改现有「从面试会话导入」链路
- 不引入独立的 OCR 数据库表（识别文本即用即弃，不入库）

## 开放问题（实现计划前需定）

1. **OCR 凭据**：复用现有 `ALIYUN_ACCESS_KEY_ID/SECRET` 还是新增独立 `ALIYUN_OCR_*`？
2. **parse 接口形状**：一个路径按 Content-Type 分发，还是拆 `/parse-text` + `/parse-image` 两个路径？
3. **reference 落库**：确认阶段每条题目带一个可选 `reference`（原文片段），还是 confirm 请求整体带一份原文？（影响数据量与详情展示方式）
