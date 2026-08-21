# V14 视频表情 / 行为信号分析 — 设计规格

**Date:** 2026-08-21  
**Status:** Design approved (pending implementation)
**Parent:** V1 MVP + V2 题库/语音/成长 + V3 画像 + V4 PWA + V5 人格 + V6 预检 + V7 专项 + V8 表达分析 + V13 静态形象  
**Approach:** TensorFlow.js 浏览器端本地分析（MediaPipe FaceMesh 关键点）→ 启发式规则算情绪/点头/紧张度 → 面试结束只上报聚合指标 JSON 到后端，报告页新增「行为信号」辅助反馈区（不参与 4 维评分，无数字人形象）

---

## 1. Goal

在面试过程中（用户授权后）采集摄像头画面，识别表情/行为信号（情绪、紧张度、点头等），作为报告的「辅助反馈」区——不参与 4 维评分，不引入数字人形象。视频画面不出浏览器，只把聚合统计结果存库并在报告页展示。

---

## 2. Locked decisions

| 决策点 | 选择 |
|--------|------|
| 分析位置 | **浏览器端本地分析**（TensorFlow.js），视频/帧不上传；聚合指标 JSON 经 REST 存后端 |
| 信号范围 | 情绪标签分布 + 点头次数 + 紧张度（均值 + 分段走势） |
| 情绪识别 | **关键点几何启发式规则**（嘴部开合 MAR / 眼睑开合 EAR / 眉毛角度），非云端情绪模型；报告注明低置信度参考 |
| 输出位置 | 报告页新增「行为信号」辅助反馈卡（沿用 V8「表达分析」模式），不新增页面 |
| 数据流向 | 面试结束（done/force-end）时前端 POST 聚合结果；面试过程中不实时上传，只在本机统计 |
| 授权时机 | **创建面试时复选框**「开启摄像头分析（可选）」，默认关闭 |
| 实时展示 | 面试间轻量指示（「摄像头分析中…」+ 简洁紧张度指示灯），不做完整仪表盘 |
| 降级 | 浏览器不支持 / 模型加载失败 / 用户拒绝权限 → 静默不启用，面试正常进行，报告不显示该区块 |
| 评分口径 | 4 维评分不变；行为信号为附加辅助展示，附「仅供参考」说明 |
| 隐私 | 不保存原始画面/帧；仅存情绪分布、点头次数、紧张度、帧数、时长等聚合统计 |
| 执行顺序 | 分支 `feat/v14-behavior-analysis` from main HEAD |

---

## 3. Non-goals (V14)

- 精确情绪识别（不做云端情绪模型/科学级识别；启发式规则 + 低置信度说明）
- 视频/帧持久化（绝不保存原始画面）
- 数字人形象 / 摄像头画面回显给面试官（无数字人，画面仅本地用于分析）
- 实时仪表盘（图表、逐帧波形等）——仅轻量指示
- 行为数据参与 4 维评分或总分
- 历史行为趋势汇总页（仅单场报告展示）
- 云端人脸识别 / 第三方表情 API

---

## 4. Data model

迁移 `010_behavior.sql`：

```sql
CREATE TABLE IF NOT EXISTS interview_behavior (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  session_id BIGINT NOT NULL,
  user_id BIGINT NOT NULL,
  emotion_distribution JSON NOT NULL,
  nod_count INT NOT NULL DEFAULT 0,
  stress_level INT NOT NULL,
  stress_segments JSON NULL,
  face_detected_frames INT NOT NULL DEFAULT 0,
  duration_ms INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_behavior_session FOREIGN KEY (session_id) REFERENCES interview_sessions(id) ON DELETE CASCADE,
  UNIQUE KEY uq_behavior_session (session_id)
);
```

- `emotion_distribution`：`{"smile":12,"neutral":38,"focus":30,"surprise":12,"frown":8}`（帧数占比，键为情绪标签，值为该标签的帧数）
- `stress_level`：0–100 整数，整场紧张度均值
- `stress_segments`：按时间分段的紧张度数组（`[{"t_ms":0,"v":35},{"t_ms":30000,"v":60},...]`），供报告页走势展示；可 NULL
- `face_detected_frames`：有效人脸帧数（用于置信度；过低则报告提示数据不准确）
- `duration_ms`：实际分析时长
- 每 session 至多一条（`UNIQUE KEY`）；首次写入生效，后续写入忽略（幂等）

