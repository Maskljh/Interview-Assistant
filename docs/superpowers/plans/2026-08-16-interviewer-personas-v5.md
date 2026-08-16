# V5 多面试官人格 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新建面试/题库练习时可选「面试官风格」（严厉技术面 / 温和 HR 面 / 压力面 / 标准），人格注入 LLM 出题与追问 prompt，持久化到会话并在列表/详情/房间展示。

**Architecture:** 迁移 `004_persona.sql` 给 `interview_sessions` 加 `persona` 列；`llm` 包导出人格常量/中文标签/行为描述 map（单一来源）；`GenerateQuestionsUser` 与 `DecideNextUser` 签名追加 `persona string`（standard/未知 → 输出与现状逐字节一致）；`interview` 的 Create/CreateFromBank 持久化 persona，Start 出题与追问循环传 `session.Persona`；前端两个表单加下拉、三处展示标签。

**Tech Stack:** Go/Gin、MySQL（迁移 004）、React/Vite TS、既有 `fetchJSON` 客户端与 design tokens。

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-16-interviewer-personas-design.md`
- 分支 `feat/v5-persona` from main HEAD（V3 已合并，`GenerateQuestionsUser` 现有签名 `(jobJD, resume, mode string, weak []string)`）
- 迁移 `backend/migrations/004_persona.sql`：`ALTER TABLE interview_sessions ADD COLUMN persona VARCHAR(32) NOT NULL DEFAULT 'standard' AFTER input_mode;`
- **跑集成测试前先执行迁移**：`docker compose exec -T mysql mysql -uroot -proot interview < backend/migrations/004_persona.sql`（否则 T2 测试因缺列失败）
- `persona == ""` 或 `standard` → Create 默认 `standard`；非法值 → `ErrInvalidPersona` → HTTP 400
- `standard`/未知 key → prompt 输出与现状**逐字节一致**（persona 注入函数对二者返回空串）
- 中文标签单一来源 `llm.PersonaLabels`；persona 集合单一来源 `llm.Personas`
- 报告评语不随人格变化（`EvaluateSessionSystem/User` 不动）
- 测试用 MySQL（docker），email 前缀沿用既有模式（`test-interview-*@example.com`）；前端 build 用 `npm run build`

---

## File map

| Path | Responsibility |
|------|----------------|
| `backend/migrations/004_persona.sql` | persona 列 |
| `backend/internal/llm/prompts.go` | `Personas` / `PersonaLabels` / `PersonaPrompts` / `personaInjection` + 两函数签名追加 `persona` |
| `backend/internal/llm/prompts_test.go` | 人格注入 / standard 不变 / 未知 key 无注入用例 |
| `backend/internal/interview/models.go` | `Session.Persona`、`ErrInvalidPersona`、`validatePersona` |
| `backend/internal/interview/repo.go` | Create/CreateReadyWithQuestions INSERT + ListByUser/GetByID SELECT + scanSession 加 persona |
| `backend/internal/interview/service.go` | Create/CreateFromBank 签名 + 默认/校验 + Start 出题与追问传 persona |
| `backend/internal/interview/handler.go` | 请求/响应加 persona + 400 映射 |
| `backend/internal/interview/service_test.go` | 持久化/默认/非法/Start 注入用例 + 既有调用点更新 |
| `frontend/src/api/interviews.ts` | `Persona` 类型 + 类型/输入加 persona |
| `frontend/src/lib/labels.ts` | `PERSONA_LABELS` |
| `frontend/src/pages/CreateInterviewPage.tsx` | 「面试官风格」下拉（默认标准） |
| `frontend/src/pages/QuestionBankPage.tsx` | 练习表单同一下拉 |
| `frontend/src/pages/InterviewListPage.tsx` | 行内 persona 标签（standard 不显示） |
| `frontend/src/pages/InterviewDetailPage.tsx` | 详情 persona 标签 |
| `frontend/src/pages/InterviewRoomPage.tsx` | 房间顶栏 persona 标签 |
| `docs/superpowers/specs/2026-08-16-interviewer-personas-design.md` | Status → Implemented |

---

### Task 1: 迁移 + llm 人格常量与 prompt 注入

**Files:**
- Create: `backend/migrations/004_persona.sql`
- Modify: `backend/internal/llm/prompts.go`, `backend/internal/llm/prompts_test.go`

**Interfaces:**
- Consumes: 现有 `GenerateQuestionsUser(jobJD, resume, mode string, weak []string)`、`DecideNextUser(jobJD, mode, currentQuestion string, followUpsOnCurrent int, turns []TurnContext, latestAnswer string)`
- Produces:
  - `const StandardPersona = "standard"`
  - `var Personas = []string{StandardPersona, "strict_tech", "warm_hr", "stress"}`
  - `var PersonaLabels = map[string]string{"standard":"标准","strict_tech":"严厉技术面","warm_hr":"温和 HR 面","stress":"压力面"}`
  - `var PersonaPrompts = map[string]string{"strict_tech": "...", "warm_hr": "...", "stress": "..."}`
  - `func GenerateQuestionsUser(jobJD, resume, mode string, weak []string, persona string) string`
  - `func DecideNextUser(jobJD, mode, currentQuestion string, followUpsOnCurrent int, turns []TurnContext, latestAnswer string, persona string) string`

- [ ] **Step 1: 写迁移文件**

```sql
-- backend/migrations/004_persona.sql
ALTER TABLE interview_sessions
  ADD COLUMN persona VARCHAR(32) NOT NULL DEFAULT 'standard' AFTER input_mode;
