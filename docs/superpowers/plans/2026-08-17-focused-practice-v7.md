# V7 错题本专项训练（薄弱维度组卷）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 题库题目打四维标签（导入时 LLM 自动分类），新建页画像卡一键按薄弱维度从题库组卷（starred 优先）发起 from-bank 专项面试；题库页加维度筛选。

**Architecture:** 迁移 `006_question_dimension.sql` 给 `question_bank` 加 `dimension` 列；`llm` 包新增 `ClassifyDimensionsSystem`/`ClassifyDimensionsUser`；`question.Service` 注入 `llm.Client`，ImportFromSession 导入后 LLM 批量分类（失败降级为 NULL）；repo `List` 支持 `dimension` 过滤；新增 `POST /api/questions/question-bank/focused` 按维度组卷；前端画像卡加「针对薄弱点开始练习」按钮（focused → from-bank → 跳房间），题库页加维度下拉。

**Tech Stack:** Go/Gin、MySQL（迁移 006）、React/Vite TS、既有 `fetchJSON` 客户端。

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-17-focused-practice-design.md`
- 分支 `feat/v7-focused-practice` from main HEAD
- 迁移 `backend/migrations/006_question_dimension.sql`：`ALTER TABLE question_bank ADD COLUMN dimension VARCHAR(16) NULL AFTER job_tag;`
- **跑 question 集成测试前先执行迁移**：`docker compose exec -T mysql mysql -uroot -proot interview < backend/migrations/006_question_dimension.sql`（worktree 无 compose mysql 时用 `docker exec -i feat-v2b-voice-mysql-1 mysql -uroot -proot interview < ...`；MySQL 容器名为 `feat-v2b-voice-mysql-1`）
- `dimension` ∈ `expression | logic | content | job_match`，NULL = 未分类（存量/分类失败）
- LLM 分类失败 → 题目照常入库（dimension NULL），导入不报错、不阻塞
- focused 组卷：每维 starred 优先、created_at DESC、每维 ≤N（默认 5，范围 1–10）、总题数 ≤10；`dimensions` 空 → 400；非法 dimension → 400
- `GET /api/questions?dimension=X`：dimension 非空时加 `AND dimension = ?` 过滤
- from-bank 路径不出题（无 LLM 出题调用）——存量行为不变
- 分类 prompt 用**原文回显**匹配题目（question 原文 → dimension）
- 测试 email 前缀沿用 `test-question-%@example.com`（question 测试 cleanup 已有）
- 前端：画像卡按钮仅在有 `weak_dimensions` 时显示；无题提示不创建；`npm run build` 通过

---

## File map

| Path | Responsibility |
|------|----------------|
| `backend/migrations/006_question_dimension.sql` | dimension 列 |
| `backend/internal/llm/prompts.go` | `ClassifyDimensionsSystem` / `ClassifyDimensionsUser` |
| `backend/internal/llm/prompts_test.go` | 分类 prompt 用例 |
| `backend/internal/question/models.go` | `Item.Dimension *string` + `ListFilter.Dimension` |
| `backend/internal/question/repo.go` | SELECT 加 dimension、List 过滤、`UpdateDimension`、`ListByDimensionForFocused` |
| `backend/internal/question/service.go` | `Service.llm` + `NewService(db, llmClient)` + ImportFromSession 分类 + `Focused` 组卷 |
| `backend/internal/question/handler.go` | `RegisterRoutes(r, db, secret, llmClient)` + List 读 dimension 参数 + `POST /question-bank/focused` |
| `backend/internal/question/service_test.go` | 分类成功/失败降级、List 过滤、focused 组卷用例 + 既有调用更新 |
| `backend/cmd/server/main.go` | `question.RegisterRoutes(r, sqlDB, cfg.JWTSecret, llmClient)` |
| `frontend/src/api/questions.ts` | `Question.dimension` + `dimension` 参数 + `fetchFocusedQuestions` |
| `frontend/src/pages/CreateInterviewPage.tsx` | 画像卡「针对薄弱点开始练习」按钮 + 组卷流程 |
| `frontend/src/pages/QuestionBankPage.tsx` | 维度筛选下拉 |
| `frontend/src/lib/labels.ts` | `DIMENSION_LABELS` 导出（复用 V3 的本地映射） |
| `docs/superpowers/specs/2026-08-17-focused-practice-design.md` | Status → Implemented |

---

### Task 1: 迁移 + llm 维度分类 prompt

**Files:**
- Create: `backend/migrations/006_question_dimension.sql`
- Modify: `backend/internal/llm/prompts.go`, `backend/internal/llm/prompts_test.go`

**Interfaces:**
- Consumes: 无（新函数）
- Produces:
  - `type ClassifyOut struct { Classifications []struct { Question string `json:"question"`; Dimension string `json:"dimension"` } `json:"classifications"` }`
  - `func ClassifyDimensionsSystem() string`
  - `func ClassifyDimensionsUser(questions []string) string`

- [ ] **Step 1: 写迁移文件**

```sql
-- backend/migrations/006_question_dimension.sql
ALTER TABLE question_bank
  ADD COLUMN dimension VARCHAR(16) NULL AFTER job_tag;
