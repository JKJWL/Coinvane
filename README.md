# Ledger

> Self-hosted personal finance · React PWA · Plaid · Google SSO · zero-knowledge
> at-rest encryption · single-binary deploy via Docker Compose
>
> Source: <https://github.com/JKJWL/Ledger>

A self-hosted personal finance app with bank sync via Plaid, Google Sign-In auth,
end-to-end encrypted secrets, and a mobile-first PWA that you can install on your
iPhone home screen and use behind your own VPN or on the public internet.

Built for one person (or a small household) to replace Mint / Copilot / Monarch
without paying a subscription or handing your financial data to a third party.

---

## Features

### Accounts & transactions
- **Bank sync** — connect any institution Plaid supports (most US banks, brokerages, credit unions). Polls Plaid on a configurable interval (default every 60 min, tunable via `SYNC_INTERVAL_MINUTES`), plus webhook-driven near-real-time updates when your bank pushes them.
- **Pending transactions** — when your bank reports a charge as pending, it shows up immediately with an amber "Pending" badge so you can tell authorized-but-not-yet-settled spending apart from posted activity.
- **Manual accounts** — for banks Plaid doesn't support; balances auto-adjust when you record transactions.
- **Transactions** — date-grouped activity feed with filter by account / category, sort options, tap-to-edit.
- **Per-merchant rules** — recategorise a transaction and choose "all future from this merchant"; the rule is saved per-user and applied to every subsequent sync.

### Budgets
- **Master period** — one reset rhythm drives every budget AND the credit-usage tracker. Pick a cadence on the Income card (weekly, bi-weekly, semi-monthly, monthly, yearly, or every N days from a date) and "this week's groceries", "this week's income", and "this week's allocation total" all line up exactly.
- **Two budget types** — category-based (default) or credit-card-account-based; credit-card transactions are excluded from category budgets to avoid double-counting (swipe + payment).
- **Drag to reorder** — touch and mouse both work; order persists across devices. A lock toggle prevents accidental drags on mobile.
- **Edit any budget** — amount editable after creation. Category and account are locked once a budget is created (use delete + recreate if you need to change either).
- **Budget history** — a date dropdown next to "+ New Budget" walks back through past periods (the last 12 by default). Each period shows what you actually budgeted vs spent AT THAT TIME — amount edits or deletions made later don't rewrite history. Backed by a `budget_audit` table that snapshots every create / update / delete event.
- **Suggested categories** — new-budget form suggests categories you spend on but haven't budgeted yet.
- **Income tracker** — pinned at top, no limit; sums positive transactions over the master period.
- **Credit usage tracker** — only appears when a credit account is linked; per-card breakdown, also master-period bound.
- **Zero-based-budget summary** — dual-color bar at the bottom showing income vs allocated, with "X left to budget" indicator.
- **Themed confirmations** — destructive actions (delete budget, etc.) prompt with an in-app modal, not the native browser dialog.

### Goals
- **Savings goals** with target / progress
- **Contribute** button + quick-add chips ($25 / $50 / $100 / $250 / $500)

### Net worth
- **Net Worth chart** with WTD / MTD / YTD / 1M / 3M / 1Y / ALL toggle (mobile gradient hero + desktop full chart)
- **Spending pulse** — Mint-style monthly breakdown by category

### Investments
- **Holdings, gains/losses** — brokerage syncing via Plaid

### Misc
- **Notes** — free-form notes, content encrypted at rest
- **Mobile PWA** — install to iPhone home screen, full-screen, frosted iOS-style nav, Dynamic Island safe
- **Multi-device** — your dark mode, settings, and data sync between devices
- **Google SSO** — no passwords stored; locked to an email allowlist so only you can sign in

---

## Stack