```

- [ ] **Step 2: 写 llm 人格常量与注入**

在 `backend/internal/llm/prompts.go` 的 `DimensionLabels` 之后新增：

```go
// StandardPersona is the default persona; it never alters prompts.
const StandardPersona = "standard"

// Personas lists all selectable interviewer personas (single source of truth).
var Personas = []string{StandardPersona, "strict_tech", "warm_hr", "stress"}

// PersonaLabels maps persona keys to Chinese labels for UI display.
var PersonaLabels = map[string]string{
	StandardPersona: "标准",
	"strict_tech":   "严厉技术面",
	"warm_hr":       "温和 HR 面",
	"stress":        "压力面",
}

// PersonaPrompts maps persona keys to interviewer-style instructions injected
// into question-generation and follow-up prompts. standard has no entry.
var PersonaPrompts = map[string]string{
	"strict_tech": "You are a strict senior technical interviewer. Ask probing follow-ups, dig into details, challenge assumptions, and keep questions demanding.",
	"warm_hr":     "You are a warm and supportive HR interviewer. Use a guiding tone, ask follow-ups that help candidates elaborate, focus on soft skills and past experience, and encourage them.",
	"stress":      "You are a fast-paced stress interviewer. Ask rapid successive follow-ups, apply pressure, and keep the pace quick to test composure under stress.",
}

