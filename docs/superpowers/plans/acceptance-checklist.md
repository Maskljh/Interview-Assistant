# MVP Acceptance Checklist

Run against local MySQL + Redis. Date: 2026-08-10 (Task 12).

Environment notes:
- MySQL: existing `template-mall-mysql` container (`root`/`root`, database `interview`, tables migrated)
- Redis: `feat-mvp-v1-redis-1` on `127.0.0.1:6379`
- API: `go run ./cmd/server` with `JWT_SECRET=dev-change-me`
- `DEEPSEEK_API_KEY`: **not set** unless noted below

| ID | Check | Result | Notes |
|----|-------|--------|-------|
| A1 | Register/login JWT works | **PASS** | `POST /api/auth/register` and `POST /api/auth/login` return `token` + `user`; `GET /api/interviews` with Bearer succeeds; invalid token returns 401 |
| A2 | Create+start with each mode; resume optional | **PARTIAL** | Create works for `behavioral`, `technical`, `mixed` (status `draft`). Start returns **502** without DeepSeek key. Resume path not exercised (requires in-progress session + LLM) |
| A3 | Observe follow-up or rule skip; end normally | **BLOCKED** | Requires live WS session with LLM (DeepSeek key). Rule-skip logic covered by backend unit tests (`decide_test.go`) |
| A4 | Report dimensions + history | **PARTIAL** | `GET /api/interviews/:id` returns questions + turns history. `GET /api/interviews/:id/report` returns 409 `report not available` on completed session without LLM-generated feedback |
| A5 | Second user 404 on first user's id | **PASS** | User B `GET /api/interviews/{user A session id}` → 404 `not found` |
| A6 | Kill WS, reconnect keeps pending question; retry report after simulated fail | **BLOCKED** | WS reconnect + report retry require DeepSeek key and manual/browser WS testing |

## CORS verification

| Check | Result |
|-------|--------|
| `Origin: http://localhost:5173` → `Access-Control-Allow-Origin: http://localhost:5173` | **PASS** |
| `Origin: http://127.0.0.1:5173` → matching allow-origin | **PASS** |
| `Origin: http://evil.example` → no allow-origin header | **PASS** |
| `Access-Control-Allow-Headers` includes `Authorization` | **PASS** |
| OPTIONS preflight returns 204 | **PASS** |

## Blockers for full PASS

1. **No `DEEPSEEK_API_KEY`** — interview start, WS Q&A, report generation, and A3/A6 cannot be completed end-to-end via API.
2. **A6 WS reconnect** — best verified in browser with frontend + valid DeepSeek key.

## To complete remaining checks

```powershell
$env:DEEPSEEK_API_KEY = "sk-your-key"
cd backend
go run ./cmd/server
```

Then: start interview → open room in browser → answer questions → force end → view report → retry if needed → disconnect/reconnect WS mid-session.