```

- [ ] **Step 2: 写分类 prompt**

`backend/internal/llm/prompts.go` 末尾追加：

```go
type ClassifyOut struct {
	Classifications []struct {
		Question  string `json:"question"`
		Dimension string `json:"dimension"`
	} `json:"classifications"`
}

// ClassifyDimensionsSystem instructs the model to tag each question with one
// of the four interview assessment dimensions.
func ClassifyDimensionsSystem() string {
	return `You are an interview coach. Tag each question with the interview dimension it assesses.

Respond with valid JSON only, no markdown fences or extra text. Use this exact schema:
{"classifications":[{"question":"...","dimension":"..."}]}

Rules:
- The question field must echo the original question text exactly, verbatim
- dimension must be one of: expression, logic, content, job_match
- expression: communication, delivery, wording; logic: structure, reasoning; content: depth, substance, knowledge; job_match: fit with the role's requirements
- If a question fits no dimension clearly, pick the closest one`
}

// ClassifyDimensionsUser builds the user prompt with the questions to classify.
func ClassifyDimensionsUser(questions []string) string {
	var sb strings.Builder
	for _, q := range questions {
		fmt.Fprintf(&sb, "- %s\n", q)
	}
	return fmt.Sprintf("Classify each of these interview questions into one dimension.\n\nQuestions:\n%s", sb.String())
}
```

- [ ] **Step 3: 写测试**

`backend/internal/llm/prompts_test.go` 追加：

```go
func TestClassifyDimensionsSystemRequiresSchema(t *testing.T) {
	sys := ClassifyDimensionsSystem()
	if !strings.Contains(sys, `"classifications"`) || !strings.Contains(sys, `"dimension"`) {
		t.Fatalf("schema fields missing: %s", sys)
	}
	for _, d := range []string{"expression", "logic", "content", "job_match"} {
		if !strings.Contains(sys, d) {
			t.Fatalf("dimension %s missing from rules: %s", d, sys)
		}
	}
}

func TestClassifyDimensionsUserListsQuestions(t *testing.T) {
	got := ClassifyDimensionsUser([]string{"Q1", "Q2"})
	if !strings.Contains(got, "- Q1") || !strings.Contains(got, "- Q2") {
		t.Fatalf("questions missing from prompt: %s", got)
	}
}
```

- [ ] **Step 4: 跑测试**

Run: `cd backend && go test ./internal/llm/ -count=1`
Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add backend/migrations/006_question_dimension.sql backend/internal/llm/prompts.go backend/internal/llm/prompts_test.go
git commit -m "feat(v7): question dimension classification prompts"
```

---

### Task 2: question 后端（dimension + focused 组卷 + 分类接入）

**Files:**
- Modify: `backend/internal/question/models.go`, `repo.go`, `service.go`, `handler.go`, `service_test.go`, `backend/cmd/server/main.go`

