# Interview Assistant

## Prerequisites

- Go 1.22+
- Docker (for MySQL and Redis)

## Quick start

1. Copy environment variables:

   ```bash
   cp .env.example .env
   ```

   Set `JWT_SECRET` (required). Other values have sensible defaults.

2. Start dependencies:

   ```bash
   docker compose up -d
   ```

3. Run the API server:

   ```bash
   cd backend
   go run ./cmd/server
   ```

4. Verify health:

   ```bash
   curl http://127.0.0.1:8080/healthz
   ```

   Expected: `{"ok":true}`