| Layer       | Tech                                                   |
| ----------- | ------------------------------------------------------ |
| Backend     | Node.js 20, Fastify, MariaDB 11, BullMQ + Redis, Plaid |
| Frontend    | React 18, Vite, Tailwind, Framer Motion, Recharts      |
| Auth        | Google Sign-In (ID-token verification, no client secret needed) |
| Encryption  | AES-256-GCM for Plaid access tokens + note content     |
| Infra       | Docker Compose (5 services)                            |
| Reverse proxy | Caddy with auto-HTTPS (Let's Encrypt) — recommended  |

---

## Quick start (local development)

### Prerequisites

- Docker + Docker Compose
- A Google Cloud OAuth 2.0 Client ID (see [Google setup](#google-cloud-oauth-setup))
- A Plaid account with sandbox keys, at minimum (see [Plaid setup](#plaid-setup))
- `openssl` for secret generation
- `bash` for the bootstrap script (Linux/macOS, or WSL/Git Bash on Windows)

### 1. Clone and bootstrap

```bash
git clone https://github.com/JKJWL/Ledger.git ledger
cd ledger
./bootstrap.sh
```

`bootstrap.sh` will:
- Generate cryptographically-random secrets (JWT, encryption key, DB passwords)
- Prompt you for your Gmail address, Google Client ID, Plaid Client ID, and Plaid Secret
- Write a properly-permissioned `.env` (chmod 600)
- Print your `ENCRYPTION_KEY` once — **save it in a password manager**. If you lose
  this key, all Plaid access tokens and encrypted note content become unrecoverable.

### 2. Build and start

```bash
docker compose build
docker compose up -d
```

### 3. Run database migrations

```bash
docker compose exec backend npm run migrate
```

This creates all tables. Idempotent — safe to re-run after upgrades.

### 4. Sign in

Open http://localhost:8080 (or whatever you've configured), click **Continue with
Google**, and sign in with the email you whitelisted. The first sign-in
automatically promotes you to admin.

---

## Production deployment (Linode / any Ubuntu VPS)

This guide assumes Ubuntu 24.04 LTS. Adapt as needed for other distros.

### 1. Server prep

Pick a non-root username — anything **other than** `ledger`, `admin`, `ubuntu`,
or any other word someone could guess from the project name or distro
defaults. We'll refer to it as `<your-user>` throughout the rest of this
guide; substitute your actual choice. (Yes, your SSH key auth defeats brute
force on its own — but the less an attacker can guess about your setup, the
fewer free attempts they get.)

```bash
# As root, replace <your-user> with whatever username you picked.
adduser <your-user>
usermod -aG sudo <your-user>
mkdir -p /home/<your-user>/.ssh
cp ~/.ssh/authorized_keys /home/<your-user>/.ssh/
chown -R <your-user>:<your-user> /home/<your-user>/.ssh
chmod 700 /home/<your-user>/.ssh
chmod 600 /home/<your-user>/.ssh/authorized_keys
```

Log out, log back in as `<your-user>`, confirm `sudo` works.

### 2. Lock down SSH

`sudo nano /etc/ssh/sshd_config`:
```
PermitRootLogin no
PasswordAuthentication no
PubkeyAuthentication yes
MaxAuthTries 3
ClientAliveInterval 300
ClientAliveCountMax 2
```
`sudo systemctl restart ssh`

### 3. Firewall

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp     # consider restricting to your IP
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

If your VPS has its own cloud firewall (Linode, AWS, DigitalOcean, etc.), **make
sure to also open 80 and 443 there**. UFW won't help if the cloud firewall blocks
traffic first.

### 4. fail2ban + auto-updates

```bash
sudo apt install -y fail2ban unattended-upgrades
sudo systemctl enable --now fail2ban
sudo dpkg-reconfigure --priority=low unattended-upgrades
```

### 5. Docker

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
# log out / back in
```

### 6. Caddy reverse proxy with auto-HTTPS

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
```

Configure `sudo nano /etc/caddy/Caddyfile`:
```
ledger.your-domain.com {
    encode gzip
    reverse_proxy 127.0.0.1:8080
    tls {
        issuer acme {
            disable_tlsalpn_challenge
        }
    }
}
```

The `disable_tlsalpn_challenge` line forces Caddy to use HTTP-01 instead of
TLS-ALPN-01. This works reliably even behind Cloudflare or other proxies.

Point your domain's `A` record at the server's public IP, then:
```bash
sudo systemctl reload caddy
sudo journalctl -u caddy -f    # watch the cert issue
```

You should see "certificate obtained successfully" within a minute.

### 7. Clone and deploy the app

Substitute `<your-user>` with whatever username you created in step 1, and
`<your-domain>` with whatever domain you'll be serving from.

```bash
cd ~                # your-user's home directory
git clone https://github.com/JKJWL/Ledger.git ledger
cd ledger
./bootstrap.sh      # prompts for domain, Google ID, Plaid keys, etc.
docker compose build
docker compose up -d
docker compose exec backend npm run migrate
```

Visit `https://<your-domain>` and sign in.

### 8. Encrypted nightly backups

The example below assumes you keep backups under your user's home directory.
Substitute `<your-user>` (and the project path if you cloned somewhere else).

```bash
sudo nano /etc/cron.daily/ledger-backup
```

```bash
#!/bin/bash
set -e
# Adjust these two paths to match your install.
APP_DIR=/home/<your-user>/ledger
BACKUP_DIR=/home/<your-user>/backups
KEY_FILE=/home/<your-user>/.backup-key

mkdir -p "$BACKUP_DIR"
TS=$(date +%Y%m%d-%H%M%S)
source "$APP_DIR/.env"
docker exec ledger-db mysqldump -uroot -p"$DB_ROOT_PASSWORD" --all-databases \
  | gzip \
  | openssl enc -aes-256-cbc -salt -pbkdf2 -pass file:"$KEY_FILE" \
  > "$BACKUP_DIR/ledger-$TS.sql.gz.enc"
find "$BACKUP_DIR" -name "ledger-*.sql.gz.enc" -mtime +14 -delete
```

```bash
sudo chmod +x /etc/cron.daily/ledger-backup
openssl rand -hex 32 | sudo tee /home/<your-user>/.backup-key
sudo chmod 400 /home/<your-user>/.backup-key
```

Keep a copy of `.backup-key` off-server (password manager, encrypted USB,
etc.). Periodically rsync the backup directory to another host or to S3. To
restore:
```bash
openssl enc -d -aes-256-cbc -pbkdf2 -pass file:.backup-key \
  -in ledger-YYYYMMDD-HHMMSS.sql.gz.enc | gunzip | mysql -uroot -p
```

---

## Google Cloud OAuth setup

1. **Create a project**: https://console.cloud.google.com → "Select a project" → "New Project" → name it `Ledger`.

2. **Configure consent screen**: APIs & Services → OAuth consent screen
   - User type: **External** (Internal only if you have Workspace)
   - App name: `Ledger`
   - User support email, developer contact: your email
   - Skip scopes (OpenID/email/profile included by default)
   - Add your Gmail under **Test users** (so you can sign in before publishing)

3. **Create OAuth Client ID**: APIs & Services → Credentials → Create Credentials → OAuth client ID
   - Application type: **Web application**
   - Name: `Ledger Web`
   - **Authorized JavaScript origins**:
     - `http://localhost:8080` (for local dev)
     - `https://ledger.your-domain.com` (for production)
   - Authorized redirect URIs: leave empty (we use the ID-token flow, no redirect)
   - Click Create → copy the **Client ID** (looks like `123-abc.apps.googleusercontent.com`)

4. **Put the Client ID in `.env`** — bootstrap.sh prompts for this, but it goes in *two* variables with the same value:
   ```
   GOOGLE_CLIENT_ID=123-abc.apps.googleusercontent.com
   VITE_GOOGLE_CLIENT_ID=123-abc.apps.googleusercontent.com
   ```

5. **You never need the Client Secret** — this app uses the ID-token verification
   flow which only needs the public Client ID. Leave the secret in the dashboard,
   unused. Never put it in `.env` or any client-side code.

6. **Once it's working**, you can either:
   - Stay in **Testing** mode and add up to 100 test users (recommended for personal use)
   - Click **Publish App** to remove the warning and the user cap

---

## Plaid setup

1. **Sign up** at https://dashboard.plaid.com — sandbox is free.

2. **Get your keys**: Team Settings → Keys → copy `client_id` and `sandbox secret` for local testing.

3. **Request production access** when you're ready for real banks: Team Settings → request Production. They'll ask for use case ("Personal financial management"), products (Transactions, Investments — see [Plaid products](#which-plaid-products)), privacy policy, and estimated volume.

4. **For OAuth banks** (Chase, US Bank, most credit unions): add your production redirect URI under Team Settings → API → Allowed redirect URIs. Must match `PLAID_REDIRECT_URI` in `.env` character-for-character (including trailing slash).

5. **Webhooks** (optional, for auto-sync push): set `PLAID_WEBHOOK_URL=https://ledger.your-domain.com/api/plaid/webhook` in `.env`. The endpoint is public but signature-verified by Plaid — safe to expose.

### Which Plaid products

This app uses:
- **Transactions** (required) — accounts, balances, transactions
- **Investments** (optional, only added when the institution supports it) — holdings, gains/losses

Skip Auth, Identity, Liabilities, Income, Assets — they're not used here and Plaid charges per-product per-item.

---

## Connecting non-Plaid banks

For institutions Plaid doesn't support (e.g., smaller credit unions):

1. On mobile: Settings → Banks & Accounts → tap **+ Add** under Manual Accounts.
2. On desktop: Accounts tab → **Add Manual** button.
3. Fill in name, institution, type, starting balance.
4. Record transactions manually in Activity. Each transaction auto-updates the
   linked manual account's balance (income adds, expense subtracts). Plaid-linked
   accounts are never touched by manual entries.

---

## Security

This app is designed to be exposed to the public internet safely.

- **Email allowlist** (`ALLOWED_EMAILS` in `.env`) — only Google accounts on this
  comma-separated list can sign in. Anyone else gets a 403, regardless of whether
  Google would otherwise let them through.
- **Rate limiting** — 200 req/min global, 10 req/min on `/api/auth/google` (blocks token-spray).
- **Helmet** — HSTS, X-Frame-Options DENY, strict Referrer-Policy, no `X-Powered-By`.
- **Strict CORS** — refuses to start in production if `CORS_ORIGIN` isn't set.
- **JWT 30-day expiration** — sessions auto-expire; sign back in with one Google click.
- **Encryption at rest** — Plaid access tokens and note content encrypted with AES-256-GCM.
- **Prepared statements** — every DB query uses parameterized `?` placeholders; no string concatenation, no SQL injection surface.
- **Error masking** — production 5xx responses return a generic message; stack traces stay in logs.
- **Audit log** — every sign-in (success and failure) recorded with IP and user agent.
- **Body limit** — 512KB.
- **CSP** — nginx serves a strict Content-Security-Policy locking script sources
  to self, Google, and Plaid.
- **No client-side caching** — every response (HTML, JS, CSS, API, images) is
  served with `Cache-Control: no-store, no-cache, must-revalidate`. Cost is a
  tiny per-page-load bandwidth hit on a single-file React app; benefit is that
  security fixes and bug fixes propagate to every user the instant they
  navigate, with zero chance of a stale bundle masking a deployed fix. The
  login session lives in `localStorage` (not the HTTP cache), so you stay
  signed in despite the no-cache policy.

### Things to do yourself

- Generate **fresh** secrets per environment — don't reuse dev secrets in production
- Back up `ENCRYPTION_KEY` and `.backup-key` off-server (lose either and data is gone)
- Restrict SSH to your home IP in the cloud firewall once everything works
- Enable disk encryption at the VPS level (Linode supports this at provisioning time)

---

## Updating

Standard upgrade flow after `git pull`:

```bash
cd ~/ledger
git pull
docker compose build --no-cache backend frontend
docker compose up -d
docker compose exec backend npm run migrate
```

A few notes:

- **`--no-cache` is recommended** on every upgrade. Docker's layer cache can
  silently reuse stale `RUN npm install` or `RUN npm run build` steps and ship
  you the wrong bundle. Caching what's actually safe to cache costs about 30
  seconds of build time; not catching a stale layer costs hours of debugging.
- **`npm run migrate` is idempotent** and safe to re-run after any pull. It
  uses `CREATE TABLE IF NOT EXISTS` and `ALTER TABLE ... ADD COLUMN IF NOT
  EXISTS`, so running it when nothing changed is a no-op. Just always run it.
- **Vite env vars are build-time.** If you ever change `VITE_GOOGLE_CLIENT_ID`
  (or add new `VITE_*` vars), you MUST rebuild the frontend (`--no-cache`) —
  restarting the container alone won't pick the change up.
- **No client-side caching means no stale bundles** — every navigation
  re-downloads the (small) JS bundle, so a hard refresh after deploy is
  unnecessary in practice. Your session in `localStorage` survives across
  reloads, deploys, and container rebuilds; you stay signed in.
- **Restart just the worker** if you change `SYNC_INTERVAL_MINUTES`. The
  worker sweeps and re-registers BullMQ schedules at startup, so a
  `docker compose up -d worker` is enough; backend and frontend can stay up.

---

## Troubleshooting

### "Google Sign-In is not configured" on the auth screen

`VITE_GOOGLE_CLIENT_ID` isn't reaching the frontend bundle. Vite reads env vars
**at build time** from build args — they must be passed through Docker. Confirm
both:
- `.env` has `VITE_GOOGLE_CLIENT_ID=...`
- `docker-compose.yml` frontend `args:` includes `VITE_GOOGLE_CLIENT_ID: ${VITE_GOOGLE_CLIENT_ID}`

Then rebuild without cache: `docker compose build --no-cache frontend`.

In browser DevTools console: `import.meta.env.VITE_GOOGLE_CLIENT_ID` should
return the full ID.

### "Plaid doesn't support connections between [bank] and Ledger"

The institution doesn't support every product you're requesting. This app uses
`optional_products: ["investments"]` so most banks should work. If you see this
error for a bank that should work, check the backend logs:
```bash
docker compose logs --tail=100 backend | grep -i plaid
```

### "Internal server error" after Google sign-in

Almost always: migrations haven't been run. `docker compose exec backend npm run migrate`.

Or: `GOOGLE_CLIENT_ID` is missing/wrong in the backend env. `docker compose exec backend printenv GOOGLE_CLIENT_ID`.

### Caddy: "Timeout during connect" on certificate issue

Port 80 isn't reachable from the public internet. Check:
- UFW: `sudo ufw status | grep 80`
- Cloud firewall (Linode/AWS): make sure inbound 80/443 are open from `0.0.0.0/0`

### Caddy: "Cannot negotiate ALPN protocol acme-tls/1"

Something is intercepting port 443 — usually Cloudflare proxy. Either turn off
the orange cloud in CF's DNS panel, or use the `disable_tlsalpn_challenge`
Caddyfile config shown above.

### Caddy: rate limit (HTTP 429)

Let's Encrypt allows 5 failed auths per hour per domain. Stop Caddy, fix the
underlying issue, wait until the retry-after time, then start it again. Use
their staging CA (`acme_ca https://acme-staging-v02.api.letsencrypt.org/directory`
inside `tls { ... }`) to test setup changes without burning real-cert attempts.

### Manual transactions don't update the account balance

Make sure the transaction is linked to an account (`Account` dropdown in the add
form). Plaid-linked accounts are never adjusted by manual entries — their balances
come from Plaid sync.

---

## Project structure

```
ledger/
├── Backend/
│   ├── src/
│   │   ├── server.js           # Fastify entry, security middleware
│   │   ├── worker.js           # BullMQ worker (Plaid syncs, email)
│   │   ├── migrate.js          # Schema bootstrap + ALTER migrations
│   │   ├── db.js               # mysql2 pool (prepared statements only)
│   │   ├── crypto.js           # AES-256-GCM encrypt/decrypt
│   │   ├── audit.js            # Audit log helper
│   │   ├── plaid-client.js     # Plaid SDK init
│   │   ├── plaid-webhook-verify.js
│   │   ├── queue.js            # BullMQ queue/job helpers
│   │   ├── sync.js             # Plaid sync orchestration
│   │   ├── mailer.js           # SMTP / Nodemailer
│   │   └── routes/             # Fastify route plugins
│   ├── Dockerfile
│   └── package.json
├── Frontend/
│   ├── src/
│   │   ├── App.jsx             # The whole UI (single-file by design)
│   │   ├── main.jsx
│   │   ├── index.css           # Tailwind + iOS PWA reset
│   │   ├── api/client.js       # Thin fetch wrapper
│   │   ├── hooks/useAuth.js
│   │   └── context/DateContext.jsx  # Global data store
│   ├── public/manifest.webmanifest  # PWA manifest
│   ├── index.html              # PWA meta tags + Google GIS script
│   ├── nginx.conf              # Security headers, CSP, caching
│   ├── Dockerfile
│   ├── tailwind.config.js
│   ├── vite.config.js
│   └── package.json
├── docker-compose.yml          # 5 services: mariadb, redis, backend, worker, frontend
├── bootstrap.sh                # First-time .env generator
├── .env.example                # Template — actual .env is git-ignored
└── README.md
```

---

## Environment variables

| Variable                  | Required | Notes                                                                |
| ------------------------- | -------- | -------------------------------------------------------------------- |
| `NODE_ENV`                | Yes      | `production` for live, anything else = dev (looser validation)        |
| `DB_NAME` / `DB_USER` / `DB_PASSWORD` / `DB_ROOT_PASSWORD` | Yes | MariaDB credentials |
| `JWT_SECRET`              | Yes      | 64-byte hex, signs auth tokens                                       |
| `ENCRYPTION_KEY`          | Yes      | 32-byte (64 hex chars), AES-256 for Plaid tokens + notes. **BACK UP** |
| `GOOGLE_CLIENT_ID`        | Yes      | Backend ID-token verification                                        |
| `VITE_GOOGLE_CLIENT_ID`   | Yes      | Frontend Google button (build-time, same value as above)             |
| `ALLOWED_EMAILS`          | Recommended | Comma-separated Gmail allowlist. Empty = anyone with a Google account can sign in |
| `PLAID_CLIENT_ID` / `PLAID_SECRET` / `PLAID_ENV` | Yes | Plaid keys; env is `sandbox` or `production`               |
| `PLAID_REDIRECT_URI`      | Production-only | OAuth return URL, must match Plaid dashboard exactly         |
| `PLAID_WEBHOOK_URL`       | Optional | Auto-sync push endpoint; verified by signature                       |
| `APP_URL` / `CORS_ORIGIN` | Yes      | Your full HTTPS URL; CORS won't start without it in production       |
| `SIGNUP_MODE`             | Optional | `closed` for single-user, `invite` to use the invitation system, `open` for anything-goes |
| `SYNC_INTERVAL_MINUTES`   | Optional | How often the worker polls Plaid for new transactions. Default 60. Webhook-driven syncs fire regardless. |
| `EMAIL_CONFIG`            | Optional | `disabled` (default) or `enabled`. Master kill-switch for outbound email. UI greys out email-notification settings when disabled. |
| `SMTP_*`                  | Optional | SMTP credentials, only consulted when `EMAIL_CONFIG=enabled`. Leave `SMTP_HOST` blank to log emails to console for testing. |

See `.env.example` for the full annotated template, or run `./bootstrap.sh` to
generate one with strong randoms.

---

## Contributing & forks

This is a single-tenant personal-finance app, not a SaaS — the assumption is
that each person runs their own copy. PRs and issues are welcome at
<https://github.com/JKJWL/Ledger>, but the project is intentionally scoped
small: drive-by feature requests that don't fit a one-person/one-household use
case may be politely declined.

If you fork it, all you need to update is your `.env` and your Caddyfile —
nothing in the source assumes a particular domain or owner.

---

## License

MIT — see `LICENSE` (or treat this as MIT if you fork before that file exists).

---

## Acknowledgements

- [Plaid](https://plaid.com) — bank integration
- [Fastify](https://fastify.dev) — HTTP framework
- [Caddy](https://caddyserver.com) — drop-in HTTPS reverse proxy
- [Tailwind](https://tailwindcss.com) + [Framer Motion](https://www.framer.com/motion/) + [Recharts](https://recharts.org) — UI
- [Google Identity Services](https://developers.google.com/identity/gsi/web/guides/overview) — passwordless SSO
