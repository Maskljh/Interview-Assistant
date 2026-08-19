# V16 腾讯云数智人接入 — 设计规格

**Date:** 2026-08-19
**Status:** Draft
**Parent:** V15 实时视频面试（stub）之后的真实服务商接入
**Approach:** 把 V15 的 stub Provider 换成腾讯云数智人（IVH）真实服务：后端签发会话签名（sign），前端用腾讯官方 H5 SDK（`TXIVHSDK_Web_Cloud_V5.4.2_Release.js`，全局对象 `IVH`）建会话并播放 webrtc 流，后端 REST 驱动口播。未配置/失败自动回退 V14。

---

## 1. Goal

让语音面试的面试官从"stub 示例视频"变成**腾讯云数智人真实数字人**：进入面试后前端 SDK 建立 webrtc 实时流，面试官持续在线；后端收到 WS 题目后驱动其口播；作答期间静默等待。全程后端掌控签名与驱动，`AccessToken` 不出后端。

---

## 2. Locked decisions

| 决策点 | 选择 |
|--------|------|
| 服务商 | **腾讯云数智人（IVH）**，域名 `https://gw.tvs.qq.com`，REST 路径 `/v2/` 前缀 |
| 会话归属 | **服务端签名、客户端建流**（腾讯官方推荐模式）：后端签发 `sign`（appkey+timestamp+signature），前端 SDK `createSession` 建 webrtc 流并播放 |
| 驱动口播 | **后端 REST 驱动**：`POST /v2/ivh/interactdriver/interactdriverservice/command`（`Command:"SEND_TEXT"`），驱动与视频流解耦，后端仍掌控"驱动说话" |
| 前端播放 | **腾讯官方 H5 SDK**（`TXIVHSDK_Web_Cloud_V5.4.2_Release.js`，全局 `IVH`），webrtc 流用其内嵌播放器；SDK 文件放 `frontend/public/`（官方仓库获取） |
| 形象 | 2D照片（`virtualmanProjectId` 已在控制台创建，含配额） |
| 模式衔接 | **升级现有 voice 模式**（text/voice 二选一不变）；不新增第三模式 |
| 摄像头 | 仅本地预览（不变，不上传） |
| 字幕 | 保留（前端 overlay，题目全文） |
| 降级 | 未配置腾讯/sign 失败/SDK 建流失败 → **回退 V14**（预生成视频/TTS），面试不中断 |
| 架构 | 后端 `internal/livestream` 扩展：新增 `provider_tencent.go`、`sign` REST 端点；`Session` 接口语义微调；**零 DB 改动** |
| 凭证 | 后端 `.env`：`LIVESTREAM_PROVIDER=tencent` + `TENCENT_APPKEY` / `TENCENT_ACCESSTOKEN` / `TENCENT_PROJECT_ID`；AccessToken 不出后端 |
| 分支 | `feat/v16-tencent-ivh` from main HEAD |

---

## 3. Non-goals (V16)

- 前端 SDK 驱动口播（`IVH.play`）——驱动走后端 REST，SDK 只播放
- 用户摄像头画面上传 / 表情感知 / 录制
- 视频存档 / 回放
- 新增 video 第三输入模式
- 讯飞 / 其他服务商（抽象层已预留，本次只接腾讯）

---

## 4. Architecture

```text
Browser (voice 模式, tencent provider)
 ├─ 进入：GET /api/livestream/sign ──► 后端签发 sign（appkey+timestamp+signature+projectId+userId）
 │         ◄── { appkey, timestamp, signature, virtualmanProjectId, userId }
 ├─ 前端 IVH SDK：init({sign,...}) → createSession() → startSession() → webrtc 流播放（内嵌播放器）
 ├─ 驱动口播：WS question ──► 前端调 POST /api/livestream/sessions/:id/speak ──► 后端 REST SEND_TEXT → 数字人口播
 ├─ 作答：录音 → ASR → WS answer（现有链路不变）
 └─ 摄像头：getUserMedia 本地预览（不变）
```

| 单元 | 职责 |
|------|------|
| `internal/livestream` | `Provider`/`Session` 接口（保留）+ `provider_tencent.go`（腾讯 REST 实现）+ `sign` handler + stub 保留作降级 |
| 前端 `LivestreamPersona` | 加载 IVH SDK、`init`/`createSession`/`startSession` 建流播放；驱动走后端 speak |
| 前端 `api/livestream.ts` | 新增 `getLivestreamSign()`；`createLivestreamSession` 语义调整 |
| 房间页 | 进入 voice 调 sign + SDK 建流；失败回退 V14；speak/close 保留 |

**关键设计**：腾讯"视频流会话"（前端 SDK 建）与"驱动指令"（后端 REST）解耦。前端只负责建流播放，后端掌控驱动口播，`AccessToken` 不出后端。

---

## 5. 后端：`internal/livestream` 扩展

