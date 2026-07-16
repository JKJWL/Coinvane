# Coinvane

> Self-hosted personal finance · React PWA · Plaid · Google SSO · zero-knowledge
> at-rest encryption · Docker Compose deploy
>
> Copyright © 2026 Jack Jewell and contributors ·
> Source: <https://github.com/JKJWL/Coinvane> ·
> License: **AGPL v3** (see [LICENSE](LICENSE), third-party acknowledgements
> in [NOTICE](NOTICE)) ·
> Security policy: [SECURITY.md](SECURITY.md)

A self-hosted personal-finance app for one person (or a small household).
Bank sync via Plaid, transactions stored encrypted on your own server,
mobile PWA you can install on your phone. AGPL, no telemetry, no ads.

### A note on the license

Coinvane is licensed under the **GNU Affero General Public License v3.0**.
That means:

- ✅ **Personal / household use**: do whatever you want with it. Run it,
  modify it, share it with friends.
- ✅ **Forking + modifying**: encouraged. Your fork is still AGPL.
- ⚠ **Running it as a paid service for other people** (SaaS,
  multi-tenant hosting, anything where someone pays to access *your*
  instance): the AGPL's network-use clause triggers, and you must
  release your modifications to the source code (including any private
  patches) under AGPL too. This is by design — the project is for
  individuals to self-host, not for corporations to repackage and resell.

If AGPL doesn't work for your use case (e.g. you want to fork commercially
without sharing your changes), please reach out and we can discuss.

### A note on security

This is a self-hosted app for personal use. **You are the operator of your
deployment**, which means *you* are responsible for keeping your VPS
patched, your SSH hardened, your firewall correct, and your secret keys
backed up off-server. The application ships with sensible security
defaults (allowlist-only sign-in, strict CSP, AES-256-GCM for tokens and
notes, no client-side caching, rate-limiting, prepared statements only,
etc.) but those defaults can only protect you if the layer underneath is
sound. Read [SECURITY.md](SECURITY.md) before you deploy.

To report a security vulnerability in the *code* (as opposed to your
specific deployment), please follow the process in [SECURITY.md](SECURITY.md)
— **do not** open a public GitHub issue.

---

## Features

### Accounts & transactions
- **Bank sync** — connect any institution Plaid supports (most US banks, brokerages, credit unions). Polls Plaid on a configurable interval (default every 60 min, editable from the in-app Admin panel without a redeploy), plus webhook-driven near-real-time updates when your bank pushes them.
- **Pending transactions** — when your bank reports a charge as pending, it shows up immediately with an amber "Pending" badge so you can tell authorized-but-not-yet-settled spending apart from posted activity.
- **Manual accounts** — for banks Plaid doesn't support; balances auto-adjust when you record transactions.
- **Transactions** — date-grouped activity feed with filter by account / category, sort options, tap-to-edit.
- **Cash / Credit split** — the Transactions tab has a Cash⇄Credit pill at the top. Defaults to Cash on every visit. Credit-card transactions never bleed into your income, cashflow, by-category, or budget totals; they're tallied only by the credit-usage tracker.
- **Per-merchant rules** — recategorise a transaction and choose "all future from this merchant"; the rule is saved per-user and applied to every subsequent sync.
- **Manual classification override** — flip an already-posted transaction between Income / Expense / Transfer when Plaid gets it wrong, without deleting and re-entering.
- **Split transactions** — carve one transaction into multiple category slices (e.g. a Costco run split across Groceries / Household / Fuel). Child rows inherit the merchant + date; the parent becomes a container.
- **Receipt attachments** — attach one image (PNG or JPG, ≤5MB) per transaction from the detail sheet, view or reprint later. Uploads are rate-limited (3 per transaction per 5 min, 50 per user per 30 min); a new upload replaces the old file to conserve disk. A pink image marker appears next to any transaction that has a receipt, and the transaction list has a **Has receipt** sort that groups them at the top.
- **CSV import / export** — full transaction roundtrip from the Settings → Data section. CSV columns: `date, merchant, category, amount, account, note, pending`. On import, accounts are matched by name; unknown names fall back to manual rows.