// personaInjection returns the persona instruction block, or "" when the
// persona is standard/empty/unknown so prompts stay byte-identical to legacy.
func personaInjection(persona string) string {
	if persona == "" || persona == StandardPersona {
		return ""
	}
	return PersonaPrompts[persona]
}
```

修改 `GenerateQuestionsUser`：

```go
func GenerateQuestionsUser(jobJD, resume, mode string, weak []string, persona string) string {
	base := fmt.Sprintf(`Generate interview questions for this session.

Job description:
%s

Resume:
%s

Interview mode: %s`, jobJD, resume, mode)

	if len(weak) > 0 {
		labels := make([]string, 0, len(weak))
		for _, w := range weak {
			if label, ok := DimensionLabels[w]; ok {
				labels = append(labels, label)
			}
		}
		if len(labels) > 0 {
			base += fmt.Sprintf(`
	
Targeted focus: this user's weak dimensions are %s. Generate at least half of the questions to assess these weak dimensions.`, strings.Join(labels, ", "))
		}
	}

	if inj := personaInjection(persona); inj != "" {
		base += "\n\n" + inj
	}
	return base
}
```

修改 `DecideNextUser` 签名（末尾追加 `persona string`）并在返回值末尾追加注入：

```go
func DecideNextUser(jobJD, mode, currentQuestion string, followUpsOnCurrent int, turns []TurnContext, latestAnswer string, persona string) string {
	var transcript strings.Builder
	for _, t := range turns {
		fmt.Fprintf(&transcript, "[%s/%s] %s\n", t.Role, t.Kind, t.Content)
	}
	prompt := fmt.Sprintf(`Decide the next interview step.

Job description:
%s

Interview mode: %s

Current main question:
%s

Follow-ups already asked on this question: %d

Transcript so far:
%s

Latest candidate answer:
%s`, jobJD, mode, currentQuestion, followUpsOnCurrent, transcript.String(), latestAnswer)

	if inj := personaInjection(persona); inj != "" {
		prompt += "\n\n" + inj
	}
	return prompt
}
```

- [ ] **Step 3: 写 llm 测试**（`backend/internal/llm/prompts_test.go` 追加）

```go
func TestGenerateQuestionsUserStandardMatchesNoPersona(t *testing.T) {
	with := GenerateQuestionsUser("jd", "resume", "technical", []string{"logic"}, StandardPersona)
	empty := GenerateQuestionsUser("jd", "resume", "technical", []string{"logic"}, "")
	if with != empty {
		t.Fatalf("standard persona must not alter prompt:\nwith: %s\nempty: %s", with, empty)
	}
}

func TestGenerateQuestionsUserInjectsPersona(t *testing.T) {
	got := GenerateQuestionsUser("jd", "resume", "mixed", nil, "strict_tech")
	if !strings.Contains(got, "strict senior technical interviewer") {
		t.Fatalf("persona directive missing: %s", got)
	}
}

func TestGenerateQuestionsUserUnknownPersonaNoInjection(t *testing.T) {
	got := GenerateQuestionsUser("jd", "resume", "mixed", nil, "evil")
	if strings.Contains(got, "strict senior technical interviewer") {
		t.Fatalf("unknown persona must not inject: %s", got)
	}
}

func TestDecideNextUserStandardNoInjection(t *testing.T) {
	got := DecideNextUser("jd", "technical", "Q", 0, nil, "answer", StandardPersona)
	if strings.Contains(got, "interviewer") && !strings.Contains(got, "strict senior") {
		// "interviewer" appears in persona text only; base prompt has none
	}
	if strings.Contains(got, "strict senior technical interviewer") {
		t.Fatalf("standard persona must not inject: %s", got)
	}
	if !strings.Contains(got, "Latest candidate answer:") {
		t.Fatalf("base prompt missing sections: %s", got)
	}
}