---

## 5. 信号采集与分析（前端，本地推理）

### 5.1 依赖

- `@tensorflow/tfjs` + `@tensorflow-models/face-landmarks-detection`（MediaPipe FaceMesh，478 关键点）
- 模型 lazy-load（进入面试间、用户已勾选摄像头时才开始加载；加载失败 → 静默降级）

### 5.2 特征提取（关键点几何，启发式）

| 信号 | 计算 | 输出 |
|---|---|---|
| 情绪标签 | 嘴部开合比 MAR（微笑/张大嘴）、眼睑开合比 EAR（眨眼/瞪眼）、眉毛角度（皱眉/挑眉）规则映射 → `smile / neutral / focus / surprise / frown` | 每帧一个标签 → 整场帧数分布 |
| 点头 | 鼻尖 + 两眼关键点求俯仰角 pitch，检测「快速下压-回弹」重复周期事件 | `nod_count` 整数 |
| 紧张度 | 加权综合：眨眼频率（vs 基线）+ 头部晃动幅度（yaw/pitch 方差）+ 表情状态切换频率 → 映射 0–100 | 每帧紧张度 → 均值 + 时间分段 |

### 5.3 边界与说明

- 启发式规则非科学级情绪识别 → 报告区附「本指标基于表情动作统计，仅供参考」
- 关键点不用于身份识别；不保存原始画面/帧
- `face_detected_frames` 占比过低（如 < 30% 或总帧数过少）→ 报告提示「未检测到清晰人脸，数据可能不准确」
- 摄像头被遮/中断 → 保留已采数据，停止分析，不阻断面试

---

## 6. 后端（新模块 `internal/behavior`）

### 6.1 API

`POST /api/interviews/:id/behavior`（JWT，session 归属校验——无归属 → 404）：

请求体（聚合结果，前端上报）：
```json
{
  "emotion_distribution": {"smile":12,"neutral":38,"focus":30,"surprise":12,"frown":8},
  "nod_count": 14,
  "stress_level": 42,
  "stress_segments": [{"t_ms":0,"v":35},{"t_ms":30000,"v":60}],
  "face_detected_frames": 920,
  "duration_ms": 92000
}
```

- 仅允许 `emotion_distribution` / `nod_count` / `stress_level` / `stress_segments` / `face_detected_frames` / `duration_ms` 字段（白名单解析，避免多余字段入库）
- 首次写入生效，重复写入忽略（幂等，基于 `uq_behavior_session`）
- 校验：`stress_level` 0–100；`nod_count`/`face_detected_frames`/`duration_ms` ≥ 0；请求体大小限制（如 ≤ 64KB）

`GET /api/interviews/:id/behavior`（JWT，session 归属校验——无归属 → 404）：
```json
{
  "available": true,
  "emotion_distribution": {"smile":12,"neutral":38,"focus":30,"surprise":12,"frown":8},
  "nod_count": 14,
  "stress_level": 42,
  "stress_segments": [{"t_ms":0,"v":35},{"t_ms":30000,"v":60}],
  "face_detected_frames": 920,
  "duration_ms": 92000
}
```
无记录 → `{"available": false}`（不报错）

### 6.2 结构

- `Service{ repo *interview.Repo }` + `internal/behavior/repo.go`（读写 `interview_behavior`）
- `Save(ctx, userID, sessionID, payload) error`：校验归属 → 幂等 INSERT
- `Get(ctx, userID, sessionID) (Result, error)`：校验归属 → 读取；无记录 → `available: false`
- `RegisterRoutes(r, db, secret)` → 挂 `/api/interviews/:id/behavior`（GET + POST），用 `interview` 的 Repo（同 V8 expression 模式，无循环依赖）
- `main.go`：`behavior.RegisterRoutes(r, sqlDB, cfg.JWTSecret)`（放 expression 路由附近）

---

## 7. Frontend (Chinese UI)

### 7.1 创建面试页 `CreateInterviewPage`

