# V10 面试房间体验修复 — 设计规格

**Date:** 2026-08-17  
**Status:** Draft for user review  
**Parent:** 全功能（V1–V9）体验审查后的 P0 修复  
**Approach:** 修复断线重连体验（自动重连 + 心跳 + 对话恢复）、语音短按竞态、首条语速失真

---

## 1. Goal

修复体验审查中确认的三个 P0 问题：
1. **断线后不能自动恢复**——现在断线只显示「连接已断开」+ 手动按钮，网络闪断（移动端常见）体验中断
2. **语音短按竞态**——按住还没拿到麦克风就松手，回答静默丢失且无任何提示
3. **首条语速失真**——录音时长从 getUserMedia 之前开始计，麦克风授权等待被算入语速（V8 引入）

---

## 2. Locked decisions

| 决策点 | 选择 |
|--------|------|
| 自动重连 | **指数退避 5 次**（1s/2s/4s/8s/8s）；重连中显示「连接中断，正在重连（第 N 次）…」；`session_started` 收到即重置；5 次全败 → 降级为现有「重新连接」手动按钮（点击重置计数） |
| 心跳 | **服务端 ping/pong**：gorilla 定时 ping（30s）+ pong 更新读超时（60s）+ 读超时判死；假死连接 60s 无帧即关闭 → 触发前端 onclose → 自动重连 |
| 对话恢复 | **加载时填充 turns**：房间页 `loadAndConnect` 用 `getInterview` 返回的 turns 填充初始 transcript（顺带修复刷新后历史对话丢失）；`turnIdRef` 从接口最大 id 继续 |
| 短按竞态 | 录音前先置「正在准备录音…」；松手时麦克风未就绪 → 提示「录音未开始，请重试」并置取消标记；就绪后检测到取消 → 释放麦克风回 idle |
| 语速计时 | `recordStartRef = Date.now()` 移到 `await startRecordingSession()` **之后**（录音真正开始） |
| 范围 | 前端 `InterviewRoomPage.tsx` + 后端 `ws/handler.go`；不动 WS 协议与消息类型 |
| 分支 | `feat/v10-room-experience-fixes` from main HEAD |

---

## 3. Non-goals (V10)

- WS 应用层心跳消息 / 协议改动（`ClientMsg`/`ServerMsg` 类型不变）
- 前端自动重连的上限调优（5 次指数退避为本次定值）
- 语音识别失败的自动重传（保留现状：失败提示重录）
- 结束面试/评分中的进度条（README 已知限制，另议）
- 移动端导航重构（顶栏/底部标签重复问题，另议）

---

## 4. 后端：WS 心跳（`backend/internal/ws/handler.go`）

在 `Serve` 的升级后、`BeginLive` 前：

```go
const (
	pingPeriod   = 30 * time.Second
	writeWait    = 10 * time.Second
	pongWait     = 60 * time.Second
)

// 升级后：
conn.SetReadDeadline(time.Now().Add(pongWait))
conn.SetPongHandler(func(string) error {
	return conn.SetReadDeadline(time.Now().Add(pongWait))
})

// 独立 goroutine 定时 ping（写用锁保护，避免与消息写入竞争）：
go func() {
	ticker := time.NewTicker(pingPeriod)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		case <-ctx.Done():
			return
		}
	}
}()
```

- 读循环的 `ReadJSON` 因读超时（60s 无 pong）返回错误 → `Serve` return → `defer conn.Close()` → 前端 `onclose` 触发
- 前端收到 ping 由浏览器自动回 pong（原生 WS 行为），前端无改动
- 多客户端/多连接由既有 Hub 管理，心跳 per-connection 独立

---

## 5. 前端：自动重连（`InterviewRoomPage.tsx`）

- `connect()` 内部改为带重连逻辑的 `connectWithRetry(attempt)`：
  - `attempt` 从 1 起；`onclose`（且 `!doneRef.current`）时若 `attempt <= 5` → `setTimeout` 按间隔（1/2/4/8/8 秒，`attempt` 从 1 映射）重连，`statusLine` 显示「连接中断，正在重连（第 N 次）…」
  - `onMessage` 收到 `session_started` → 重置 attempt（用 ref 持有当前 attempt，避免闭包过期）
  - 第 6 次（attempt > 5）不再自动重连 → `disconnected = true`，显示现有「重新连接」按钮；按钮 onClick 重置 attempt 为 1 再调 `connect()`
- 计时器与连接在 `useEffect` cleanup 清理（`cancelled`/`retryTimerRef`）
- `disconnected` 期间保持显示；重连成功 `session_started` → `setDisconnected(false)`（既有逻辑）
- 关键实现细节：用 `retryTimerRef` 存 timeout id；重连前 `socketRef.current?.close()` 防重复连接

---