func TestDecideNextUserInjectsPersona(t *testing.T) {
	got := DecideNextUser("jd", "technical", "Q", 0, nil, "answer", "stress")
	if !strings.Contains(got, "fast-paced stress interviewer") {
		t.Fatalf("stress directive missing: %s", got)
	}
}
```

- [ ] **Step 4: 跑测试**

Run: `cd backend && go test ./internal/llm/ -count=1`
Expected: 全部 PASS（`prompts_test.go` 无调用旧签名的既有用例；若有编译错误，检查是否存在直接调用 `GenerateQuestionsUser`/`DecideNextUser` 的单测未更新，一并更新）。

- [ ] **Step 5: 提交**

```bash
git add backend/migrations/004_persona.sql backend/internal/llm/prompts.go backend/internal/llm/prompts_test.go
git commit -m "feat(v5): persona constants and prompt injection in llm"
```

---

### Task 2: interview 后端持久化与传参

**Files:**
- Modify: `backend/internal/interview/models.go`, `repo.go`, `service.go`, `handler.go`, `service_test.go`

**Interfaces:**
- Consumes: `llm.StandardPersona`、`llm.Personas`、T1 的两个新签名
- Produces:
  - `Session.Persona string`
  - `var ErrInvalidPersona = errors.New("invalid persona")`
  - `func validatePersona(p string) error`（`p == ""` 视为非法，由调用方先默认成 standard；集合用 `llm.Personas`）
  - `func (s *Service) Create(ctx, userID, jobJD string, resume *string, mode Mode, inputMode InputMode, persona string) (*Session, error)`
  - `func (s *Service) CreateFromBank(ctx, userID, questionIDs []int64, mode Mode, inputMode InputMode, persona string) (*Session, []Question, error)`

- [ ] **Step 1: 先跑一次迁移确认列可用**

```bash
docker compose exec -T mysql mysql -uroot -proot interview < backend/migrations/004_persona.sql
```

- [ ] **Step 2: models.go 加字段与校验**

`Session` 结构体在 `InputMode` 后加 `Persona string`；文件末尾加：

```go
var ErrInvalidPersona = errors.New("invalid persona")

func validatePersona(p string) error {
	for _, k := range llm.Personas {
		if p == k {
			return nil
		}
	}
	return ErrInvalidPersona
}
```

`models.go` 的 import 增加 `"github.com/interview-assistant/backend/internal/llm"`。

- [ ] **Step 3: repo.go 持久化与读取**

`Create` 的 INSERT 与参数：

```go
res, err := r.db.Exec(
	`INSERT INTO interview_sessions (user_id, job_jd, resume_text, mode, input_mode, persona, status)
	 VALUES (?, ?, ?, ?, ?, ?, ?)`,
	userID, jobJD, nullString(resume), string(mode), string(inputMode), persona, string(StatusDraft),
)
```

`CreateReadyWithQuestions` 的 INSERT 同理（`persona` 加在第 6 列，status 后移）。

`ListByUser` 与 `GetByID` 的 SELECT 在 `input_mode` 后加 `persona`；`scanSession` 增加变量并扫描：

```go
var mode, inputMode, persona, status string
err := row.Scan(
	&s.ID, &s.UserID, &s.JobJD, &resume, &mode, &inputMode, &persona, &status, &score, &feedback,
	&s.StartedAt, &s.EndedAt, &s.CreatedAt,
)
...
s.Persona = persona
```

- [ ] **Step 4: service.go 签名与传参**

`Create`：参数列表末尾加 `persona string`；`inputMode` 默认逻辑后加：

```go
if persona == "" {
	persona = llm.StandardPersona
}
if err := validatePersona(persona); err != nil {
	return nil, err
}
```

`CreateFromBank` 同样处理（在 `ValidateInputMode` 之后）。

`Start` 出题调用改为：

```go
llm.GenerateQuestionsUser(session.JobJD, resume, string(session.Mode), weak, session.Persona)
```

追问循环调用（当前在 `service.go:461`）改为：

```go
llm.DecideNextUser(session.JobJD, string(session.Mode), currentQ, state.FollowUpsOnCurrent, turnCtx, answer, session.Persona)
```

`service.go` 已 import `llm`（V3 已加 `profile` import，二者并存）。

- [ ] **Step 5: handler.go 请求/响应**

```go
type createRequest struct {
	JobJD      string    `json:"job_jd"`
	ResumeText *string   `json:"resume_text"`
	Mode       Mode      `json:"mode"`
	InputMode  InputMode `json:"input_mode"`
	Persona    string    `json:"persona"`
}

type fromBankRequest struct {
	QuestionIDs []int64   `json:"question_ids"`
	Mode        Mode      `json:"mode"`
	InputMode   InputMode `json:"input_mode"`
	Persona     string    `json:"persona"`
}
```

`sessionResponse` 在 `InputMode` 后加 `Persona string \`json:"persona"\``；`toSessionResponse` 填 `Persona: session.Persona`。