**Interfaces:**
- Consumes: `llm.Client`、T1 的 `ClassifyOut` / `ClassifyDimensionsSystem` / `ClassifyDimensionsUser`
- Produces:
  - `type ListFilter struct { Starred *bool; JobTag string; Query string; Dimension string }`
  - `Item.Dimension *string`（JSON `dimension`）
  - `func NewService(db *sql.DB, llmClient llm.Client) *Service`
  - `func RegisterRoutes(r *gin.Engine, db *sql.DB, secret string, llmClient llm.Client)`
  - `func (s *Service) Focused(ctx context.Context, userID int64, dimensions []string, limitPerDim int) ([]Item, error)`
  - `func (s *Service) validateDimension(d string) error`（或 `question.ValidateDimension`）

- [ ] **Step 1: 先跑迁移**

```bash
docker compose exec -T mysql mysql -uroot -proot interview < backend/migrations/006_question_dimension.sql
```

（不可用时：`docker exec -i feat-v2b-voice-mysql-1 mysql -uroot -proot interview < backend/migrations/006_question_dimension.sql`；验证：`docker exec feat-v2b-voice-mysql-1 mysql -uroot -proot interview -e "SHOW COLUMNS FROM question_bank LIKE 'dimension';"`）

- [ ] **Step 2: models.go**

```go
type Item struct {
	...
	JobTag          *string   `json:"job_tag"`
	Dimension       *string   `json:"dimension"`
	Starred         bool      `json:"starred"`
	...
}

type ListFilter struct {
	Starred   *bool
	JobTag    string
	Query     string
	Dimension string
}

// dimensionKeys are the four valid assessment dimensions (single source).
var dimensionKeys = []string{"expression", "logic", "content", "job_match"}

func validateDimension(d string) error {
	for _, k := range dimensionKeys {
		if d == k {
			return nil
		}
	}
	return ErrInvalidInput
}
```

- [ ] **Step 3: repo.go**

所有 SELECT（`List`、`GetByID`）在 `job_tag` 后加 `dimension` 列；`scanItem` 加 `var dimension sql.NullString` 并设置 `item.Dimension`。

`List` 过滤（在 `Query` 条件后追加）：

```go
if f.Dimension != "" {
	clauses = append(clauses, "dimension = ?")
	args = append(args, f.Dimension)
}
```

新增：

```go
// UpdateDimension sets a bank question's dimension tag (empty clears it).
func (r *Repo) UpdateDimension(id int64, dimension string) error {
	if dimension == "" {
		_, err := r.db.Exec(`UPDATE question_bank SET dimension = NULL WHERE id = ?`, id)
		return err
	}
	_, err := r.db.Exec(`UPDATE question_bank SET dimension = ? WHERE id = ?`, dimension, id)
	return err
}

// ListByDimensionForFocused returns starred-first, newest-first questions for
// one dimension, capped at limit, belonging to the user.
func (r *Repo) ListByDimensionForFocused(userID int64, dimension string, limit int) ([]Item, error) {
	rows, err := r.db.Query(
		`SELECT id, user_id, question, answer, source, source_session_id, job_tag, dimension, starred, created_at
		 FROM question_bank
		 WHERE user_id = ? AND dimension = ?
		 ORDER BY starred DESC, created_at DESC
		 LIMIT ?`,
		userID, dimension, limit,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var items []Item
	for rows.Next() {
		item, err := scanItem(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, *item)
	}
	return items, rows.Err()
}
```

- [ ] **Step 4: service.go**

`Service` 加 `llm llm.Client`；`NewService` 签名改为 `NewService(db *sql.DB, llmClient llm.Client)`，无 client 时保留 nil（`RegisterRoutes` 必须传）。

`ImportFromSession` 末尾（`InsertBatch` 成功返回后）加分类逻辑：

```go
	imported, err := s.repo.InsertBatch(userID, questions, sessionID, jobTag)
	if err != nil {
		return 0, err
	}
	s.classifyAsync(userID, questions) // best-effort; never blocks or fails import
	return imported, nil
```

新增（同步执行分类，失败静默）：