- 新增复选框「开启摄像头分析（可选）」，默认不勾选，附说明「面试中采集表情/行为信号，仅本地分析，不上传画面」
- 状态 `cameraEnabled`；随创建请求提交
- 不勾选 → 面试间不启动摄像头分析（静默无区块）

### 7.2 创建请求 `api/interviews.ts`

- `createInterview` / `createInterviewFromBank` 请求体加 `camera_enabled: boolean`（可选）
- 后端 session 持久化该开关（迁移 010 在 `interview_sessions` 加列 `camera_enabled TINYINT(1) NOT NULL DEFAULT 0`，或存于前端 localStorage——**决策：持久化到 session 表**，见 §8）

### 7.3 面试间 `InterviewRoomPage`

- 加载面试时读取 `camera_enabled`；为 true 才尝试启动分析
- 组件拆分（可测试独立单元）：
  ```
  frontend/src/behavior/
    useBehaviorAnalysis.ts    # Hook：启动/停止、协调各模块、生命周期
    FaceLandmarkDetector.ts   # tfjs 模型 lazy-load 封装，detect(frame) → keypoints
    signalExtractors.ts       # 纯函数：MAR/EAR/pitch、情绪分类、点头检测、紧张度
    aggregator.ts             # 纯函数：帧序列 → 聚合 JSON（可单测）
    cameraFeed.ts             # getUserMedia 封装、canvas 抽帧、优雅降级
  api/behavior.ts             # POST/GET 封装
  ```
- 轻量实时指示：状态条显示「摄像头分析中…」；简洁紧张度指示灯（低/中/高三档色）
- 面试结束（`done` / force-end）时：停止分析 → 调 `POST /api/interviews/:id/behavior` 上报聚合结果；上报失败不影响导航与面试流程
- 卸载/中断：停止摄像头与模型，释放资源

### 7.4 报告页 `ReportPage`

- 新增「行为信号」辅助反馈卡（feedback 区下方，V8 表达分析卡附近），读取 `GET /api/interviews/:id/behavior`
- 展示：
  - 情绪分布：各情绪标签占比（如「微笑 12% / 中性 38% / 专注 30% / 惊讶 12% / 皱眉 8%」）
  - 点头：`点头 N 次`
  - 紧张度：`紧张度 X / 100`（附参考说明）+ 分段走势（简单条形/文本，可后续增强）
  - 低置信度提示：「本指标基于表情动作统计，仅供参考」
  - `face_detected_frames` 占比过低 → 「未检测到清晰人脸，数据可能不准确」
  - 无记录 / 加载失败：静默不显示（不阻断报告）
- 复用 design tokens，无新页面

---

## 8. 开关持久化决策

- `camera_enabled` 作为 session 属性存 `interview_sessions`（新增列 `camera_enabled TINYINT(1) NOT NULL DEFAULT 0`），随创建请求写入
- 迁移 `010_behavior.sql` 同时创建 `interview_behavior` 表并给 `interview_sessions` 加 `camera_enabled` 列
- 后端 `Session` 模型、repo 的 INSERT/SELECT/scan 同步加该字段
- 读取：面试间加载 session 时取 `camera_enabled` 决定是否启动分析；报告页通过 `behavior.available` 决定是否显示区块（不依赖 `camera_enabled` 回读，直接查 behavior 记录）

---

## 9. Privacy & Security

1. **默认关闭**：创建面试复选框默认不勾选
2. **视频不出浏览器**：tfjs 本地推理，绝不 POST 画面/帧
3. **仅存聚合指标**：情绪分布、点头次数、紧张度、帧数、时长——无可重建人脸的信息
4. **只在新会话生效**：创建时勾选 → session 持久化 → 面试间读取决定
5. **静默降级**：浏览器不支持 / 模型加载失败 / 用户拒绝权限 → 不启摄像头，面试正常，报告无区块
6. 聚合数据不涉原始画面，删除/清理成本低；如需可后续提供「删除行为数据」入口（本次不做）

---

## 10. 错误处理