`Create` handler 调用改为传 `req.Persona`；错误映射追加：

```go
if errors.Is(err, ErrInvalidInput) || errors.Is(err, ErrInvalidMode) || errors.Is(err, ErrInvalidPersona) {
	c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
	return
}
```

`CreateFromBank` handler 同样追加 `ErrInvalidPersona` 到 400 分支并传 `req.Persona`。

- [ ] **Step 6: 更新既有调用点 + 写新测试**

`backend/internal/interview/service_test.go` 两处（约 806、835 行）`svc.Create(ctx, userID, "Backend engineer JD", nil, interview.ModeMixed, interview.InputModeText)` 末尾追加 `, interview.StandardPersona`（注意：`StandardPersona` 来自 `llm` 包，用 `llm.StandardPersona`；该文件已 import `llm`）。

追加新用例：

```go
func TestCreatePersistsPersona(t *testing.T) {
	sqlDB := testDB(t)
	store := testStore(t)
	ctx := context.Background()
	r := testRouter(t, sqlDB, nil)
	_ = registerUser(t, r, "test-interview-persona-persist@example.com")
	userID := userIDByEmail(t, sqlDB, "test-interview-persona-persist@example.com")

	svc := interview.NewService(sqlDB, &fakeLLM{}, store)
	session, err := svc.Create(ctx, userID, "Backend engineer JD", nil, interview.ModeMixed, interview.InputModeText, "strict_tech")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	got, err := svc.Get(ctx, userID, session.ID)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got.Persona != "strict_tech" {
		t.Fatalf("persona = %q, want strict_tech", got.Persona)
	}
}

func TestCreateDefaultsStandardPersona(t *testing.T) {
	sqlDB := testDB(t)
	store := testStore(t)
	ctx := context.Background()
	r := testRouter(t, sqlDB, nil)
	_ = registerUser(t, r, "test-interview-persona-default@example.com")
	userID := userIDByEmail(t, sqlDB, "test-interview-persona-default@example.com")

	svc := interview.NewService(sqlDB, &fakeLLM{}, store)
	session, err := svc.Create(ctx, userID, "Backend engineer JD", nil, interview.ModeMixed, interview.InputModeText, "")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if session.Persona != llm.StandardPersona {
		t.Fatalf("persona = %q, want %q", session.Persona, llm.StandardPersona)
	}
}

func TestCreateRejectsInvalidPersona(t *testing.T) {
	sqlDB := testDB(t)
	store := testStore(t)
	ctx := context.Background()
	r := testRouter(t, sqlDB, nil)
	_ = registerUser(t, r, "test-interview-persona-invalid@example.com")
	userID := userIDByEmail(t, sqlDB, "test-interview-persona-invalid@example.com")

	svc := interview.NewService(sqlDB, &fakeLLM{}, store)
	_, err := svc.Create(ctx, userID, "Backend engineer JD", nil, interview.ModeMixed, interview.InputModeText, "evil")
	if !errors.Is(err, interview.ErrInvalidPersona) {
		t.Fatalf("err = %v, want ErrInvalidPersona", err)
	}
}

func TestStartUsesPersonaInPrompt(t *testing.T) {
	sqlDB := testDB(t)
	store := testStore(t)
	ctx := context.Background()
	r := testRouter(t, sqlDB, nil)
	_ = registerUser(t, r, "test-interview-persona-start@example.com")
	userID := userIDByEmail(t, sqlDB, "test-interview-persona-start@example.com")

	capLLM := &capturingLLM{}
	svc := interview.NewService(sqlDB, capLLM, store)
	session, err := svc.Create(ctx, userID, "Backend engineer JD", nil, interview.ModeMixed, interview.InputModeText, "warm_hr")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if _, _, err := svc.Start(ctx, userID, session.ID); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if len(capLLM.userPrompts) != 1 {
		t.Fatalf("captured %d prompts, want 1", len(capLLM.userPrompts))
	}
	if !strings.Contains(capLLM.userPrompts[0], "warm and supportive HR interviewer") {
		t.Fatalf("prompt missing persona directive: %s", capLLM.userPrompts[0])
	}
}
```

