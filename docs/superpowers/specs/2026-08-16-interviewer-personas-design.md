# V5 多面试官人格 — 设计规格

**Date:** 2026-08-16  
**Status:** Implemented on feat/v5-persona
**Parent:** V1 MVP + V2-A 题库 + V2-B 语音 + V2-C 成长分析 + V3 针对性出题 + V4 手机端 PWA  
**Approach:** 预设人格注入 LLM 出题与追问 prompt，持久化到会话并在界面展示

---

## 1. Goal

新建面试时可选「面试官风格」，让同一份 JD 能体验严厉技术面、温和 HR 面、压力面等不同风格的出题与追问。默认「标准」保持现有行为不变。

---

## 2. Locked decisions

| 决策点 | 选择 |
|--------|------|
| 作用环节 | **出题 + 追问**两处注入；报告评语不随人格变化（评分口径稳定） |
| 人格形态 | **3 个固定预设** + 默认 `standard`，无自定义人格 |
| 持久化 | `interview_sessions.persona` 列（迁移 004），列表/详情/房间展示 |
| from-bank | 不出题但追问覆盖（人格存入 session 后天然生效） |
| 兼容性 | `standard` 或未知值时 prompt 与现状**逐字节一致** |
| 中文标签 | 单一来源：`llm.PersonaLabel` map（key → 中文），前端只读展示 |
| 执行顺序 | **先收尾 V3 合并 main**，再切 `feat/v5-persona`（V3 已给出题签名加 `weak`，功能 5 在其后加 `persona`） |

---

## 3. Non-goals (V5)

- 自定义人格 / 用户填写风格描述
- 报告评语随人格变化（避免评分因人而异）
- 人格影响评分规则或维度口径
- 历史面试的人格回填 / 迁移改写（新会话才有默认值）

---

## 4. Data model

迁移 `004_persona.sql`（沿用 `003_input_mode.sql` 先例）：

```sql
ALTER TABLE interview_sessions
  ADD COLUMN persona VARCHAR(32) NOT NULL DEFAULT 'standard' AFTER input_mode;
```

`Session` 结构体加 `Persona string`，所有 session JSON 响应（详情/列表/创建）带 `persona` 字段。

---

## 5. 人格预设（单一来源：`llm` 包）

| key | 中文标签 | prompt 注入的行为描述 |
|-----|---------|----------------------|
| `standard` | 标准 | **无注入**（与现状一致） |
| `strict_tech` | 严厉技术面 | 追问犀利、深挖细节、质疑假设、问题偏难 |
| `warm_hr` | 温和 HR 面 | 引导式提问、鼓励口吻、关注软技能与过往经历 |
| `stress` | 压力面 | 快节奏连续追问、施压、限制思考时间 |

定义：

```go
// PersonaLabels maps persona keys to Chinese labels for UI display.
var PersonaLabels = map[string]string{
    "standard":     "标准",
    "strict_tech":  "严厉技术面",
    "warm_hr":      "温和 HR 面",
    "stress":       "压力面",
}

// PersonaPrompts maps persona keys to interviewer-style instructions injected
// into question-generation and follow-up prompts. standard has no entry.
var PersonaPrompts = map[string]string{
    "strict_tech": "You are a strict senior technical interviewer...",
    "warm_hr":     "You are a warm HR interviewer...",
    "stress":      "You are a fast-paced stress interviewer...",
}
```

`Personas = []string{"standard","strict_tech","warm_hr","stress"}` 供前端下拉枚举（或前端硬编码同序列表）。

---

## 6. Prompt 注入

### 6.1 出题

签名（在 V3 基础上追加）：

```go
func GenerateQuestionsUser(jobJD, resume, mode string, weak []string, persona string) string
```

- `persona == "standard"` 或不在 `PersonaPrompts` → 输出与 V3 完全一致（weak 逻辑不变）
- 否则在 base prompt 末尾追加 persona 行为描述一段

### 6.2 追问

签名（追加末位参数）：

```go
func DecideNextUser(jobJD, mode, currentQuestion string, followUpsOnCurrent int, turns []TurnContext, latestAnswer string, persona string) string
```

- 同样：standard/未知 → 与现状一致；否则追加行为描述
- `interview/service.go:442` 调用点传 `session.Persona`

### 6.3 不变

- `GenerateQuestionsSystem`（5–8 题、JSON schema）
- `EvaluateSessionSystem/User`（评语不随人格）
- `from-bank` 不出题（追问仍覆盖，见 §2）

---

## 7. API

`createRequest` / `createFromBankRequest` 增加可选字段：

```json
{ "persona": "strict_tech" }
```

- 缺省/空串 → `standard`
- 非法值 → `400 {"error":"invalid persona"}`
- 响应（create/create-from-bank/详情/列表）session 对象含 `persona`

---

## 8. Frontend (Chinese UI)

| Surface | Change |
|---------|--------|
| `CreateInterviewPage` | 表单加「面试官风格」下拉（默认标准，选项：标准/严厉技术面/温和 HR 面/压力面） |
| `QuestionBankPage` | 题库练习表单加同一下拉（from-bank 追问生效） |
| `InterviewListPage` | 列表行显示人格标签（standard 不显示） |
| `InterviewDetailPage` | 详情显示人格标签 |
| `InterviewRoomPage` | 房间顶栏显示人格标签 |

- `lib/labels.ts`：`PERSONA_LABELS` 映射（与后端 `PersonaLabels` 同步，注释标明单一来源在后端）
- `api/interviews.ts`：创建/题库练习 payload 与 `Interview` 类型加 `persona`
- 移动端（PWA 视角）：下拉和标签沿用现有 token 样式，不做特殊适配

---

## 9. Acceptance

| ID | Expectation |
|----|-------------|
| N1 | 出题 prompt：`strict_tech` 含人格注入；`standard` 与 V3 现状逐字节一致 |
| N2 | 追问 prompt：人格注入生效；standard 不变 |
| N3 | Create / CreateFromBank 持久化 persona；缺省 → `standard`；非法 → 400 |
| N4 | 详情/列表/房间展示人格标签；standard 不展示 |
| N5 | 前端 build 通过；两个下拉（新建页/题库练习）渲染且提交成功 |
| N6 | 无回归：`go test ./... -count=1 -p 1` 全绿（含 V3 已合并用例） |

---

## 10. Implementation notes

- 迁移：`backend/migrations/004_persona.sql`
- Backend：`llm/prompts.go`（PersonaLabels/PersonaPrompts + 两个函数签名）、`interview/models.go`（Persona）、`interview/handler.go`（create 请求 + 响应）、`interview/service.go`（Create/CreateFromBank 持久化 + Start/追问传参）
- `interview` 包自持 `persona` 字段，无跨包依赖；`llm` 包为标签与注入文本单一来源
- Tests：`llm/prompts_test.go` 人格注入/standard 不变用例；`interview/service_test.go` 持久化与非法值用例（镜像现有测试模式，MySQL docker）；前端 build
- 签名冲突处理：**必须**在 V3（`weak []string`）合并后再实现本功能，`GenerateQuestionsUser` 最终签名 `(jobJD, resume, mode string, weak []string, persona string)`
- Prefer branch `feat/v5-persona` from main HEAD（V3 合并后）

---

## Spec self-review

- [x] 无 TBD / 占位符
- [x] 与 locked decisions 一致（出题+追问、3 预设、持久化+展示、standard 不变、先 V3）
- [x] 范围聚焦单一实施计划；Non-goals 明确排除自定义人格/报告随人格
- [x] 兼容性语义显式（standard/未知 → 逐字节一致）；from-bank 追问覆盖有说明
