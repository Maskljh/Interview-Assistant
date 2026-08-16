# V2-C 成长分析（面试对比）— 设计规格

**Date:** 2026-08-16  
**Status:** Draft for user review  
**Parent:** V1 MVP + V2-A 题库 + V2-B 语音  
**Approach:** 后端聚合接口 `internal/analytics` + 前端 recharts 趋势页

---

## 1. Goal

汇总当前用户**已完成且有评分**的历史面试，展示总分成长曲线、四维（表达/逻辑/内容/岗位匹配）趋势与汇总统计，支持按岗位标签与面试模式筛选，帮助用户直观看到练习进步。

---

## 2. Locked decisions

| 决策点 | 选择 |
|--------|------|
| 核心能力 | 历史多场对比 + 成长曲线（非单场深度对比、非同岗位横向对比） |
| 展示内容 | 总分趋势 + 四维趋势 + 汇总统计卡 |
| 页面位置 | 独立页面 `/trends`，顶栏加「成长分析」入口 |
| 筛选 | 岗位标签（JD 前 40 字符）+ 面试模式（behavioral/technical/mixed） |
| 图表 | 引入 recharts |
| 数据来源 | 复用 `interview_sessions.score` + `feedback_json`，**不新增表** |
| 聚合位置 | 后端聚合（`internal/analytics`），前端只画图 |

---

## 3. Non-goals (V2-C)

- 单场回答与参考答案的深度对比
- LLM 生成文字总结 / 分析建议（纯统计可视化，不调用 LLM）
- 岗位标签多对多实体、标签管理、标签编辑
- 报告导出 / 分享 / 截图
- 前端数据缓存、离线、实时推送
- 面试详情页内嵌趋势（仅独立页）

---

## 4. Data model

无新表、无迁移。复用现有字段：

| 来源 | 字段 | 用途 |
|------|------|------|
| `interview_sessions` | `user_id` | 归属 |
| | `job_jd` | 推导岗位标签（trim 后取前 40 字符） |
| | `mode` | 模式筛选 |
| | `score` | 总分（仅 `status=completed AND score IS NOT NULL` 计入） |
| | `feedback_json` | 四维评分（expression/logic/content/job_match） |
| | `created_at` | 时间轴排序 |

**岗位标签规则：** 与题库一致 —— JD trim 后取前 40 字符；将 `internal/question` 的 `jobTagFromJD` 导出为 `JobTagFromJD` 供本模块复用（题库存入时已用同一规则，保证跨功能标签一致）。

---

## 5. API

### 5.1 `GET /api/analytics/trends`

需 JWT；仅统计当前用户数据（`user_id` 归属），他人数据不可见。

Query 参数（均可选）：
- `job_tag` — 精确匹配推导出的岗位标签
- `mode` — `behavioral` | `technical` | `mixed`

**处理流程（全部在 Go 层）：**
1. `SELECT ... WHERE user_id=? AND status='completed' AND score IS NOT NULL ORDER BY created_at ASC`
2. 每条：`JobTagFromJD(job_jd)` 推导标签；解析 `feedback_json` 得四维分；解析失败该条跳过
3. 应用 `job_tag` / `mode` 过滤
4. 汇总统计基于**过滤后**的数据计算
5. `job_tags` 返回过滤前全部已完成面试的**去重标签列表**（供前端下拉），`mode` 是固定枚举由前端渲染

**响应：**

```json
{
  "summary": {
    "total_sessions": 5,
    "avg_score": 81,
    "max_score": 90,
    "min_score": 72,
    "first_score": 72,
    "latest_score": 88,
    "delta": 16
  },
  "points": [
    {
      "date": "2026-08-01",
      "session_id": 1,
      "job_tag": "Go 后端开发工程师，负责使用 Go/Gin…",
      "mode": "technical",
      "total": 72,
      "expression": 70,
      "logic": 75,
      "content": 68,
      "job_match": 74
    }
  ],
  "job_tags": ["Go 后端开发工程师，负责使用 Go/Gin…"]
}
```

- `points` 按 `created_at` 升序；`date` 取 `created_at` 的 `YYYY-MM-DD`
- `delta = latest_score - first_score`；`avg_score` 四舍五入为整数
- 单场 `total` 直接取 `score` 字段，维度分从 `feedback_json` 取
- 无符合条件数据时：`summary` 各字段为零值、`points=[]`、`job_tags=[]`，返回 200

---

## 6. Frontend (Chinese UI)

| Surface | Change |
|---------|--------|
| 顶栏（列表/详情/报告/新建等） | 增加「成长分析」链接 → `/trends` |
| `/trends` | 汇总统计卡 + 两个折线图 + 筛选 + 空状态 |

**`TrendsPage.tsx`：**
- 汇总统计卡：面试场次、平均分、最高分、最低分、最近 vs 最早变化（`+16` 绿 / `-5` 红）
- 「总分趋势」LineChart：单条总分折线，tooltip 显示日期/分数/岗位标签/模式
- 「维度趋势」LineChart：表达/逻辑/内容/岗位匹配四条线同图，图例可点击显隐
- 筛选：岗位标签下拉（`job_tags` 动态）+ 面试模式下拉（行为面试/技术面试/综合面试），均含「全部」
- 空状态：「还没有已完成评分的面试，完成一场面试后再来看成长趋势吧。」
- 加载/错误状态沿用现有页面模式

---

## 7. Acceptance

| ID | Expectation |
|----|-------------|
| C1 | 仅本人 `completed` 且有 `score` 的面试计入 |
| C2 | 四维分解析正确；坏 `feedback_json` 的场次被跳过且不影响其他场次 |
| C3 | `job_tag` / `mode` 筛选生效，`summary` 随筛选条件变化 |
| C4 | 无数据时返回空结构，前端显示空状态文案 |
| C5 | 用户 B 不可见用户 A 的分数数据 |
| C6 | `points` 按时间升序，`delta = latest - first` 正确 |
| C7 | 前端 `npm run build` 通过 |

---

## 8. Implementation notes

- Backend module: `internal/analytics`（repo/service/handler + service_test.go），挂到现有 Gin 路由，JWT 复用现有中间件。
- 复用：`interview.Repo`（或补充只读查询）；`question.JobTagFromJD`（先导出）；错误处理沿用 `ErrNotFound` 风格。
- Frontend：新增 `recharts` 依赖；`/trends` 路由；`TrendsPage.tsx` + 顶栏入口（复用 `InterviewPages.css` 或少量新样式）。
- Tests：Go 集成测试镜像现有 `service_test.go` 模式（注册用户 → 造多场 completed 面试 → 断言聚合/过滤/隔离）；前端仅 build 验证。
- Prefer branch `feat/v2c-trends` from main HEAD（当前 main 含 V1+V2A+V2B）。

---

## Spec self-review

- [x] 无 TBD / 占位符
- [x] 与 locked decisions 一致（数据源、聚合位置、图表库、页面位置）
- [x] 范围聚焦单一实施计划；Non-goals 明确排除 LLM 总结/导出/标签实体
- [x] 归属与过滤语义显式（过滤后汇总、job_tags 不过滤）