校验：测试文件里 `fakeLLM` 与 `capturingLLM` 是否存在（V3 已加 `capturingLLM`；若不存在 `fakeLLM` 用 `capturingLLM` 替代）。`svc.Get` 方法存在（handler 使用）。`errors`、`strings` import 已存在（V3 测试已用 `strings`；`errors` 若缺失则补 import）。

- [ ] **Step 7: 跑测试**

Run: `cd backend && go test ./internal/interview/ -count=1`
Expected: 全部 PASS（含既有用例更新）。

- [ ] **Step 8: 提交**

```bash
git add backend/internal/interview/models.go backend/internal/interview/repo.go backend/internal/interview/service.go backend/internal/interview/handler.go backend/internal/interview/service_test.go
git commit -m "feat(v5): persist persona and pass it to question generation and follow-ups"
```

---

### Task 3: 前端 persona 下拉与展示

**Files:**
- Modify: `frontend/src/api/interviews.ts`, `frontend/src/lib/labels.ts`, `frontend/src/pages/CreateInterviewPage.tsx`, `frontend/src/pages/QuestionBankPage.tsx`, `frontend/src/pages/InterviewListPage.tsx`, `frontend/src/pages/InterviewDetailPage.tsx`, `frontend/src/pages/InterviewRoomPage.tsx`

**Interfaces:**
- Consumes: 后端响应新增 `persona` 字段（T2）
- Produces: `PERSONA_LABELS: Record<string, string>`（`frontend/src/lib/labels.ts`，与后端 `llm.PersonaLabels` 同步，注释标明单一来源在后端）

- [ ] **Step 1: api 类型**

`frontend/src/api/interviews.ts`：

```ts
export type Persona = 'standard' | 'strict_tech' | 'warm_hr' | 'stress';
```

`Interview` 在 `input_mode` 后加 `persona: Persona;`；`InterviewListItem` 加 `persona: Persona;`；`CreateInterviewInput` 与 `CreateFromBankInput` 加 `persona?: Persona;`。

- [ ] **Step 2: labels**

`frontend/src/lib/labels.ts` 末尾加：

```ts
// Single source of truth for persona labels is backend llm.PersonaLabels.
export const PERSONA_LABELS: Record<string, string> = {
  standard: '标准',
  strict_tech: '严厉技术面',
  warm_hr: '温和 HR 面',
  stress: '压力面',
};
```

- [ ] **Step 3: CreateInterviewPage 下拉**

`CreateInterviewPage.tsx`：新增

```ts
const PERSONAS: Persona[] = ['standard', 'strict_tech', 'warm_hr', 'stress'];
```

state `const [persona, setPersona] = useState<Persona>('standard');`；`createInterview` payload 加 `persona`；表单在「作答方式」select 后加：

```tsx
<div className="interview-field">
  <label htmlFor="persona">面试官风格</label>
  <select id="persona" value={persona} onChange={(e) => setPersona(e.target.value as Persona)}>
    {PERSONAS.map((value) => (
      <option key={value} value={value}>
        {PERSONA_LABELS[value]}
      </option>
    ))}
  </select>
</div>
```

- [ ] **Step 4: QuestionBankPage 下拉**

`QuestionBankPage.tsx`：同样加 `PERSONAS` 常量、`persona` state（默认 `'standard'`）、`createInterviewFromBank` payload 加 `persona`；在「作答方式」select（约 256 行）后加相同结构的 select。

- [ ] **Step 5: 三处展示**

`InterviewListPage.tsx`：在 `mode-pill` 行内加（`item.persona !== 'standard'` 时显示）：

```tsx
{item.persona !== 'standard' && (
  <span className="mode-pill">{PERSONA_LABELS[item.persona]}</span>
)}
```

