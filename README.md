# Ledger — Self-hosted Personal Finance

## Stack
- **Backend**: Fastify + MariaDB + BullMQ/Redis worker + Plaid + Nodemailer
- **Frontend**: React + Vite + Tailwind, served by nginx
- **Infra**: Docker Compose (5 services: db, redis, api, worker, web)

## Quick start

```bash
# 1. Configure
cp .env.example .env
# Edit .env — set passwords + secrets
openssl rand -hex 64   # JWT_SECRET
openssl rand -hex 32   # ENCRYPTION_KEY

# 2. Build & start
docker compose up -d --build

# 3. Run migrations (creates schema + admin user)
docker compose exec backend npm run migrate

# 4. Open http://localhost:8080 and log in with INITIAL_USER_EMAIL / INITIAL_USER_PASSWORD