```go
// classifyAsync tags freshly imported questions with an LLM dimension. Any
// failure leaves dimensions NULL; the import itself never fails.
func (s *Service) classifyAsync(userID int64, questions []string) {
	if s.llm == nil || len(questions) == 0 {
		return
	}
	var out llm.ClassifyOut
	if err := s.llm.ChatJSON(context.Background(), llm.ClassifyDimensionsSystem(), llm.ClassifyDimensionsUser(questions), &out); err != nil {
		return
	}
	for _, c := range out.Classifications {
		if validateDimension(c.Dimension) != nil {
			continue
		}
		// Match by exact question text; update that row's dimension.
		for _, q := range questions {
			if q == c.Question {
				_ = s.repo.UpdateDimensionByText(userID, q, c.Dimension)
				break
			}
		}
	}
}
```

`repo.go` 对应新增 `UpdateDimensionByText`：

```go
// UpdateDimensionByText sets dimension for the user's bank question whose text
// matches exactly (used to apply LLM classification by echoed text).
func (r *Repo) UpdateDimensionByText(userID int64, questionText, dimension string) error {
	_, err := r.db.Exec(`UPDATE question_bank SET dimension = ? WHERE user_id = ? AND question = ?`, dimension, userID, questionText)
	return err
}
```

新增组卷服务方法：

```go
// Focused assembles a practice set: for each dimension, starred-first
// questions capped at limitPerDim; total capped at 10.
func (s *Service) Focused(ctx context.Context, userID int64, dimensions []string, limitPerDim int) ([]Item, error) {
	if len(dimensions) == 0 {
		return nil, ErrInvalidInput
	}
	for _, d := range dimensions {
		if err := validateDimension(d); err != nil {
			return nil, err
		}
	}
	if limitPerDim < 1 {
		limitPerDim = 5
	}
	if limitPerDim > 10 {
		limitPerDim = 10
	}
	var items []Item
	for _, d := range dimensions {
		dimItems, err := s.repo.ListByDimensionForFocused(userID, d, limitPerDim)
		if err != nil {
			return nil, err
		}
		items = append(items, dimItems...)
		if len(items) >= 10 {
			items = items[:10]
			break
		}
	}
	if items == nil {
		items = []Item{}
	}
	return items, nil
}
```

- [ ] **Step 5: handler.go**

`RegisterRoutes` 签名加 `llmClient llm.Client`，`NewService(db, llmClient)`。新增路由：

```go
protected.POST("/question-bank/focused", h.Focused)
```

`List` handler 加：

```go
f.Dimension = c.Query("dimension")
```

新 handler：

```go
type focusedRequest struct {
	Dimensions      []string `json:"dimensions"`
	LimitPerDim     int      `json:"limit_per_dimension"`
}

func (h *Handler) Focused(c *gin.Context) {
	userID, ok := c.Get("userID")
	if !ok {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
		return
	}
	var req focusedRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request"})
		return
	}
	items, err := h.svc.Focused(c.Request.Context(), userID.(int64), req.Dimensions, req.LimitPerDim)
	if errors.Is(err, ErrInvalidInput) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid dimensions"})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not build focused set"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"items": items})
}
```

- [ ] **Step 6: main.go**

`question.RegisterRoutes(r, sqlDB, cfg.JWTSecret)` → `question.RegisterRoutes(r, sqlDB, cfg.JWTSecret, llmClient)`。

- [ ] **Step 7: 更新既有调用 + 写测试**

`backend/internal/question/service_test.go`：`question.NewService(sqlDB)` 调用改为 `question.NewService(sqlDB, llmClient)`（testRouter 里；测试文件的 `testRouter` 函数需接收/构造 fake LLM）。新增 fake：

```go
type classifyingLLM struct {
	out llm.ClassifyOut
}

func (c *classifyingLLM) ChatJSON(ctx context.Context, system, user string, out any) error {
	dest, ok := out.(*llm.ClassifyOut)
	if !ok {
		return fmt.Errorf("unexpected out type")
	}
	*dest = c.out
	return nil
}
```

（注意：`ImportFromSession` 测试的 fake 需要满足 `llm.Client` 接口且能返回 `ClassifyOut`；既有测试若用 `*llm.DeepSeekClient` 或其他 fake，检查其 `ChatJSON` 行为。若既有 fake 无法兼容，改用上面的 `classifyingLLM`。）

新增用例（email 前缀 `test-question-%@example.com`，插入题目用 `InsertBatch` 或直接 SQL）：