`InterviewDetailPage.tsx`：在 INPUT_MODE_LABELS pill 后加同结构标签。

`InterviewRoomPage.tsx`：在 `interview-room-header` 内（约 360 行区域）加 persona 标签；该页面已有 `data.input_mode`（约 209 行），同一响应对象有 `data.persona`，加：

```tsx
{data.persona !== 'standard' && (
  <span className="mode-pill">{PERSONA_LABELS[data.persona]}</span>
)}
```

（`mode-pill` 样式已存在，无需新增 CSS；房间页面需确认 `PERSONA_LABELS` import。）

- [ ] **Step 6: 构建**

Run: `cd frontend && npm run build`
Expected: PASS。修任何 TS 错误（如 `data.persona` 类型为空，需在 `InterviewRoomPage` 的响应类型上确认 `persona` 存在——该页响应类型来自 `getInterview` 返回的 `Interview`）。

- [ ] **Step 7: 提交**

```bash
git add frontend/src/api/interviews.ts frontend/src/lib/labels.ts frontend/src/pages/CreateInterviewPage.tsx frontend/src/pages/QuestionBankPage.tsx frontend/src/pages/InterviewListPage.tsx frontend/src/pages/InterviewDetailPage.tsx frontend/src/pages/InterviewRoomPage.tsx
git commit -m "feat(v5): persona select and labels in frontend"
```

---

### Task 4: 验收

**Files:**
- Modify: `docs/superpowers/specs/2026-08-16-interviewer-personas-design.md`

- [ ] **Step 1: 全量后端测试**

Run: `cd backend && go test ./... -count=1 -p 1`
Expected: 全部 PASS（含既有包）。

- [ ] **Step 2: 前端构建**

Run: `cd frontend && npm run build`
Expected: PASS。

- [ ] **Step 3: 手工冒烟（可选，需 DEEPSEEK_API_KEY）**

新建面试选「严厉技术面」→ 房间顶栏显示标签 → 开始后面试追问风格犀利；列表/详情显示「严厉技术面」。

- [ ] **Step 4: 更新 spec 状态**

`docs/superpowers/specs/2026-08-16-interviewer-personas-design.md` 的 `**Status:** Draft for user review` 改为 `**Status:** Implemented on feat/v5-persona`。

- [ ] **Step 5: 提交并合并**

```bash
git add docs/superpowers/specs/2026-08-16-interviewer-personas-design.md
git commit -m "docs(v5): mark spec implemented"
# 回到主仓库合并
git merge --no-ff feat/v5-persona -m "merge: V5 interviewer personas"
```

---

## Spec coverage self-review

| Spec section | Task |
|--------------|------|
| §4 迁移 + Session.Persona | T1 Step 1, T2 Step 2–3 |
| §5 人格预设（4 种、单一来源） | T1 Step 2 |
| §6.1 出题注入 | T1 Step 2, T2 Step 4 |
| §6.2 追问注入 | T1 Step 2, T2 Step 4 |
| §6.3 standard/未知 → 逐字节一致 | T1 Step 2（personaInjection）, T1 Step 3 测试 |
| §7 API persona 字段 + 400 | T2 Step 5 |
| §8 前端下拉 + 三处展示 | T3 |
| §9 N1–N6 | T1–T4 |
| §10 无 main.go 改动、from-bank 追问覆盖 | T2（CreateFromBank 传 persona） |

## Placeholder scan

所有步骤含具体代码/命令，无 TBD。已知需在执行时确认的点：
- `service_test.go` 是否已有 `fakeLLM`（不存在则用 V3 已加的 `capturingLLM`）
- `TestDecideNextUserStandardNoInjection` 里那段空 if 是噪声，可删除，仅保留断言
- `InterviewRoomPage` 的 `data` 类型为 `Interview`（来自 `getInterview`），`persona` 字段 T3 Step 1 已加