### Budgets
- **Master period** — one reset rhythm drives every budget AND the credit-usage tracker. Pick a cadence on the Income card (weekly, bi-weekly, semi-monthly, monthly, yearly, or every N days from a date) and "this week's groceries", "this week's income", and "this week's allocation total" all line up exactly. The "Weekly" option's reset day follows your global *Week starts on* setting (any day of the week, set in Settings → Appearance).
- **Two budget types** — category-based (default) or credit-card-account-based; credit-card transactions are excluded from category budgets to avoid double-counting (swipe + payment).
- **Drag to reorder** — touch and mouse both work; order persists across devices. A lock toggle prevents accidental drags on mobile.
- **Edit any budget** — amount editable after creation. Category and account are locked once a budget is created (use delete + recreate if you need to change either).
- **Budget history** — a date dropdown next to "+ New Budget" walks back through past periods (the last 12 by default). Each period shows what you actually budgeted vs spent AT THAT TIME — amount edits or deletions made later don't rewrite history. Backed by a `budget_audit` table that snapshots every create / update / delete event.
- **Suggested categories** — new-budget form suggests categories you spend on but haven't budgeted yet.
- **Income tracker** — pinned at top, no limit; sums positive transactions over the master period.
- **Credit usage tracker** — only appears when a credit account is linked; per-card breakdown, also master-period bound.
- **Zero-based-budget summary** — dual-color bar at the bottom showing income vs allocated, with "X left to budget" indicator.
- **Themed confirmations** — destructive actions (delete budget, etc.) prompt with an in-app modal, not the native browser dialog.

