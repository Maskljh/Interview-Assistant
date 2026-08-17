# V9 追问轮数随人格 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 面试官人格决定每个主问题的追问轮数上限：压力面/严厉技术面 4 轮、温和 HR 面 1 轮、标准 2 轮（与现状一致）。

**Architecture:** `llm` 包新增 `MaxFollowUpsByPersona` map + `FollowUpLimit(persona)`（单一来源，未知 → 2）；`interview.DecideInput` 加 `MaxFollowUps` 字段，`ApplyDecideRules` 用它替换常量判断（≤0 退化默认 2）；`decideNext` 传 `llm.FollowUpLimit(session.Persona)`。纯后端，无迁移、无前端改动。

**Tech Stack:** Go/Gin，无新依赖。

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-17-persona-followup-limits-design.md`
- 分支 `feat/v9-persona-followups` from main HEAD
- 映射（单一来源 `llm` 包）：`standard→2`、`strict_tech→4`、`warm_hr→1`、`stress→4`
- `FollowUpLimit`：`MaxFollowUpsByPersona[persona]` 命中返回，否则 2（含空串/未知）
- `ApplyDecideRules`：`MaxFollowUps <= 0` → 用既有常量 `MaxFollowUpsPerQuestion`（=2）；否则 `FollowUpsOnCurrent >= MaxFollowUps` → `next_question`（Reason 不变 "follow-up cap reached"）
- `MaxFollowUpsPerQuestion` 常量**保留**（默认值），不删除
- 轮数是上限非强制：LLM 仍可 `next_question`/`finish`；`MaxTurnsApprox`/`MaxDuration` 不变
- `decideNext` 构建 `DecideInput` 时传 `MaxFollowUps: llm.FollowUpLimit(session.Persona)`
- 测试全绿：`go test ./... -count=1 -p 1` + `npm run build`（前端无改动，仅确认不回归）

---

## File map

| Path | Responsibility |
|------|----------------|
| `backend/internal/llm/prompts.go` | `MaxFollowUpsByPersona` + `FollowUpLimit` |
| `backend/internal/llm/prompts_test.go` | `FollowUpLimit` 表驱动用例 |
| `backend/internal/interview/decide.go` | `DecideInput.MaxFollowUps` + `ApplyDecideRules` 改造 |
| `backend/internal/interview/decide_test.go` | 各轮数上限触发用例 |
| `backend/internal/interview/service.go` | `decideNext` 传 `llm.FollowUpLimit(session.Persona)` |
| `docs/superpowers/specs/2026-08-17-persona-followup-limits-design.md` | Status → Implemented |

---

### Task 1: llm 映射 + 规则层 + 调用方

**Files:**
- Modify: `backend/internal/llm/prompts.go`, `backend/internal/llm/prompts_test.go`, `backend/internal/interview/decide.go`, `backend/internal/interview/decide_test.go`, `backend/internal/interview/service.go`

**Interfaces:**
- Consumes: 既有 `StandardPersona` 常量
- Produces:
  - `var MaxFollowUpsByPersona = map[string]int{StandardPersona: 2, "strict_tech": 4, "warm_hr": 1, "stress": 4}`
  - `func FollowUpLimit(persona string) int`
  - `DecideInput.MaxFollowUps int`

- [ ] **Step 1: llm/prompts.go 加映射与函数**

在 `PersonaPrompts` 之后（`personaInjection` 之前或之后均可）加：

```go
// MaxFollowUpsByPersona caps follow-up turns per main question per persona.
// standard/unknown fall back to 2 (legacy behavior).
var MaxFollowUpsByPersona = map[string]int{
	StandardPersona: 2,
	"strict_tech":   4,
	"warm_hr":       1,
	"stress":        4,
}

// FollowUpLimit returns the follow-up cap for a persona; unknown → 2.
func FollowUpLimit(persona string) int {
	if n, ok := MaxFollowUpsByPersona[persona]; ok {
		return n
	}
	return 2
}
```

- [ ] **Step 2: llm/prompts_test.go 加表驱动用例**

```go
func TestFollowUpLimit(t *testing.T) {
	cases := []struct {
		persona string
		want    int
	}{
		{StandardPersona, 2},
		{"", 2},
		{"unknown", 2},
		{"strict_tech", 4},
		{"stress", 4},
		{"warm_hr", 1},
	}
	for _, c := range cases {
		if got := FollowUpLimit(c.persona); got != c.want {
			t.Fatalf("FollowUpLimit(%q) = %d, want %d", c.persona, got, c.want)
		}
	}
}
```

- [ ] **Step 3: decide.go 改造**

`DecideInput` 加字段（`FollowUpsOnCurrent` 之后）：

```go
MaxFollowUps int // per-persona follow-up cap; <=0 falls back to legacy default
```

`ApplyDecideRules` 的追问上限判断（现第 33 行附近）替换为：

```go
	followUpCap := in.MaxFollowUps
	if followUpCap <= 0 {
		followUpCap = MaxFollowUpsPerQuestion // legacy default
	}
	if in.FollowUpsOnCurrent >= followUpCap {
		return DecideResult{Action: "next_question", Reason: "follow-up cap reached"}
	}