| 场景 | 行为 |
|---|---|
| 浏览器无 `getUserMedia` | 静默不启用，报告隐藏区块 |
| 模型加载失败/超时 | 静默降级 |
| 用户拒绝摄像头权限 | 静默降级，不弹第二次 |
| 分析中摄像头中断 | 停止分析，保留已采数据 |
| 上报失败（网络） | 面试流程不受影响；报告页该区块显示「未获取到行为数据」 |
| `face_detected_frames` 占比过低 | 报告页提示数据不准确 |
| 后端重复上报 | 幂等忽略（首次写入生效） |

---

## 11. Testing

### 前端（vitest，纯函数优先）
- `signalExtractors`：合成关键点数据验证情绪分类（MAR/EAR/眉毛规则）、点头计数（pitch 周期）、紧张度（眨眼/晃动/切换频率）
- `aggregator`：帧序列 → 聚合 JSON 结构、分段、均值、帧数统计
- `useBehaviorAnalysis`：mock detector 验证生命周期（启动→分析→停止→上报）、降级路径（无 getUserMedia / 加载失败 / 权限拒绝）
- 构建：`npm run build` 通过

### 后端（go test）
- `behavior` 包：Save 幂等（重复 POST 不覆盖）、归属校验（他人 session → 404）、字段白名单/大小限制、Get 无记录 → `available:false`、GET/POST 权限
- 迁移可重复执行
- 无回归：`go test ./... -count=1 -p 1` 全绿

### 手动验收
- 真实摄像头验证点头/情绪/紧张度合理性；拒绝权限/无摄像头/模型加载失败 → 静默降级

---

## 12. Acceptance

| ID | Expectation |
|----|-------------|
| B1 | 创建页有「开启摄像头分析（可选）」复选框，默认关；勾选后 session 持久化 `camera_enabled` |
| B2 | 勾选的面试进入房间后启动摄像头分析（用户浏览器授权），显示轻量「分析中…」指示 |
| B3 | 分析仅在本地进行，绝不发送画面/帧到后端 |
| B4 | 面试结束上报聚合 JSON；重复上报幂等（首次生效） |
| B5 | `GET /api/interviews/:id/behavior` 返回聚合结果；无记录 → `available:false` |
| B6 | 报告页展示「行为信号」辅助反馈卡（情绪分布/点头/紧张度 + 仅供参考说明）；不参与 4 维评分 |
| B7 | 未勾选 / 浏览器不支持 / 模型加载失败 / 权限拒绝 → 静默降级，面试正常，报告无区块 |
| B8 | 用户隔离：他人 session → 404 |
| B9 | 无回归：`go test ./... -count=1 -p 1` 全绿 + `npm run build` 通过 |

---

## 13. Implementation notes

- Backend: `internal/behavior`（service.go + handler.go + repo.go + 测试）；`interview` 的 Session 模型/repo INSERT/SELECT/scan 加 `camera_enabled`；迁移 `010_behavior.sql`
- `main.go`：`behavior.RegisterRoutes(r, sqlDB, cfg.JWTSecret)`
- Frontend: `api/interviews.ts` 加 `camera_enabled`；`api/behavior.ts`；`behavior/` 新目录（useBehaviorAnalysis / FaceLandmarkDetector / signalExtractors / aggregator / cameraFeed）；`CreateInterviewPage` 复选框；`InterviewRoomPage` 启动分析 + 结束上报 + 轻量指示；`ReportPage` 行为信号卡
- `package.json`：加 `@tensorflow/tfjs`、`@tensorflow-models/face-landmarks-detection`
- 情绪标签集合固定：`smile / neutral / focus / surprise / frown`（中文标签映射在 `lib/labels.ts` 或 behavior 模块内）
- 前端模型 lazy-load + 静态 import 控制体积；失败降级不影响主流程
- Prefer branch `feat/v14-behavior-analysis` from main HEAD

---

## Spec self-review

- [x] 无 TBD / 占位符
- [x] 与 locked decisions 一致（本地分析、情绪/点头/紧张度、仅聚合存库、创建时开关、轻量指示、静默降级、评分不变）
- [x] 范围聚焦单一实施计划；Non-goals 明确排除精确识别/视频持久化/数字人/实时仪表盘/评分联动
- [x] 数据模型（`interview_behavior` + `camera_enabled`）、聚合 JSON 结构、幂等语义、降级输出显式
- [x] 隐私边界明确（画面不出浏览器、仅存聚合指标）