1. `TestImportClassifiesDimensions` — 创建 session（借 `interview` 包的 create + start 或直接 SQL 插入 questions），调 ImportFromSession（fake LLM 返回 `[{"question":"Q1","dimension":"logic"}]`），断言库里对应行 dimension == "logic"
2. `TestImportClassificationFailureKeepsQuestions` — fake LLM 返回 error，ImportFromSession 仍成功（imported > 0），dimension 全 NULL
3. `TestListFiltersByDimension` — 插入 2 题（一题 dimension=logic，一题 NULL 或 content），`List` 带 `Dimension: "logic"` 只返回 1 题
4. `TestFocusedStarredFirstAndLimit` — 同维度 3 题（2 starred 1 非 starred），`Focused([dim], 2)` 返回 2 题且都是 starred（按 `Item.ID` 断言）
5. `TestFocusedEmptyDimensionsRejected` — `Focused(userID, nil, 5)` → ErrInvalidInput
6. `TestFocusedInvalidDimensionRejected` — `Focused(userID, []string{"evil"}, 5)` → ErrInvalidInput

- [ ] **Step 8: 跑测试**

Run: `cd backend && go test ./internal/question/ -count=1`
Expected: 全部 PASS（需 MySQL + 迁移）。

- [ ] **Step 9: 提交**

```bash
git add backend/internal/question/ backend/cmd/server/main.go
git commit -m "feat(v7): dimension tags, focused question assembly, LLM classification on import"
```

---

### Task 3: 前端画像卡按钮 + 题库维度筛选

**Files:**
- Modify: `frontend/src/api/questions.ts`, `frontend/src/lib/labels.ts`, `frontend/src/pages/CreateInterviewPage.tsx`, `frontend/src/pages/QuestionBankPage.tsx`

**Interfaces:**
- Consumes: `POST /api/questions/question-bank/focused` → `{items: Question[]}`；`GET /api/questions?dimension=`；from-bank（既有 `createInterviewFromBank`）
- Produces:
  - `fetchFocusedQuestions(dimensions: string[], limitPerDim?: number): Promise<Question[]>`
  - `export const DIMENSION_LABELS: Record<string, string>`（`frontend/src/lib/labels.ts`）

- [ ] **Step 1: `api/questions.ts`**

```ts
export interface Question {
  ...
  job_tag: string | null;
  dimension: string | null;
  starred: boolean;
  ...
}

export interface ListQuestionsParams {
  starred?: boolean;
  job_tag?: string;
  q?: string;
  dimension?: string;
}
```

`listQuestions` 加：

```ts
if (params?.dimension) {
  search.set('dimension', params.dimension);
}
```

新增：

```ts
export async function fetchFocusedQuestions(
  dimensions: string[],
  limitPerDim = 5,
): Promise<Question[]> {
  const data = await fetchJSON<{ items: Question[] }>(
    '/api/question-bank/focused',
    {
      method: 'POST',
      body: JSON.stringify({ dimensions, limit_per_dimension: limitPerDim }),
    },
  );
  return data.items;
}
```

- [ ] **Step 2: `lib/labels.ts`**

```ts
// Single source of truth for dimension labels is backend llm.DimensionLabels.
export const DIMENSION_LABELS: Record<string, string> = {
  expression: '表达能力',
  logic: '逻辑结构',
  content: '内容质量',
  job_match: '岗位匹配',
};
```

- [ ] **Step 3: `CreateInterviewPage.tsx` 画像卡按钮**

imports 加 `fetchFocusedQuestions`、`createInterviewFromBank`（`../api/interviews` 已有 import，追加）、`useAuth` 已有。

画像卡内（有薄弱维度分支）按钮区：

```tsx
{profile.weak_dimensions.length > 0 && (
  <button
    type="button"
    className="interview-file-clear"
    onClick={handleFocusedPractice}
    disabled={focusedStarting || loading}
  >
    {focusedStarting ? '正在组卷…' : '针对薄弱点开始练习'}
  </button>
)}
```

state + handler：