```

- [ ] **Step 4: decide_test.go 加用例**

既有 `TestApplyDecideRules` 表驱动用例保留（`MaxFollowUps` 为 0 时行为不变）。追加独立测试：

```go
func TestApplyDecideRulesPerPersonaFollowUpCap(t *testing.T) {
	cases := []struct {
		name       string
		max        int
		followUps  int
		wantAction DecideAction
	}{
		{"cap 1 forces next after first follow-up", 1, 1, "next_question"},
		{"cap 1 allows zero follow-ups", 1, 0, "follow_up"},
		{"cap 4 forces next after fourth follow-up", 4, 4, "next_question"},
		{"cap 4 allows three follow-ups", 4, 3, "follow_up"},
		{"cap 0 falls back to legacy 2", 0, 2, "next_question"},
		{"cap 0 allows one follow-up", 0, 1, "follow_up"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := ApplyDecideRules(DecideInput{
				MainQuestionCount:    5,
				CurrentQuestionIndex: 0,
				FollowUpsOnCurrent:   c.followUps,
				MaxFollowUps:         c.max,
				ModelAction:          "follow_up",
				ModelFollowUpText:    "why?",
			})
			if got.Action != c.wantAction {
				t.Fatalf("ApplyDecideRules() = %q, want %q", got.Action, c.wantAction)
			}
		})
	}
}
```

（注意：`cap 0 falls back` 用例要求 `FollowUpsOnCurrent=2` 且 `MaxFollowUps=0` → 用 `MaxFollowUpsPerQuestion=2` → `2 >= 2` → next_question；`cap 0 allows one` → `1 < 2` → 走 model follow_up。既有用例中 `{"force next when followups full", FollowUpsOnCurrent: 2, ModelAction: "follow_up", ...}` 不设 MaxFollowUps（0）→ 行为不变，验证兼容。）

- [ ] **Step 5: service.go 传参**

`decideNext` 构建 `DecideInput`（约 487 行 `ApplyDecideRules(DecideInput{...})`）加：

```go
MaxFollowUps: llm.FollowUpLimit(session.Persona),
```

（`service.go` 已 import `llm`。）

- [ ] **Step 6: 跑测试**

Run: `cd backend && go test ./internal/llm/ ./internal/interview/ -count=1`
Expected: 全部 PASS（含既有用例）。

- [ ] **Step 7: 提交**

```bash
git add backend/internal/llm/prompts.go backend/internal/llm/prompts_test.go backend/internal/interview/decide.go backend/internal/interview/decide_test.go backend/internal/interview/service.go
git commit -m "feat(v9): per-persona follow-up limits in decide rules"
```

---

### Task 2: 验收

**Files:**
- Modify: `docs/superpowers/specs/2026-08-17-persona-followup-limits-design.md`

- [ ] **Step 1: 全量后端测试**

Run: `cd backend && go test ./... -count=1 -p 1`
Expected: 全部 PASS。

- [ ] **Step 2: 前端构建**

Run: `cd frontend && npm run build`
Expected: PASS（前端无改动，确认不回归）。

- [ ] **Step 3: 更新 spec 状态**

`docs/superpowers/specs/2026-08-17-persona-followup-limits-design.md` 的 `**Status:** Draft for user review` 改为 `**Status:** Implemented on feat/v9-persona-followups`。

- [ ] **Step 4: 提交并合并**

```bash
git add docs/superpowers/specs/2026-08-17-persona-followup-limits-design.md
git commit -m "docs(v9): mark spec implemented"
# 回到主仓库合并
git merge --no-ff feat/v9-persona-followups -m "merge: V9 persona follow-up limits"
```

---

## Spec coverage self-review

| Spec section | Task |
|--------------|------|
| §4 映射 + FollowUpLimit | T1 |
| §5 DecideInput + ApplyDecideRules | T1 |
| §6 decideNext 传参 | T1 |
| §7 T1–T4 | T1–T2 |

## Placeholder scan

所有步骤含具体代码/命令，无 TBD。执行时需确认的点：
- `decide_test.go` 既有用例不设 `MaxFollowUps`（零值 0）→ 走 legacy 分支，行为不变——已验证既有用例期望
- `personaInjection` 位置不影响新代码（追加在 `PersonaPrompts` 后即可）