### 5.1 sign REST 端点

新增 `GET /api/livestream/sign`（JWT 保护）：

- 输入：无（userId 由后端生成，如 `interview-<interviewId>-<userID>` 或随机 UUID）
- 输出：`{ appkey, timestamp, signature, virtualmanProjectId, userId }`
- 签名算法（实测通过）：query 公共参数 `appkey`、`timestamp` 按字典序拼 `k=v&k=v`，用 `AccessToken` 作密钥 HmacSha256，Base64 后 URL 编码得 `signature`
- `timestamp` 为当前秒级时间戳，与服务器时间差需 <5 分钟

### 5.2 provider_tencent.go

实现 `Provider`/`Session` 接口（现有 `Session` 为 `StreamURL()/Speak()/Close()`）：

- `Config` 复用 `livestream.Config` 的 `ProviderName/APIKey/Secret/AvatarID`（语义映射：`APIKey`=appkey、`Secret`=accesstoken、`AvatarID`=projectId）
- `StartSession`：调腾讯 `createsession`（`Protocol: "rtmp"` 或 `webrtc`，`DriverType: 1` 纯文本驱动）→ 轮询 `statsession` 至就绪 → 返回 `Session`
- `Session.Speak`：调 `command`（`SEND_TEXT`）
- `Session.Close`：调 `closesession`
- `NewProvider` 注册 `"tencent"` 分支
- **会话归属澄清**：视频流会话由前端 SDK 建立（相同 userId 会顶掉旧流）。后端 `StartSession` 的腾讯会话仅用于"驱动指令"的承载对象——`createsession` 返回的 `SessionId` 供 `command`/`closesession` 使用，`StreamURL()` 对 tencent 场景前端不使用（播放由 SDK 自己建流）。speak 驱动的是 SDK 已建的那路视频流会话。

### 5.3 main.go / config

- `config.go` 加 `TencentAppKey` / `TencentAccessToken` / `TencentProjectID`
- `main.go` 构造 tencent provider（`APIKey`/`Secret`/`AvatarID` 映射）
- `.env`：`LIVESTREAM_PROVIDER=tencent` + 腾讯三凭证

---

## 6. 前端

### 6.1 API client（`api/livestream.ts`）

- 新增 `getLivestreamSign(): Promise<LivestreamSign>`（`GET /api/livestream/sign`）
- `LivestreamSign = { appkey, timestamp, signature, virtualmanProjectId, userId }`
- `createLivestreamSession` / `speakLivestream` / `closeLivestream` 保留（speak/close 仍走后端 REST）

### 6.2 LivestreamPersona 改造

- props 调整：接收 `sign: LivestreamSign`（而非 `streamURL`）
- 挂载后：动态加载 `public/TXIVHSDK_Web_Cloud_V5.4.2_Release.js` → `IVH.init({ sign, virtualmanProjectId, element })` → `IVH.createSession()` → `IVH.startSession()`
- 播放就绪回调（`onReady`）通知父组件"已就绪"（驱动口播前置条件）
- 控制：静音/重播/跳过保留；重播走后端 speak
- 卸载：`IVH.closeSession()`

### 6.3 房间页

- 进入 voice 模式：调 `getLivestreamSign()` → 传入 `LivestreamPersona`；失败 → 回退 V14
- 收到 WS question：`liveReady && liveAvailable` → 调后端 `speakLivestream`；否则 V14
- 卸载 / 结束：`closeLivestream` + SDK closeSession

---

## 7. 错误处理与降级

| 场景 | 行为 |
|---|---|
| 未配置腾讯 / sign 失败（503） | `liveAvailable=false`，回退 V14 |
| SDK 建流失败 / 播放错误（onError） | 回退 V14 当前题 |
| speak 失败（502） | 字幕仍在；重播可重试 |
| 会话结束 | 前端 SDK closeSession + 后端 speak 会话清理 |

---

## 8. 测试

### 后端

- sign handler：JWT 鉴权、签名格式（appkey/timestamp/signature 非空、projectId 正确）
- provider_tencent：签名算法单测（用已知 appkey/accessToken 断言 HmacSha256 结果）；createsession/command/closesession 的请求构造（用 httptest mock 腾讯端点）

### 前端

- `npm run build` 通过
- 真实环境手工验证：进入语音面试 → SDK 建流 → 数字人出现 → 收到题目口播 → 录音作答 → 下一题 → 结束（真实配额，用完即关）
- 模拟失败（清空 TENCENT 配置）→ 回退 V14

---

## 9. 已实测验证（本规格前置）

- 腾讯 IVH 签名算法（HmacSha256 + appkey/timestamp/signature）✅
- `createsession`/`statsession`/`startsession`/`command(SEND_TEXT)`/`closesession` 全链路 ✅（Code 0，数字人已口播）
- 并发配额：此前被 demo 残留会话占用，已关闭释放（`LimitExceeded` → 建会话成功）