```ts
const [focusedStarting, setFocusedStarting] = useState(false);

async function handleFocusedPractice() {
  if (!profile) return;
  setError('');
  setFocusedStarting(true);
  try {
    const items = await fetchFocusedQuestions(profile.weak_dimensions);
    if (items.length === 0) {
      setError('题库中没有该薄弱维度的题目，建议先导入');
      return;
    }
    const created = await createInterviewFromBank({
      question_ids: items.map((q) => q.id),
      input_mode: inputMode,
      persona,
    });
    navigate(`/interviews/${created.id}/room`, { replace: true });
  } catch (err) {
    setError(err instanceof ApiError ? err.message : '专项练习创建失败');
  } finally {
    setFocusedStarting(false);
  }
}
```

- [ ] **Step 4: `QuestionBankPage.tsx` 维度筛选**

state 加 `const [dimension, setDimension] = useState('');`；`loadQuestions` 的 `listQuestions` 调用加 `dimension: dimension || undefined`；筛选区（既有 starred/job_tag/query 附近）加下拉：

```tsx
<select value={dimension} onChange={(e) => setDimension(e.target.value)}>
  <option value="">全部维度</option>
  {Object.entries(DIMENSION_LABELS).map(([key, label]) => (
    <option key={key} value={key}>
      {label}
    </option>
  ))}
</select>
```

（`dimension` 变化触发重新加载——复用既有筛选的 useEffect/load 触发模式；`DIMENSION_LABELS` 从 `../lib/labels` import。）

- [ ] **Step 5: 构建**

Run: `cd frontend && npm run build`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add frontend/src/api/questions.ts frontend/src/lib/labels.ts frontend/src/pages/CreateInterviewPage.tsx frontend/src/pages/QuestionBankPage.tsx
git commit -m "feat(v7): focused practice button and dimension filter in frontend"
```

---

### Task 4: 验收

**Files:**
- Modify: `docs/superpowers/specs/2026-08-17-focused-practice-design.md`

- [ ] **Step 1: 全量后端测试**

Run: `cd backend && go test ./... -count=1 -p 1`
Expected: 全部 PASS（含既有包）。

- [ ] **Step 2: 前端构建**

Run: `cd frontend && npm run build`
Expected: PASS。

- [ ] **Step 3: 手工冒烟（可选，需 DEEPSEEK_API_KEY）**

面试导入题库 → 分类生效（题库页可见维度）→ 画像卡点「针对薄弱点开始练习」→ 房间以题库题目开练。

- [ ] **Step 4: 更新 spec 状态**

`docs/superpowers/specs/2026-08-17-focused-practice-design.md` 的 `**Status:** Draft for user review` 改为 `**Status:** Implemented on feat/v7-focused-practice`。

- [ ] **Step 5: 提交并合并**

```bash
git add docs/superpowers/specs/2026-08-17-focused-practice-design.md
git commit -m "docs(v7): mark spec implemented"
# 回到主仓库合并
git merge --no-ff feat/v7-focused-practice -m "merge: V7 focused practice"
```

---

## Spec coverage self-review

| Spec section | Task |
|--------------|------|
| §4 迁移 + Item.Dimension + ListFilter | T2 |
| §5 LLM 分类 prompt + ImportFromSession 接入 + 失败降级 | T1, T2 |
| §6.1 List dimension 过滤 | T2 |
| §6.2 focused 接口（starred 优先/上限/400） | T2 |
| §7 前端画像卡按钮 + 题库维度筛选 | T3 |
| §8 R1–R7 | T1–T4 |

## Placeholder scan

所有步骤含具体代码/命令，无 TBD。执行时需确认的点：
- `question/service_test.go` 既有 fake LLM 的形状（若已有 `*llm.DeepSeekClient` 或别的 fake，需确保其 ChatJSON 能处理 `*llm.ClassifyOut`；必要时统一换成 `classifyingLLM`）
- `ImportFromSession` 的测试需要真实 session + questions（借 `interview` 包或直接 SQL 造）
- `classifyAsync` 用 `context.Background()`——分类不随请求取消而中断（可接受；如需随请求取消，改为传 ctx 并在 `classifyAsync` 后同步执行，任务以计划代码为准）
