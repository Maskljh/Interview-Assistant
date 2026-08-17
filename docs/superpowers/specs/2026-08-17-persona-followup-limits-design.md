# V9 追问轮数随人格 — 设计规格

**Date:** 2026-08-17  
**Status:** Implemented on feat/v9-persona-followups
**Parent:** V5 面试官人格（追问 prompt 已注入人格；本功能深化轮数规则）  
**Approach:** 人格决定每个主问题的追问轮数上限，替换全局常量 `MaxFollowUpsPerQuestion = 2`

---

## 1. Goal

让「面试官人格」不仅影响追问的语气（V5 已实现），还影响追问的**力度**：压力面与严厉技术面可以连珠炮追问更多轮，温和 HR 面克制引导更少轮，标准人格保持现状（2 轮）逐字节不变。

---

## 2. Locked decisions

| 决策点 | 选择 |
|--------|------|
| 深化方向 | **追问轮数上限随人格**（非追问 prompt 规则细化） |
| 映射 | `standard→2`、`strict_tech→4`、`warm_hr→1`、`stress→4`（`llm` 包单一来源） |
| 兼容性 | `standard`/空/未知人格 → 2（与现状逐字节一致）；`MaxFollowUps=0` 时规则层退化到 2（保守防漏传） |
| 上限语义 | 轮数是**上限**非强制：LLM 仍可自行 `next_question`；`MaxTurnsApprox=30` 总轮数兜底不变 |
| 改动范围 | 纯后端：`llm` 映射 + `decide.go` 规则 + `service.go` 传参；前端零改动 |
| 执行顺序 | 分支 `feat/v9-persona-followups` from main HEAD |

---

## 3. Non-goals (V9)

- 追问 prompt 规则细化（引用原话质疑等——V5 的人格行为描述已覆盖语气）
- 人格影响 `MaxTurnsApprox` / `MaxDuration` / 出题题数
- 自定义人格的轮数配置
- 前端展示轮数上限

---

## 4. 人格 → 轮数映射（`llm` 包）

```go
// MaxFollowUpsByPersona caps follow-up turns per main question per persona.
// standard/unknown fall back to 2 (legacy behavior).
var MaxFollowUpsByPersona = map[string]int{
	StandardPersona: 2,
	"strict_tech":   4,
	"warm_hr":       1,
	"stress":        4,
}

// FollowUpLimit returns the follow-up cap for a persona.
func FollowUpLimit(persona string) int {
	if n, ok := MaxFollowUpsByPersona[persona]; ok {
		return n
	}
	return 2
}
```

- 与 `Personas` / `PersonaLabels` 并列，`llm` 包保持单一来源惯例
- 未知人格 → 2（与 standard 同语义，prompt 不变行为也不变）

---

## 5. 规则层（`interview/decide.go`）

- `DecideInput` 加字段：

```go
MaxFollowUps int // per-persona follow-up cap; <=0 falls back to legacy default
```

- `ApplyDecideRules` 的追问上限判断（现第 33 行）：

```go
cap := in.MaxFollowUps
if cap <= 0 {
	cap = MaxFollowUpsPerQuestion // legacy default 2
}
if in.FollowUpsOnCurrent >= cap {
	return DecideResult{Action: "next_question", Reason: "follow-up cap reached"}
}
```

- `MaxFollowUpsPerQuestion` 常量保留（作为默认值），不删除——避免调用方漏传导致行为漂移

---

## 6. 调用方（`interview/service.go` `decideNext`）

构建 `DecideInput` 时（约 487 行）加：

```go
MaxFollowUps: llm.FollowUpLimit(session.Persona),
```

`interview` 已 import `llm`（V5 起），无新依赖。

---

## 7. 测试与验收

| ID | Expectation |
|----|-------------|
| T1 | `llm.FollowUpLimit`：standard/空/未知 → 2；strict_tech/stress → 4；warm_hr → 1（prompts_test 表驱动） |
| T2 | `ApplyDecideRules`：`MaxFollowUps=1` 时第 1 轮后强制 next；`=4` 时第 4 轮后强制；`=0`/未设 → 2（decide_test 表驱动，既有用例不破坏） |
| T3 | `decideNext` 传 `llm.FollowUpLimit(session.Persona)`（service 测试或代码检查） |
| T4 | 无回归：`go test ./... -count=1 -p 1` 全绿 + `npm run build` 通过（前端无改动，仅确认） |

---

## 8. Implementation notes

- 文件：`backend/internal/llm/prompts.go`（映射 + 函数）、`backend/internal/llm/prompts_test.go`、`backend/internal/interview/decide.go`、`backend/internal/interview/decide_test.go`、`backend/internal/interview/service.go`
- 无迁移、无前端改动、无 API 变化
- Prefer branch `feat/v9-persona-followups` from main HEAD

---

## Spec self-review

- [x] 无 TBD / 占位符
- [x] 与 locked decisions 一致（轮数随人格、standard 逐字节不变、0 退化 2、上限非强制）
- [x] 范围聚焦单一实施计划；Non-goals 明确排除 prompt 规则细化/其他上限/自定义配置
- [x] 兼容性语义显式（`MaxFollowUps=0` → 2、未知人格 → 2、常量保留）