### Goals & loans
- **Savings goals** with target / progress
- **Contribute** button + quick-add chips for deposits or withdrawals (negative amounts clamp at $0)
- **Link to a bank account** — when linked, the goal's saved amount is the linked account's live balance, no manual contributions needed (and they're explicitly refused server-side to keep the source of truth single)
- **Loan tracker** — a second section under Goals for mortgages, auto loans, student loans, credit-card balances you're paying down. Principal, rate, term, minimum + optional extra payment. Interactive amortization with an extra-payment slider that recomputes payoff date and total interest live. Choose a **snowball** (smallest balance first) or **avalanche** (highest rate first) strategy across all your loans; the app highlights which one to attack next.
- **Themed delete confirmation** instead of the native browser dialog

### Bills
- **Recurring bill templates** — set a merchant, expected amount, cadence (weekly / bi-weekly / semi-monthly / monthly / yearly / every N days), and due day. Bills open a new cycle automatically and roll forward.
- **Auto-match on Plaid sync** — every incoming transaction is checked against your bill templates by merchant substring + amount band (±40%); a match auto-fills the current cycle as **paid** without you clicking anything.
- **Manual fallback** — mark paid / unpaid / skip on any cycle, edit variance, adjust the expected amount when your electric bill jumps for the summer.
- **Rolling 3-cycle nudge** — if your actual paid amount drifts from the template three cycles in a row, the UI suggests updating the template so future forecasts are accurate.
- **Variance tracking** — see how far each cycle came in over or under expected.

### Net worth & cashflow
- **Net Worth chart** with ALL / MTD / YTD / 1M / 3M / 1Y toggle (defaults to ALL — mobile gradient hero + desktop full chart)
- **Spending pulse** — compact monthly category breakdown card
- **Cashflow forecast** — dashed extension on the monthly cashflow chart projecting the next few months from recurring income + bill templates. Toggle it on/off with the Sparkles button (preference persists across devices); overlay a one-off adjustment (e.g. "expecting a $1,200 refund next month") without creating a real transaction.
- **Desktop KPI fullscreen** — click any of the three KPI cards (Cashflow / Spending by Category / Net Worth) on desktop to center-fullscreen it. Spending by Category card has its own filters + sort options matching the Net Worth chart.

### Investments
- **Holdings, gains/losses** — brokerage syncing via Plaid

### Notifications & per-user settings
- **Per-type toggles** — large transactions, income received ("Congrats You Got Paid!"), approaching budget limit, budget exceeded, goal milestones. Each independently on/offable.
- **Configurable thresholds** — large-transaction $ amount, income $ amount, and budget-warning percentage are all editable in Settings.
- **Email frequency** — instant / daily / weekly (with a weekly send-day picker). Daily and instant are functionally identical until the engine runs more than once a day.
- **Privacy mode** — blurs dollar amounts on the dominant surfaces (hero net worth, KPI cards, account balances, transaction amounts). Hover/focus reveals.
- **Sticky save bar** — Settings and the Admin panel share one save UX: a sticky top bar appears only when something is dirty, plus a floating "Save Changes?" ribbon on the right edge once you've scrolled past it.

### Admin (Owner / Admin roles)
- **Owner** — the first sign-up. Single per instance. Only role that can edit the Plaid sync interval, edit the email allowlist, promote/demote admins, delete admins, and send sample emails.
- **Admin** — can view the admin page and run two destructive actions: removing members and clearing old notifications. Both are audit-logged as "major" events.
- **Members section** with per-row role dropdown (Member ⇄ Admin, owner-only). Promotions are staged locally and require Save + a confirmation dialog before they hit the database.
- **Allowlist editor** — DB-backed, edits live without restarting the backend. Falls back to the `ALLOWED_EMAILS` env on a fresh deploy.
- **App info card** — Plaid environment, email status, SMTP host, signup mode, row counts.
- **Notification cleanup** — bulk-delete in-app notifications older than N days. Audit-logged as a major event.
- **Audit log viewer** — last 100 entries with IP + offline GeoIP location. Routine entries auto-prune at 48 h; major entries (role changes, user deletes, bulk wipes, settings edits) survive 7 days and render with a red left border.
- **Per-user test email** — owner-only Mail icon next to each Members row sends a sample digest (with a "this is a test" banner) to verify SMTP delivery to that user without logging in as them.

### Misc
- **Notes** — free-form notes, content encrypted at rest
- **Mobile PWA** — install to iPhone home screen, full-screen, frosted iOS-style nav, Dynamic Island safe
- **Multi-device** — dark mode, theme, and every per-user setting follow you across devices
- **Google SSO** — no passwords stored; locked to an email allowlist so only you can sign in
- **PDF report dropdown** — Settings → Data → *Export report (PDF)* opens a menu with 5 branded reports, all server-side rendered (no headless browser):
  1. **Full report** — cover + summary + accounts + budgets + goals + last 500 transactions + decrypted notes
  2. **Monthly** — single-month income / expense / cashflow / category breakdown
  3. **Category YoY** — year-over-year per-category comparison
  4. **Budgets** — every budget + spend history for the current and past periods
  5. **Bills & Loans** — recurring bill cycles + loan amortization progress

---

## Stack

| Layer       | Tech                                                   |
| ----------- | ------------------------------------------------------ |
| Backend     | Node.js 20, Fastify 5, MariaDB 11, BullMQ + Redis, Plaid SDK v27, Nodemailer 8, `@fastify/multipart` for receipt uploads |
| Frontend    | React 18, Vite 6, Tailwind 3, Framer Motion 11, Recharts 2 |
| Server-side rendering | pdfkit (PDF export), papaparse (CSV import), geoip-lite (offline IP→location for audit log) |
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
git clone https://github.com/JKJWL/Coinvane.git coinvane
cd coinvane
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
automatically becomes the **owner** of the instance — single-owner pattern, no UI
to transfer (manual `UPDATE users SET role='owner'` if you ever need to).

---

## Production deployment (Linode / any Ubuntu VPS)

This guide assumes Ubuntu 24.04 LTS. Adapt as needed for other distros.

### 1. Server prep

Pick a non-root username — anything **other than** `coinvane`, `admin`, `ubuntu`,
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
coinvane.your-domain.com {
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
git clone https://github.com/JKJWL/Coinvane.git coinvane
cd coinvane
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
sudo nano /etc/cron.daily/coinvane-backup
```

```bash
#!/bin/bash
set -e
# Adjust these two paths to match your install.
APP_DIR=/home/<your-user>/coinvane
BACKUP_DIR=/home/<your-user>/backups
KEY_FILE=/home/<your-user>/.backup-key

mkdir -p "$BACKUP_DIR"
TS=$(date +%Y%m%d-%H%M%S)
source "$APP_DIR/.env"
docker exec coinvane-db mysqldump -uroot -p"$DB_ROOT_PASSWORD" --all-databases \
  | gzip \
  | openssl enc -aes-256-cbc -salt -pbkdf2 -pass file:"$KEY_FILE" \
  > "$BACKUP_DIR/coinvane-$TS.sql.gz.enc"
find "$BACKUP_DIR" -name "coinvane-*.sql.gz.enc" -mtime +14 -delete
```

```bash
sudo chmod +x /etc/cron.daily/coinvane-backup
openssl rand -hex 32 | sudo tee /home/<your-user>/.backup-key
sudo chmod 400 /home/<your-user>/.backup-key
```

Keep a copy of `.backup-key` off-server (password manager, encrypted USB,
etc.). Periodically rsync the backup directory to another host or to S3. To
restore:
```bash
openssl enc -d -aes-256-cbc -pbkdf2 -pass file:.backup-key \
  -in coinvane-YYYYMMDD-HHMMSS.sql.gz.enc | gunzip | mysql -uroot -p
```

---

## Google Cloud OAuth setup

1. **Create a project**: https://console.cloud.google.com → "Select a project" → "New Project" → name it `Coinvane`.

2. **Configure consent screen**: APIs & Services → OAuth consent screen
   - User type: **External** (Internal only if you have Workspace)
   - App name: `Coinvane`
   - User support email, developer contact: your email
   - Skip scopes (OpenID/email/profile included by default)
   - Add your Gmail under **Test users** (so you can sign in before publishing)

3. **Create OAuth Client ID**: APIs & Services → Credentials → Create Credentials → OAuth client ID
   - Application type: **Web application**
   - Name: `Coinvane Web`
   - **Authorized JavaScript origins**:
     - `http://localhost:8080` (for local dev)
     - `https://coinvane.your-domain.com` (for production)
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

5. **Webhooks** (optional, for auto-sync push): set `PLAID_WEBHOOK_URL=https://coinvane.your-domain.com/api/plaid/webhook` in `.env`. The endpoint is public but signature-verified by Plaid — safe to expose.

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

- **Email allowlist** — only Google accounts on the list can sign in; anyone else gets 403 regardless of whether Google would otherwise let them through. Live-editable from the Admin panel (DB-backed in `app_settings.allowed_emails`); falls back to the `ALLOWED_EMAILS` env on fresh deploys.
- **Three-tier role model** — Owner / Admin / Member. Owner is exclusive per instance and the only role that can edit cross-cutting config (sync interval, allowlist, role promotions, sample emails). Admins are scoped to two destructive actions (delete members, clear notifications), both audit-logged as major.
- **Rate limiting** — 200 req/min global, 10 req/min on `/api/auth/google`, 60 req/min on every admin route, 300 req/min on the public `/api/plaid/webhook`, plus explicit per-route caps on the filesystem-touching receipt endpoints (60/120/60 req/min for upload / view / delete).
- **Helmet** — HSTS, X-Frame-Options DENY, strict Referrer-Policy, no `X-Powered-By`.
- **Strict CORS** — refuses to start in production if `CORS_ORIGIN` isn't set.
- **JWT 30-day expiration** — sessions auto-expire; sign back in with one Google click. Role changes require a re-login to take effect (JWTs aren't auto-refreshed).
- **Encryption at rest** — Plaid access tokens and note content encrypted with AES-256-GCM.
- **Prepared statements** — every DB query uses parameterized `?` placeholders; no string concatenation, no SQL injection surface.
- **Error masking** — production 5xx responses return a generic message; stack traces stay in logs.
- **Tiered audit log** — every sign-in (success and failure) recorded with IP, user-agent, and offline GeoIP location. Routine entries prune at 48 h; major entries (role changes, user deletes, settings edits, bulk notification wipes) survive 7 days.
- **Body limit** — 512 KB on JSON, 5 MB on the CSV import route + receipt-upload route only. Receipt uploads are additionally mime-whitelisted to PNG/JPG at the route handler.
- **CSP** — nginx serves a strict Content-Security-Policy locking script sources
  to self, Google, and Plaid.
- **No client-side caching** — every response (HTML, JS, CSS, API, images) is
  served with `Cache-Control: no-store, no-cache, must-revalidate`. Cost is a
  tiny per-page-load bandwidth hit on a single-file React app; benefit is that
  security fixes and bug fixes propagate to every user the instant they
  navigate, with zero chance of a stale bundle masking a deployed fix. The
  login session lives in `localStorage` (not the HTTP cache), so you stay
  signed in despite the no-cache policy.

### Operator responsibilities

This app ships with strong defaults but you, the self-hoster, are the system
administrator. Reading [SECURITY.md](SECURITY.md) is recommended before you
deploy. Short version:

- Generate **fresh** secrets per environment — don't reuse dev secrets in production
- Back up `ENCRYPTION_KEY` and `.backup-key` off-server (lose either and data is gone)
- Restrict SSH to your home IP in the cloud firewall once everything works
- Enable disk encryption at the VPS level (Linode supports this at provisioning time)
- Keep the OS patched (`unattended-upgrades` covers most of it)
- Review the [SECURITY.md](SECURITY.md) scope before reporting an issue,
  and report code-level vulnerabilities **privately**, never on a public issue.

---

## Updating

Standard upgrade flow after `git pull`:

```bash
cd ~/coinvane
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
- **Renaming your checkout directory changes Docker's volume prefix.** Docker
  Compose names volumes `<foldername>_<volume>` — so if your git clone lives
  in `~/coinvane/` your volumes are `coinvane_mariadb_data` etc., but if you
  cloned into `~/ledger/` back before the rename they'd be `ledger_*`.
  Renaming the folder makes the app come up with an empty database because
  the new prefix "finds no volumes." Either keep the folder name stable,
  set `COMPOSE_PROJECT_NAME=ledger` in `.env` to pin the old prefix, or
  manually rename the volumes with `docker volume create` + `docker run
  rsync` before switching.
- **Restart just the worker** if you change `SYNC_INTERVAL_MINUTES` via env, or
  if you've updated the in-app sync-interval value from the Admin panel. The
  worker sweeps and re-registers BullMQ schedules at startup, so a
  `docker compose up -d worker` is enough; backend and frontend can stay up.
- **Allowlist + sync interval edits in the Admin panel** don't need a restart
  for the **next** request to see them — but the BullMQ schedule is only
  re-read at worker boot, so changing the sync interval still requires
  `docker compose up -d worker` to take effect.
- **Role changes require a re-login.** JWTs are stamped with the role at
  sign-in and aren't auto-refreshed. Promoting/demoting a signed-in user
  needs them to log out + back in to see the change.

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

### "Plaid doesn't support connections between [bank] and Coinvane"

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
coinvane/
├── Backend/
│   ├── src/
│   │   ├── server.js              # Fastify entry, security middleware
│   │   ├── worker.js              # BullMQ worker (Plaid syncs, email, audit cleanup)
│   │   ├── migrate.js             # Schema bootstrap + ALTER migrations + owner backfill
│   │   ├── db.js                  # mysql2 pool (prepared statements only)
│   │   ├── crypto.js              # AES-256-GCM encrypt/decrypt
│   │   ├── audit.js               # Audit log helper + offline GeoIP (geoip-lite)
│   │   ├── app-settings.js        # DB-backed app config (allowlist, sync interval) with env fallback
│   │   ├── budget-utils.js        # Master-period math, budget audit helpers
│   │   ├── notification-engine.js # Daily notification generator + email digest dispatch
│   │   ├── plaid-client.js        # Plaid SDK init
│   │   ├── plaid-webhook-verify.js
│   │   ├── queue.js               # BullMQ queue/job helpers
│   │   ├── sync.js                # Plaid sync orchestration
│   │   ├── mailer.js              # SMTP / Nodemailer + notification-digest template
│   │   └── routes/
│   │       ├── auth.js            # Google SSO, /me, members, role updates, test-email
│   │       ├── accounts.js
│   │       ├── transactions.js    # Plus CSV import/export, merchant rules
│   │       ├── budgets.js
│   │       ├── goals.js
│   │       ├── notes.js
│   │       ├── categories.js
│   │       ├── notifications.js
│   │       ├── investments.js
│   │       ├── plaid.js
│   │       ├── admin.js           # Owner/admin admin-panel surface (info, sync-interval, allowlist, audit, cleanup)
│   │       └── export.js          # PDF full-export (pdfkit, server-side, no headless browser)
│   ├── Dockerfile
│   └── package.json
├── Frontend/
│   ├── src/
│   │   ├── App.jsx             # The whole UI (single-file by design)
│   │   ├── main.jsx
│   │   ├── index.css           # Tailwind + iOS PWA reset + privacy-mode blur rule
│   │   ├── api/client.js       # Thin fetch wrapper + authed file-download helper
│   │   ├── hooks/useAuth.js
│   │   └── context/DateContext.jsx  # Global data store
│   ├── public/favicon.svg      # Single source of truth for every PWA icon
│   ├── public/manifest.webmanifest
│   ├── scripts/generate-icons.mjs   # `prebuild` step: SVG → 4 PNG icons via sharp
│   ├── index.html              # PWA meta tags + Google GIS script
│   ├── nginx.conf              # Routing, gzip, expires
│   ├── nginx-headers.conf      # Shared snippet: cache + security headers (works around add_header inheritance footgun)
│   ├── Dockerfile
│   ├── tailwind.config.js
│   ├── vite.config.js
│   └── package.json
├── docker-compose.yml          # 5 services + 3 named volumes (mariadb_data, redis_data, attachments_data)
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
| `ALLOWED_EMAILS`          | Recommended | Comma-separated Gmail allowlist used until the owner edits it in the Admin panel; after that the DB-backed allowlist takes over. Empty = anyone with a Google account can sign in. |
| `PLAID_CLIENT_ID` / `PLAID_SECRET` / `PLAID_ENV` | Yes | Plaid keys; env is `sandbox` or `production`               |
| `PLAID_REDIRECT_URI`      | Production-only | OAuth return URL, must match Plaid dashboard exactly         |
| `PLAID_WEBHOOK_URL`       | Optional | Auto-sync push endpoint; verified by signature                       |
| `APP_URL` / `CORS_ORIGIN` | Yes      | Your full HTTPS URL; CORS won't start without it in production. `APP_URL` is also used as the "Open Coinvane" link target in notification emails. |
| `SIGNUP_MODE`             | Optional | `open` (default) — any allowlisted Google account can sign up. `closed` — no new users; existing users may still sign in. Use `closed` after your household roster is finalised to harden the deployment. |
| `SYNC_INTERVAL_MINUTES`   | Optional | Initial polling cadence for Plaid; default 60. Owners can override this live from the Admin panel (the DB value wins). Webhook-driven syncs fire regardless. |
| `EMAIL_CONFIG`            | Optional | `disabled` (default) or `enabled`. Master kill-switch for outbound email. UI greys out email-notification settings when disabled. |
| `SMTP_*`                  | Optional | SMTP credentials, only consulted when `EMAIL_CONFIG=enabled`. Leave `SMTP_HOST` blank to log emails to console for testing. |

See `.env.example` for the full annotated template, or run `./bootstrap.sh` to
generate one with strong randoms.

---

## Contributing & forks

This is a single-tenant personal-finance app, not a SaaS — the assumption is
that each person runs their own copy. PRs and issues are welcome at
<https://github.com/JKJWL/Coinvane>, but the project is intentionally scoped
small: drive-by feature requests that don't fit a one-person/one-household use
case may be politely declined.

If you fork it, all you need to update is your `.env` and your Caddyfile —
nothing in the source assumes a particular domain or owner.

---

## License

Licensed under the **GNU Affero General Public License v3.0** — see
[LICENSE](LICENSE) for the full text.

The short version of what this means for you:

- **Self-hosting for yourself or your household**: do whatever you want.
  Modify, fork, share with friends. The license is permissive for end users.
- **Forking and shipping your own version**: encouraged. Your fork must
  also be AGPL.
- **Running it as a hosted service that other people pay to access**:
  the AGPL's network-use clause (Section 13) triggers. You must publish
  the *complete* corresponding source code of your modified version,
  including any private patches, under AGPL — and you must make it
  easy for users of your service to download it.

This is intentionally chosen as a strong-copyleft license to keep the
project free and prevent commercial repackaging without contributing
back. If you have a use case that AGPL genuinely doesn't fit, open a
discussion at the GitHub repo and we can talk.

### Why AGPL specifically

AGPL is OSI-approved and accepted by every major Linux distribution,
unlike newer "source-available" licenses (SSPL, BUSL, Elastic v2,
Commons Clause) which are not. It's the strongest copyleft license you
can use while remaining unambiguously open source. Major projects in the
same space — Mastodon, Bitwarden, Nextcloud, Plausible — use AGPL for
the same reasons.

---

## Acknowledgements

- [Plaid](https://plaid.com) — bank integration
- [Fastify](https://fastify.dev) — HTTP framework
- [Caddy](https://caddyserver.com) — drop-in HTTPS reverse proxy
- [Tailwind](https://tailwindcss.com) + [Framer Motion](https://www.framer.com/motion/) + [Recharts](https://recharts.org) — UI
- [Google Identity Services](https://developers.google.com/identity/gsi/web/guides/overview) — passwordless SSO