## 6. 前端：刷新对话恢复（`InterviewRoomPage.tsx`）

`loadAndConnect` 中 `getInterview` 成功后：

```ts
// 用历史 turns 填充初始对话（修复刷新后对话记录丢失）
if (data.turns.length > 0) {
  const initial: Turn[] = data.turns.map((t) => ({
    id: t.id,
    role: t.role === 'interviewer' ? 'interviewer' : 'candidate',
    content: t.content,
  }));
  setTurns(initial);
  turnIdRef.current = Math.max(0, ...data.turns.map((t) => t.id));
}
```

- 仅加载时填充一次；后续 `appendTurn` 用 `turnIdRef` 继续自增（> 接口最大 id，无冲突）
- 只填充 `role=interviewer|candidate` 的轮次；`kind` 不影响展示（现有渲染只看 role/content）
- 填空 turns → 保持现有「正在连接面试间…」空态

---

## 7. 前端：语音短按竞态 + 语速计时（`InterviewRoomPage.tsx`）

**短按竞态：**

```ts
const voiceReadyRef = useRef(false);   // 麦克风是否已就绪
const voiceCancelRef = useRef(false);  // 松手发生在就绪前

async function handleStartRecording() {
  if (disconnected || thinking || ending || voicePhase !== 'idle') return;
  speechVersionRef.current += 1;
  voicePlayerRef.current?.stop();
  setError('');
  voiceCancelRef.current = false;
  voiceReadyRef.current = false;
  setVoicePhase('recording');          // 立即进入录音态，按钮显示「松开发送」
  setStatusLine('正在准备录音…');
  try {
    const recorder = await startRecordingSession();
    if (voiceCancelRef.current) {       // 等待期间已松手
      recorder.cancel();
      voiceRecorderRef.current = null;
      setVoicePhase('idle');
      setStatusLine('录音未开始，请重试');
      return;
    }
    recordStartRef.current = Date.now();  // ← 计时点后移：录音真正开始
    voiceReadyRef.current = true;
    voiceRecorderRef.current = recorder;
    setStatusLine('正在录音，松开发送');
  } catch {
    voiceCancelRef.current = false;
    setVoicePhase('idle');
    setStatusLine('无法访问麦克风，请使用文字作答');
  }
}

function handleStopRecording() {
  const recorder = voiceRecorderRef.current;
  if (!recorder) {
    voiceCancelRef.current = true;     // 麦克风未就绪：标记取消，就绪后释放
    return;
  }
  ... 原逻辑（转写/发送），结束处 voiceReadyRef.current = false
}
```

**计时点后移**：`recordStartRef.current = Date.now()` 从 `startRecordingSession()` 之前移到成功后（上述代码中已体现）；`handleStopRecording` 计算时长逻辑不变。

- `voiceReadyRef`/`voiceCancelRef` 在 cleanup 与 `handleForceEnd` 中一并重置

---

## 8. 测试与验收

| ID | Expectation |
|----|-------------|
| F1 | WS 心跳：服务端 ping/pong 生效（httptest + gorilla dialer 集成测试：建立连接 → 收到 ping → 回 pong → 连接保持；不回 pong → 60s 后服务端关闭） |
| F2 | 自动重连：断线后按 1/2/4/8/8 秒退避重试 ≤5 次；`session_started` 重置；5 次后降级手动按钮（前端逻辑评审 + 代码走查） |
| F3 | 对话恢复：加载时用 turns 填充 transcript，`turnIdRef` 续接（代码走查） |
| F4 | 短按竞态：录音中松手不静默——提示「录音未开始，请重试」或正常进入录音（代码走查 + 手工冒烟） |
| F5 | 语速计时：`recordStartRef` 在 `startRecordingSession` 之后设置（代码走查） |
| F6 | 无回归：`go test ./... -count=1 -p 1` 全绿 + `npm run build` 通过 |

---

## 9. Implementation notes

- Backend: `backend/internal/ws/handler.go`（心跳常量 + ping goroutine + pong handler）；新增 `backend/internal/ws/handler_test.go`（httptest + gorilla dialer 验证 ping/pong 通路与超时关闭）
- Frontend: `frontend/src/pages/InterviewRoomPage.tsx`（重连、turns 填充、竞态、计时）；`interviewSocket.ts` 不动
- 无迁移、无 API 变化、无新依赖
- Prefer branch `feat/v10-room-experience-fixes` from main HEAD

---

## Spec self-review

- [x] 无 TBD / 占位符
- [x] 与 locked decisions 一致（指数退避 5 次、服务端 ping/pong、加载填充 turns、取消标记、计时后移）
- [x] 范围聚焦单一实施计划；Non-goals 明确排除协议改动/自动重传/进度条/导航重构
- [x] 竞态与重连状态机显式；计时点后移与首条语速失真对应
