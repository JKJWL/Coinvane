# Coinvane

> Self-hosted personal finance · React PWA · optional Plaid bank sync ·
> pick-your-own sign-in (Google / Microsoft / passwordless email) ·
> zero-knowledge at-rest encryption · Docker Compose deploy
>
> Copyright © 2026 Jack Jewell and contributors ·
> Source: <https://github.com/JKJWL/Coinvane> ·
> License: **AGPL v3** (see [LICENSE](LICENSE), third-party acknowledgements
> in [NOTICE](NOTICE)) ·
> Security policy: [SECURITY.md](SECURITY.md)

A self-hosted personal-finance app for one person (or a small household).
Optional bank sync via Plaid (skip it for a fully manual-only setup),
transactions stored encrypted on your own server, mobile PWA you can
install on your phone. AGPL, no telemetry, no ads.

**Everything external is optional.** Pick any combination of sign-in
methods (Google, Microsoft, one-time email link — at least one required),
turn Plaid on or off, turn email on or off, turn Web Push on or off.
`bootstrap.sh` asks about each individually and writes an `.env` matching
your choices.

---

## Table of contents

- [A note on the license](#a-note-on-the-license)
- [A note on security](#a-note-on-security)
- [Features](#features)
  - [Accounts & transactions](#accounts--transactions)
  - [Budgets](#budgets)
  - [Goals & loans](#goals--loans)
  - [Bills](#bills)
  - [Net worth & cashflow](#net-worth--cashflow)
  - [Investments](#investments)
  - [Notifications & per-user settings](#notifications--per-user-settings)
  - [Admin (Owner / Admin roles)](#admin-owner--admin-roles)
  - [Assets & valuables](#assets--valuables)
  - [Tax reporting](#tax-reporting)
  - [Custom reports](#custom-reports)
  - [Categories & groups](#categories--groups)
  - [Split templates](#split-templates)
  - [Microsoft Money import](#microsoft-money-import)
  - [Web Push notifications](#web-push-notifications)
  - [Sign-in methods](#sign-in-methods)
    - [Google SSO (optional)](#google-sso-optional)
    - [Microsoft SSO (optional)](#microsoft-sso-optional)
    - [Sign in with a one-time link (optional)](#sign-in-with-a-one-time-link-optional)
  - [.cvn backup format](#cvn-backup-format)
  - [Biometric app-lock](#biometric-app-lock)
  - [Misc](#misc)
- [Stack](#stack)
- [Quick start (local development)](#quick-start-local-development)
  - [Prerequisites](#prerequisites)
  - [1. Clone and bootstrap](#1-clone-and-bootstrap)
  - [2. Build and start](#2-build-and-start)
  - [3. Run database migrations](#3-run-database-migrations)
  - [4. Sign in](#4-sign-in)
- [Production deployment (Linode / any Ubuntu VPS)](#production-deployment-linode--any-ubuntu-vps)
  - [1. Server prep](#1-server-prep)
  - [2. Lock down SSH](#2-lock-down-ssh)
  - [3. Firewall](#3-firewall)
  - [4. fail2ban + auto-updates](#4-fail2ban--auto-updates)
  - [5. Docker](#5-docker)
  - [6. Caddy reverse proxy with auto-HTTPS](#6-caddy-reverse-proxy-with-auto-https)
  - [7. Clone and deploy the app](#7-clone-and-deploy-the-app)
  - [8. Encrypted nightly backups](#8-encrypted-nightly-backups)
- [Google Cloud OAuth setup](#google-cloud-oauth-setup)
- [Plaid setup](#plaid-setup)
  - [Which Plaid products](#which-plaid-products)
- [Connecting non-Plaid banks](#connecting-non-plaid-banks)
- [Security](#security)
  - [Operator responsibilities](#operator-responsibilities)
- [Updating](#updating)
- [Troubleshooting](#troubleshooting)
  - [The Google Sign-In button doesn't appear on the login page](#the-google-sign-in-button-doesnt-appear-on-the-login-page)
  - [Microsoft sign-in AADSTS70002 (client_secret required)](#microsoft-sign-in-errors-with-aadsts70002-the-provided-request-must-include-a-client_secret)
  - [Microsoft sign-in AADSTS50011 (redirect URI mismatch)](#microsoft-sign-in-errors-with-aadsts50011-redirect-uri-mismatch)
  - [Microsoft sign-in 401 "no email"](#microsoft-sign-in-returns-401-microsoft-account-has-no-email)
  - [Microsoft sign-in 403 (tenant policy)](#microsoft-sign-in-returns-403-this-instance-only-accepts-personal-microsoft-accounts-or-similar)
  - [Microsoft sign-in silently fails](#microsoft-sign-in-silently-fails--popup-closes-with-no-error-or-apiauthmicrosoft-never-fires-in-the-network-tab)
  - [One-time-link "same network" error](#this-link-must-be-opened-on-the-same-network-it-was-requested-from-one-time-link)
  - [Plaid unsupported connection](#plaid-doesnt-support-connections-between-bank-and-coinvane)
  - [Internal server error after sign-in](#internal-server-error-after-sign-in)
  - [Caddy: timeout on cert issue](#caddy-timeout-during-connect-on-certificate-issue)
  - [Caddy: ALPN negotiation failure](#caddy-cannot-negotiate-alpn-protocol-acme-tls1)
  - [Caddy: Let's Encrypt rate limit](#caddy-rate-limit-http-429)
  - [Manual balance not updating](#manual-transactions-dont-update-the-account-balance)
- [Project structure](#project-structure)
- [Environment variables](#environment-variables)
- [Contributing & forks](#contributing--forks)
- [License](#license)
  - [Why AGPL specifically](#why-agpl-specifically)
- [Acknowledgements](#acknowledgements)

---

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
- **Bank sync (optional)** — connect any institution Plaid supports (most US banks, brokerages, credit unions). Polls Plaid on a configurable interval (default every 60 min, editable from the in-app Admin panel without a redeploy), plus webhook-driven near-real-time updates when your bank pushes them. **Or skip Plaid entirely** (`PLAID_ENABLED=false`, or leave the credentials blank) to run Coinvane as a manual-only budgeting app — the frontend hides every Plaid affordance, the backend 404s every Plaid route, and the worker skips periodic syncs. You still get manual entry, CSV/QIF/OFX/QFX/.mny import, and `.cvn` restore for a full experience with zero external service dependency.
- **Pending transactions** — when your bank reports a charge as pending, it shows up immediately with an amber "Pending" badge so you can tell authorized-but-not-yet-settled spending apart from posted activity.
- **Manual accounts** — for banks Plaid doesn't support; balances auto-adjust when you record transactions.
- **Transactions** — date-grouped activity feed with filter by account / category, sort options, tap-to-edit.
- **Cash / Credit split** — the Transactions tab has a Cash⇄Credit pill at the top. Defaults to Cash on every visit. Credit-card transactions never bleed into your income, cashflow, by-category, or budget totals; they're tallied only by the credit-usage tracker.
- **Per-merchant rules** — recategorise a transaction and choose "all future from this merchant"; the rule is saved per-user and applied to every subsequent sync.
- **Manual classification override** — flip an already-posted transaction between Income / Expense / Transfer when Plaid gets it wrong, without deleting and re-entering.
- **Split transactions** — carve one transaction into multiple category slices (e.g. a Costco run split across Groceries / Household / Fuel). Child rows inherit the merchant + date; the parent becomes a container.
- **Receipt attachments** — attach one image (PNG or JPG, ≤5MB) per transaction from the detail sheet, view or reprint later. Uploads are rate-limited (3 per transaction per 5 min, 50 per user per 30 min); a new upload replaces the old file to conserve disk. A pink image marker appears next to any transaction that has a receipt, and the transaction list has a **Has receipt** sort that groups them at the top.
- **Reconciliation** — Quicken-style statement match on any cash or credit account. Enter the statement date + ending balance, tick off transactions until the running difference hits zero, then finalize to lock the pass. Reconciled transactions are frozen with a `reconciliation_id` so a later pass can't re-tick them.
- **Running balance** — when the transaction list is filtered to a single account, each row shows the post-transaction balance underneath the amount. Quicken-parity register view.
- **Check numbers** — dedicated `Chk#` field on manual entry, surfaced next to every row it's set on. Imported QIF `N` codes populate it automatically.
- **Flag colours + saved views** — 7-colour flag palette on any transaction (review, dispute, tax follow-up, whatever) with matching filter chips. Save your current filter/sort/flag/clearing combo as a named view and re-apply it in one click.
- **Void transactions** — a state distinct from delete. Voided rows stay visible with a strikethrough but drop out of budgets, cashflow, by-category, net-worth, tax summary, reports, and notifications. Reversible with one click.
- **Payee memorization** — on the manual-entry form, tabbing out of the merchant field prefills the category and account based on your most recent matching transaction. Silent if you've already picked something different.
- **Merchant display renames** — rename a raw merchant string ("SQ *ACME COFFEE") everywhere it appears without affecting categorization. Merchant rules remain the source of truth for how transactions get categorized.
- **Global keyboard shortcuts (desktop)** — `n` jumps to Transactions and opens the new-txn sheet, `/` focuses search, `[` / `]` shift months on the dashboard KPIs. Ignored while typing in a form field.
- **CSV import / export** — full transaction roundtrip from the Settings → Data section. CSV columns: `date, merchant, category, amount, account, note, pending`. On import, accounts are matched by name; unknown names fall back to manual rows.
- **QIF / OFX / QFX / MNY import** — migration path for Quicken, Microsoft Money, Mint, or any bank export in one of these formats. Auto-detects the format from the file, binds every imported row to a chosen account, and shifts the manual balance to match. Suspected duplicates against existing rows in the target account (±3 days, same amount) are skipped by default with a prompt to import them anyway. See [Microsoft Money import](#microsoft-money-import) for the native `.mny` path.

### Budgets
- **Master period** — one reset rhythm drives every budget AND the credit-usage tracker. Pick a cadence on the Income card (weekly, bi-weekly, semi-monthly, monthly, yearly, or every N days from a date) and "this week's groceries", "this week's income", and "this week's allocation total" all line up exactly. The "Weekly" option's reset day follows your global *Week starts on* setting (any day of the week, set in Settings → Appearance).
- **Two budget types** — category-based (default) or credit-card-account-based; credit-card transactions are excluded from category budgets to avoid double-counting (swipe + payment).
- **Drag to reorder** — touch and mouse both work; order persists across devices. A lock toggle prevents accidental drags on mobile.
- **Edit any budget** — amount editable after creation. Category and account are locked once a budget is created (use delete + recreate if you need to change either).
- **Budget history** — a date dropdown next to "+ New Budget" walks back through past periods (the last 12 by default). Each period shows what you actually budgeted vs spent AT THAT TIME — amount edits or deletions made later don't rewrite history. Backed by a `budget_audit` table that snapshots every create / update / delete event.
- **Suggested categories** — new-budget form suggests categories you spend on but haven't budgeted yet.
- **Income tracker** — pinned at top, no limit; sums positive transactions over the master period.
- **Credit usage tracker** — only appears when a credit account is linked; per-card breakdown, also master-period bound.
- **Zero-based-budget summary** — three stacked bars at the bottom: current-income allocation, expected-income allocation (when scheduled), and actual budget usage (spent ÷ basis). "X left to budget" indicator; goes rose only when you've over-allocated.
- **Expected income + recurring paychecks** — flag any scheduled income transaction as "Budget Expected Income" and it feeds a second bar in the budgets tab. Scheduled income can also loop on a cadence (weekly / bi-weekly / semi-monthly / monthly / yearly / every N days); loops keep the next ~3 months of occurrences populated automatically so cashflow projections stay accurate. The zero-based slider bases itself on expected income when scheduled, otherwise falls back to current income.
- **Transaction type rules** — same "apply to all from this merchant" pattern as category rules, but for the income/expense/transfer classification. Fixes merchants Plaid consistently mis-tags (e.g. an ATM cashback that keeps coming back as TRANSFER_OUT).
- **Themed confirmations** — destructive actions (delete budget, etc.) prompt with an in-app modal, not the native browser dialog.

### Goals & loans
- **Savings goals** with target / progress
- **Contribute** button + quick-add chips for deposits or withdrawals (negative amounts clamp at $0)
- **Link to a bank account** — when linked, the goal's saved amount is the linked account's live balance, no manual contributions needed (and they're explicitly refused server-side to keep the source of truth single)
- **Loan tracker** — a second section under Goals for mortgages, auto loans, student loans, credit-card balances you're paying down. Principal, rate, term, minimum + optional extra payment. Interactive amortization with an extra-payment slider that recomputes payoff date and total interest live.
- **Mortgage escrow breakdown (PITI)** — separate monthly amounts for property tax, homeowners insurance, PMI, and other escrow. Loan cards render a proportional stacked bar and full PITI monthly total when any escrow is set.
- **Unified debt simulator** — one extra $/mo slider applied across every active loan, with snowball-style cascading of each cleared debt's minimum onto the current target. Toggle Avalanche vs Snowball to see the target flip and the "months / interest saved" headline update live. If any debt's minimum doesn't cover its interest, the simulator surfaces a rose banner instead of running to the 60-year cap.
- **Amortization PDF per loan** — every loan card exposes an "Amort PDF" button that downloads a month-by-month schedule with interest / principal / escrow / balance columns. Includes a full-payment summary line (total interest, months to payoff) at the top.
- **Themed delete confirmation** instead of the native browser dialog

### Bills
- **Recurring bill templates** — set a merchant, expected amount, cadence (weekly / bi-weekly / semi-monthly / monthly / yearly / every N days), and due day. Bills open a new cycle automatically and roll forward.
- **Auto-match on Plaid sync** — every incoming transaction is checked against your bill templates by merchant substring + amount band (±40%); a match auto-fills the current cycle as **paid** without you clicking anything.
- **Manual fallback** — mark paid / unpaid / skip on any cycle, edit variance, adjust the expected amount when your electric bill jumps for the summer.
- **Rolling 3-cycle nudge** — if your actual paid amount drifts from the template three cycles in a row, the UI suggests updating the template so future forecasts are accurate.
- **Variance tracking** — see how far each cycle came in over or under expected.
- **Due-date reminders** — every open bill cycle with a due date within your configured N-day window (default 3) fires an in-app notification. Toggle + threshold in Settings → Notifications.

### Net worth & cashflow
- **Net Worth chart** with ALL / MTD / YTD / 1M / 3M / 1Y toggle (defaults to ALL — mobile gradient hero + desktop full chart)
- **Spending pulse** — compact monthly category breakdown card
- **Cashflow forecast** — dashed extension on the monthly cashflow chart projecting the next few months from recurring income + bill templates. Toggle it on/off with the Sparkles button (preference persists across devices); overlay a one-off adjustment (e.g. "expecting a $1,200 refund next month") without creating a real transaction.
- **Cashflow low-balance alert** — daily projection over the next 30 days summing scheduled transactions + open bill outflows against your non-credit-account balance. Fires a notification if the projected low point dips below your configured minimum. Configurable in Settings → Notifications.
- **Desktop KPI fullscreen** — click any of the three KPI cards (Cashflow / Spending by Category / Net Worth) on desktop to center-fullscreen it. Spending by Category card has its own filters + sort options matching the Net Worth chart.

### Investments
- **Holdings, gains/losses** — brokerage syncing via Plaid. Cost-basis handling is Plaid-source-agnostic: NULL basis rows fall back to open-lot basis, and Plaid's inconsistent per-share vs total semantics (Fidelity et al) are normalized at read time so gain/loss doesn't misread by an order of magnitude.
- **Lot tracking + cost basis** — each holding is expandable into per-purchase lots (acquired date, quantity, cost-per-share). Sell any lot with a quantity + price; the app records the realized gain, decrements the lot, and flags **wash sales** when the same security was purchased within ±30 days of the loss. Disallowed loss is proportional to the overlapping share count (sell 100 at a loss, buy back 60 → 60% disallowed, not all of it). Realized + disallowed YTD are exposed on their own KPI card for Schedule D prep.
- **Manual lots roll into the portfolio summary** — pure-manual portfolios (no Plaid brokerage) still track total value + gain via the same UI.
- **Fresh-purchase phantom loss fixed** — buying at a price the security hasn't yet reported a fresh close for shows "—" instead of a spurious loss equal to the whole basis.
- **Dividend + interest auto-categorization** — Plaid's `INCOME_DIVIDENDS` / `INCOME_INTEREST_EARNED` categories (plus merchant patterns like `dividend`, `intrst`, `coupon`) are recognized during sync and labelled **Interest & Dividends**. Coinvane ensures a matching Schedule B category exists on your account so the year-end tax PDF picks it up automatically.

### Notifications & per-user settings
- **Per-type toggles** — large transactions, income received ("Congrats You Got Paid!"), approaching budget limit, budget exceeded, goal milestones, bill reminders, cashflow low-balance, overall budget usage %. Each independently on/offable.
- **Configurable thresholds** — large-transaction $ amount, income $ amount, budget-warning percentage, bill-reminder days-before, cashflow minimum-balance, budget-usage % are all editable in Settings.
- **Email frequency** — instant / daily / weekly (with a weekly send-day picker). Daily and instant are functionally identical until the engine runs more than once a day.
- **Web Push (OS-level notifications)** — real lock-screen / notification-tray alerts on desktop, Android, and iOS PWAs. Enable per-device from Settings; per-device revoke via the "Enrolled devices" list. Push is **instant-only** — inline hooks fire the moment a manual or Plaid transaction lands; a background sweep runs three times a day (ACH windows: 10 AM / 2 PM / 4 PM local) to catch anything the inline path missed. Weighted single-push collapse means multi-alert sweeps produce ONE OS-level banner (the bell still shows every entry), and per-type per-day dedup caps repeat categories. Installed PWAs get an unread-count badge on the home-screen icon via the Web Badging API. Requires VAPID keys in `.env` — see [Web Push setup](#web-push-notifications).
- **Biometric app-lock (mobile only)** — require FaceID / TouchID / fingerprint / device passcode to reveal the app on your phone. Doesn't touch your JWT — an expired session still falls back to whichever sign-in methods are configured. Locks on every fresh open + after 5 min of being backgrounded. Disabling the lock or removing an enrolled device requires a fresh biometric verification. See [Biometric app-lock](#biometric-app-lock) for platform notes.
- **Admin broadcast banner** — instance-wide message admins can post that shows up as a dismissible yellow / amber / rose slip on every user's desktop app (info / warning / critical severity). Useful for maintenance windows or pushed-update notices.
- **Privacy mode** — blurs dollar amounts on the dominant surfaces (hero net worth, KPI cards, account balances, transaction amounts). Hover/focus reveals.
- **Clear all data** — nuclear reset in Settings → Danger zone. Wipes every transaction / account / budget / goal / note / attachment / Plaid item / push subscription / biometric credential tied to your login, and revokes every Plaid connection. The users row itself stays so you can start fresh without re-going-through-the-allowlist. Guarded by a typed-email confirmation.
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
- **Broadcast composer + history** — post an instance-wide desktop banner (info / warning / critical) with an optional expiry timestamp; the history list shows past broadcasts + who published each and lets you archive any active one. Rate-limited 10/min so a runaway console can't spam every user.
- **Plaid account-type counts** — aggregate view (no user-identifying data) of investment / cash / credit / loan Plaid-linked accounts across every user + total item count. Investment accounts are broken out because they cost more in Plaid product fees, so operators charging a flat member fee to break even can size the number correctly. Manual accounts aren't counted.

### Assets & valuables
- **Non-account holdings** — vehicles, boats, jewelry, art, collectibles, property. Track acquired value, current value, and (optionally) a depreciation curve. All roll into net worth alongside your bank accounts and appear in the sidebar under an Assets group.
- **Four value curves** — `none` (you maintain the value manually), `straight-line` (drops evenly from acquired to salvage over N years), `declining-balance` (X% of remaining value each year), `appreciating` (X% growth per year — real estate, art). "Refresh depreciation" snaps the current value to today's projected number in one click, and a **nightly worker cron** runs the same refresh for every user's non-manual asset so the Net Worth chart drifts on its own without anyone touching it.
- **Damage / repair log** — record dents, hail, scratches, or repairs against any asset. Damage rows subtract from current value; repairs add value back. Every event is kept and reversible. The refresh-depreciation button respects the log so a projection re-snap never erases a real-world dent.
- **Loan link** — pair a car loan (or any loan-type account) with the asset it backs. The asset row shows the linked account, remaining balance, and per-asset net position (asset value − amount owed). Net-worth math is unchanged (both sides were already counted); this makes the relationship visible. Linkable from both directions — creating a loan account offers a "backing asset" picker, and the asset form offers a "loan on this asset" picker.

### Tax reporting
- **IRS Schedule tagging on categories** — map each category to Schedule A (itemized), B (interest/dividends), C (business), D (capital gains), or E (rental/royalty). Every transaction in that category rolls into the year-end tax summary.
- **Per-transaction deductible override** — flag any individual transaction as deductible from its detail sheet; ungrouped tags roll to Schedule A.
- **Year-end tax summary PDF** — 6th report in the PDF dropdown. Grouped by Schedule with per-category detail and totals, formatted to hand to a preparer.

### Custom reports
- **Pivot builder in Settings → Data** — pick 1-2 dimensions (category / merchant / account / month / year), a measure (sum / count / average), a side (expense / income / all), an optional date range, and credit-card include/exclude. Save configurations as one-click chips.

### Categories & groups
- **IRS Schedule per category** — map any category to Schedule A/B/C/D/E and the year-end tax PDF rolls the totals up for you.
- **Optional group name** — roll multiple categories into one line on the byCategory pie ("Groceries" + "Restaurants" → "Food"). Display-only: budgets, merchant rules, and category storage remain keyed on the leaf name. A `Categories / Groups` toggle appears on the pie whenever any group exists.
- **Interest & Dividends** — auto-created with Schedule B tagging the first time Plaid reports a dividend or interest transaction on your accounts.

### Split templates
- **Named split shapes** — save any manual split as a template ("Paycheck 60/40"). Choose percent (rescales to any future parent amount) or fixed (absolute amounts). Apply from a dropdown at the top of the split panel; on-save prompt walks through naming and kind.
- **Manual-entry helper**, not an automation — for irregular transactions where a Plaid-triggered rule would misfire.

### Microsoft Money import

Coinvane accepts native `.mny` (Microsoft Money) database files in addition to the QIF Money exports. Two paths depending on your file:

- **Unencrypted `.mny`** — decrypted or password-cleared files import directly. The backend uses `mdbtools` (an Alpine package baked into the backend image) to read the underlying Jet tables — `TRN` (transactions), plus `PAY` / `CAT` for merchant + category lookups. Column names are probed across Money 99 → Sunset since the schema shifted between versions.
- **Password-protected `.mny`** — most Money files are locked. Coinvane bundles `sunriise` (Apache-licensed community Java tool) with the backend image and calls it transparently to strip the password using the Sunset-era backdoor. The frontend prompts for the password when you select the file — leaving it blank tells sunriise to use the backdoor, which is usually the right choice.

**Licensing:** sunriise is Apache 2.0, compatible with Coinvane's AGPL v3 (Apache 2.0 → AGPL is a permitted one-way combination). Vendoring the jar does not affect Coinvane's licence.

**What's imported:** transactions with date, merchant, category, amount, note, and check number. Investment records (`!Type:Invst`) are skipped — those belong in the [lot tracker](#investments), not the transaction ledger. Money's split lines (S / E / $ codes) fan out into individual transaction rows; any residual amount stays on the parent.

### Web Push notifications

Coinvane can push OS-level alerts to a user's lock screen or notification tray via the Web Push standard — Chrome, Edge, Firefox, Safari (iOS 16.4+ as an installed PWA only), Android. Cost: free; the push relays through Google FCM / Apple APNs / Mozilla autopush transparently, no accounts.

**Setup**:

1. Generate a VAPID key pair once, on the VPS:

   ```bash
   docker run --rm node:20-alpine npx --yes web-push generate-vapid-keys
   ```

   Copy the two printed strings into `.env`:

   ```
   VAPID_PUBLIC_KEY=BJx...
   VAPID_PRIVATE_KEY=A5v...
   VAPID_SUBJECT=https://your-domain.com
   ```

   `VAPID_SUBJECT` is an **instance-wide operator contact** used ONLY by push services if they need to reach you about abuse or delivery. Users never see it. Use `mailto:you@your-domain.com` or your app URL. Do NOT use a random user's personal email on a multi-user instance.

2. Restart backend + worker so they pick up the env:

   ```bash
   docker compose up -d --force-recreate backend worker
   ```

3. Users enable per-device from **Settings → Push notifications**. On iOS, the site must first be installed as a home-screen PWA (Share → Add to Home Screen) — Apple only delivers Web Push to installed PWAs.

**Firewall / DNS requirements** — this is easy to miss:

- **Your server** needs outbound HTTPS to `fcm.googleapis.com`, `updates.push.services.mozilla.com`, `web.push.apple.com`, and `*.notify.windows.com`. Blocked outbound = silent failure in worker logs.
- **Every user's own network** must reach the same hosts — `pushManager.subscribe()` calls them from the browser. Pihole, NextDNS, AdGuard, or corporate proxies that block `fcm.googleapis.com` as "Google telemetry" produce a `AbortError: Registration failed - push service error` when the user tries to enable push. Allowlist those hosts on your DNS filter if you run one.
- If any of the three VAPID vars is blank, push is silently disabled — the rest of the app runs normally, users just see "not configured on the server" if they try to enable push in Settings.

**Cadence**: push is **instant-only**. The old daily / weekly options were removed — batching a lock-screen alert defeats the point. Manual transactions and Plaid-synced transactions both fire pushes the moment they land; a background sweep runs three times a day (10 AM / 2 PM / 4 PM local, matching Federal Reserve ACH windows) to catch anything the inline hook missed.

When multiple notifications fire in one sweep, only the highest-priority one produces an OS-level push (weighted by category — large-txn > cashflow-low > budget-exceeded > bill-reminder > ...); the bell still shows every alert. Per-type per-day dedup means the same category can only produce one push per day even across three cron runs plus inline events, so nobody gets three "large transaction" alerts in one afternoon.

**PWA icon badge**: the unread notification count paints a red dot on the installed app's home-screen icon (Web Badging API). Works on Android Chrome, iOS 16.4+ Safari (installed PWA only), and desktop PWA installs on macOS / Windows / ChromeOS. Silent no-op on browsers that don't support the API.

**Manage devices**: users can revoke any enrolled browser individually from the Settings panel; a revoked device silently stops receiving push. Removing a device does NOT log the user out — it just stops push to that browser.

### Sign-in methods

Coinvane supports three passwordless authentication paths. **All three are independently optional** — you must enable at least one, but you can pick any combination. All three are gated by the same email allowlist, and all three converge on the same `users` row for a given email (via a `UNIQUE` constraint), so a user can freely switch between them without creating duplicate accounts.

Bootstrap.sh asks about each one interactively. If you skipped a method during bootstrap you can add it later by editing `.env` and rebuilding (backend + frontend, since the Google client id is a build-time `VITE_*` var).

#### Google SSO (optional)

Requires a Google Cloud OAuth Client ID — see [Google Cloud OAuth setup](#google-cloud-oauth-setup). ID-token verification flow, no client secret needed.

##### Google SSO control variables

| Variable | Default | Purpose |
|---|---|---|
| `GOOGLE_CLIENT_ID` | (blank) | Google OAuth Client ID. Blank = feature off. |
| `VITE_GOOGLE_CLIENT_ID` | (blank) | Same value baked into the frontend bundle. Optional — the frontend also reads the id from `/auth/public-config` at runtime, so leaving this blank still works. |
| `GOOGLE_SSO_ENABLED` | (blank → derive from client id) | Explicit on/off. `false` hides the Google button on the login page AND makes `POST /auth/google` return 404, even when the client id is set — useful for a temporary lockdown without unsetting the id. |

Changing `GOOGLE_SSO_ENABLED` only requires a **backend restart**; the frontend reads it at runtime from `/auth/public-config`. Changing the client id itself requires a frontend rebuild because `VITE_GOOGLE_CLIENT_ID` is baked in at build time.

#### Microsoft SSO (optional)

Powered by MSAL redirect + PKCE on the frontend and JWKS verification on the backend. Matches the Google trust model — no client secret.

**Why redirect and not popup**: modern browsers block MSAL's popup-polling handshake across the Cross-Origin-Opener-Policy boundary between our origin and `login.microsoftonline.com` (Microsoft's login pages don't set a matching COOP header the way Google's do). The popup flow closes without ever handing the token back to the opener; the redirect flow doesn't need cross-window coordination and works everywhere.

**Setup**:

1. Sign in to <https://portal.azure.com> with any Microsoft account (no paid subscription needed).
2. In the top search bar type **App registrations** → click it under Services.
3. **+ New registration**:
   - Name: `Coinvane`
   - Supported account types: pick whichever matches your `MICROSOFT_TENANT` setting (see the [control variables table](#microsoft-sso-control-variables) below). "**Accounts in any organizational directory + personal Microsoft accounts**" is the broadest and matches the default `MICROSOFT_TENANT=common`.
   - **Redirect URI**: **platform dropdown → Single-page application (SPA)**, value → `https://your-domain.example/auth`
   - Click Register.

   ⚠ The platform type MUST be **Single-page application**, not **Web**. Web registrations are treated as confidential clients that require a `client_secret` on token exchange; MSAL browser has no secret to send, so token exchange fails with `AADSTS70002: The provided request must include a 'client_secret' input parameter`. If you see that error, your redirect URI is under Web — delete it and re-add under Single-page application.
4. On the app's **Overview** page, copy **Application (client) ID** into `MICROSOFT_CLIENT_ID` (and optionally `VITE_MICROSOFT_CLIENT_ID`) in your `.env`.
5. **Authentication** panel of the app:
   - Under **Single-page application** → **Add URI** → `http://localhost:5173/auth` (for local dev, if you use it)
   - **Front-channel logout URL** → `https://your-domain.example/logout` (Coinvane serves a logout landing page at that path that clears the local session)
   - Under **Implicit grant and hybrid flows** — leave both checkboxes **unchecked** (auth code + PKCE only).
6. **Token configuration** panel → **+ Add optional claim** → select **ID** → check **email** → **Add**. If it prompts to also add the Graph `email` permission, click **Yes**. Without this the backend rejects sign-in with "Microsoft account has no email".
7. **API permissions**: `Microsoft Graph → User.Read` is already listed — that's all you need. Personal accounts self-consent on first sign-in.

##### Microsoft SSO control variables

| Variable | Default | Purpose |
|---|---|---|
| `MICROSOFT_CLIENT_ID` | (blank) | Entra Application (client) ID. Blank = feature off. |
| `VITE_MICROSOFT_CLIENT_ID` | (blank) | Optional build-time bake-in for the client id. Runtime value from `/auth/public-config` wins if both are set. |
| `MICROSOFT_SSO_ENABLED` | (blank → derive from client id) | Explicit on/off. `false` hides the button on the login page AND makes `POST /auth/microsoft` return 404, even when the client id is set — useful for a temporary lockdown without unsetting the id. |
| `MICROSOFT_TENANT` | `common` | Which Microsoft accounts to accept. Options: `common` (any Entra tenant + personal MSA), `consumers` (personal MSA only — Outlook/Xbox/Live), `organizations` (any Entra tenant, no personal MSA), or a specific tenant GUID (e.g. `contoso.onmicrosoft.com`'s GUID). Enforced on both sides: frontend builds the MSAL authority URL as `login.microsoftonline.com/<tenant>`; backend rejects sign-in with 403 if the token's `tid` claim doesn't match this policy. Must agree with the "Supported account types" on your Entra registration — a stricter server value is fine (narrows further), but a looser server value can't expand what Entra allows. |
| `MICROSOFT_REDIRECT_URI` | (blank → derived at runtime) | Override the redirect URI. Blank = frontend uses `window.location.origin + "/auth"`, which matches whatever domain the user is on. Set this if you serve Coinvane from multiple domains and need to pin sign-in to one, or if you registered a non-standard path. Must match an SPA redirect URI on the Entra app byte-for-byte (trailing slashes count). |
| `VITE_MICROSOFT_REDIRECT_URI` | (blank) | Build-time fallback for the above. Server value from `/auth/public-config` wins if both are set. |

Changing `MICROSOFT_SSO_ENABLED`, `MICROSOFT_TENANT`, or `MICROSOFT_REDIRECT_URI` only requires a **backend restart** (`docker compose up -d --force-recreate backend`) — the frontend reads them at runtime from `/auth/public-config` and adjusts without a rebuild. `VITE_*` values are build-time only.

**Trust model**: the backend verifier accepts any Microsoft tenant that satisfies `MICROSOFT_TENANT`, but every token also has to be minted for *your specific* client id (that's the actual security gate — a token addressed to a different app can't sign anyone in). Belt + suspenders: the verifier validates the issuer's shape (`login.microsoftonline.com/{guid}/v2.0`) and self-consistency (the `tid` claim inside the token must match the tenant GUID inside `iss`). v1.0 tokens (`sts.windows.net`) are deliberately rejected — MSAL 3.x is v2.0-only, so a v1.0 token is either a misconfigured client or an attacker feeding a stale token. The email allowlist is still the second gate at the route level.

**No client secret**: MSAL redirect + PKCE. Same value in both `MICROSOFT_CLIENT_ID` and `VITE_MICROSOFT_CLIENT_ID`; the backend verifies, the frontend uses it to build the MSAL redirect. The frontend reads the id from `/auth/public-config` at runtime, so `VITE_MICROSOFT_CLIENT_ID` is optional — you can leave it blank if you'd rather not bake it into the built bundle.

**Verified publisher warning**: newly-registered multitenant apps show a note in Entra about end users not being able to grant consent without a verified publisher. This only affects users signing in from *other* Entra work/school tenants — personal Microsoft accounts and users from your own tenant are unaffected. If you never expect corporate users on someone else's tenant, ignore the warning. If you do, either the target tenant's admin has to grant admin consent for your app, or you have to publisher-verify via a free Microsoft Partner Network account.

#### Sign in with a one-time link (optional)

Passwordless flow that emails a SHA-256-hashed sign-in link. Great as a fallback if a user loses access to their Google / Microsoft account, or as the primary method if you dislike depending on either.

**Requirements**: `EMAIL_CONFIG=enabled` in `.env` with working SMTP credentials (Resend, Postmark, SES, or your own mail server). Without SMTP, `/one-time-link/request` returns 503.

**Setup**:

1. In `.env`, set `ONE_TIME_LINK_ENABLED=true`.
2. Choose IP binding strictness with `ONE_TIME_LINK_STRICT_IP`:
   - `true` (default): the IP that requested the link must match the IP that clicks it. Blocks stolen-email replay from a different network but breaks cross-device flow (request desktop, click phone) and mobile IPv6/CGNAT rotation.
   - `false`: record the IP for audit but don't enforce.
3. Restart backend + worker: `docker compose up -d --force-recreate backend worker`.

**Flow**:
- User enters their email on the login page.
- Server ALWAYS responds "check your email" regardless of whether the email is on the allowlist (anti-enumeration).
- If allowlisted, an email arrives with a link like `https://your-domain.example/#signin?t=<token>`. Token is a 48-byte random value, base64url-encoded; only its SHA-256 hash is stored server-side. 15-minute expiry, one-time use.
- Click the link → SPA reads the token from the URL fragment (never sent to the server as a query string, never in Referer / access logs), calls `/one-time-link/verify`, gets a JWT. URL history is scrubbed via `replaceState`.

**Handoff codes (iOS Safari → installed PWA bridge)**: iOS keeps Safari's storage separate from the installed PWA's storage. If a user opens the link in Safari but wants their session in the Home Screen PWA, `/verify` returns an 8-character code alongside the JWT. The user enters that code in the PWA's "Have a sign-in code?" field to receive a fresh session there — no second email required. Code alphabet omits look-alikes (`0/O`, `1/I/L`), generated with rejection sampling to avoid modulo bias in the cryptographic RNG. 10-minute expiry. IP-bound when `ONE_TIME_LINK_STRICT_IP=true`.

Android auto-opens installed PWAs via the manifest's `handle_links: "preferred"`, so the handoff step doesn't surface on Android.

**Rate limits**: 20/min per IP on `/request`, 5/hour per email (row-count; RESETS on a successful sign-in so allowlisted users aren't locked out after a few attempts). 30/min per IP on `/verify` and `/handoff`.

### .cvn backup format

Coinvane's proprietary full-instance backup format. A `.cvn` file is a ZIP archive containing everything a user needs to restore their entire Coinvane setup on a fresh instance — every transaction, category, budget, goal, note, bill, loan, asset, holding, and receipt attachment. What's DELIBERATELY excluded: identity fields (email, Google/Microsoft ids, role, biometric credentials), Plaid access tokens (per-server secrets that can't travel), and every session / device / audit table.

**Export**: Settings → Data → Export .cvn. Optional passphrase encrypts the data blob and every attachment individually with AES-256-GCM, key derived via PBKDF2-SHA256 (200 000 iterations, 16-byte salt stored in the manifest). Notes are decrypted from the source server's `ENCRYPTION_KEY` before packing so the file is portable across instances.

**Import**: Settings → Data → Import .cvn. **Refuses on non-empty accounts** — the import path is designed for restore-to-fresh, not merge. Seeded default categories are exempt from the emptiness check. Notes are re-encrypted with the destination server's `ENCRYPTION_KEY`. Attachments are unpacked to `${ATTACHMENTS_ROOT}/${userId}/`.

**Schema-drift resilient**: import uses `SHOW COLUMNS` introspection to filter unknown columns per table, so newer / older .cvn files still restore cleanly as long as the core tables are compatible. New columns added post-export just don't populate; missing columns in a future schema are silently ignored.

**Plaid re-link auto-merge (Stage 3)**: after restoring a `.cvn`, when the user re-links a bank through Plaid, the backend compares each fresh Plaid account to imported manual accounts by name + institution (case-insensitive). Matches surface as merge candidates in the UI. Confirming a merge reparents all references (transactions, budgets, goals, loans, assets, bills, reconciliations, holdings) to the new Plaid-linked account and deletes the manual shell. Transaction dedup during Plaid's 30-90-day backfill window is handled automatically via content match.

**Rate limits**: 3/min on `/backup/export`, 10/min on `/backup/import/preview`, 3 per 5 min on `/backup/import`.

### Biometric app-lock

Optional per-device screen lock on top of whichever sign-in method the user chose. When enabled, the app requires FaceID / TouchID / fingerprint / Windows Hello (whichever the OS offers) to reveal data. The JWT is untouched — an expired session still falls back to the sign-in screen with all three methods available, so no one gets locked out of their own login.

**Platform support**:

| Platform | Prompt shows | Fallback if biometric fails |
|---|---|---|
| iPhone / iPad (16.4+, installed as PWA) | FaceID or TouchID | Device passcode |
| Android Chrome | Fingerprint / face unlock | Screen lock (PIN/pattern/password) |
| macOS Safari / Chrome | Touch ID | System password |
| Windows Edge / Chrome | Windows Hello | PIN |

The OS picks the mechanism. Coinvane calls WebAuthn with `userVerification: required` so the OS is obligated to verify the user somehow — biometric OR the platform's passcode fallback. No extra config needed for the fallback; it's built into every supported platform.

**Setup**: users toggle "Require ... to open" in Settings (only shown on mobile). First enable triggers OS enrollment → subsequent app opens present the lock screen. **iOS specifically** requires the site to be installed as a home-screen PWA first — Safari-tab visits don't get the FaceID prompt.

**Behaviour**:

- Fresh app open / hard-refresh / PWA relaunch → always locks
- In-session backgrounding → locks only after 5 minutes hidden
- **Disabling the lock** or **removing an enrolled device** requires a fresh biometric verification (prevents someone with an already-unlocked app from just flipping the toggle off)

**Nothing to configure server-side** — no VAPID equivalent. The credential is bound to your app's origin (the exact hostname), so migrating to a new domain would require every user to re-enroll on every device. Uses `JWT_SECRET` (already set) to sign the ephemeral challenge tokens; no new env vars.

**Threat model**: this is a **reveal gate** against shoulder-surfers and someone grabbing an unlocked phone, not a security perimeter against a compromised device. Someone with the JWT could still hit `/api/*` directly. Same model as Bitwarden / 1Password.

### Misc
- **Notes** — free-form notes, content encrypted at rest
- **Mobile PWA** — install to iPhone home screen, full-screen, frosted iOS-style nav, Dynamic Island safe
- **Multi-device** — dark mode, theme, and every per-user setting follow you across devices
- **Passwordless auth** — three independently optional sign-in methods, all allowlist-gated, all deduplicated on email so a user can freely switch between them (pick any combination, at least one required):
  - **Google SSO** (optional)
  - **Microsoft SSO** (Entra ID + personal MSA — Xbox / Outlook.com / Live)
  - **Sign in with a one-time link** (email-based, requires SMTP)
  See [Sign-in methods](#sign-in-methods) for setup.
- **Full instance backup** — export EVERYTHING (transactions, categories, budgets, goals, notes, bills, loans, assets, holdings, settings, attachments) as a portable `.cvn` file. Optional passphrase (AES-256-GCM + PBKDF2). Import into a fresh Coinvane instance to restore. See [.cvn backup format](#cvn-backup-format).
- **PDF report dropdown** — Settings → Data → *Export report (PDF)* opens a menu with 7 branded reports, all server-side rendered (no headless browser):
  1. **Full report** — cover + summary + accounts + budgets + goals + last 500 transactions + decrypted notes
  2. **Monthly** — single-month income / expense / cashflow / category breakdown
  3. **Category YoY** — year-over-year per-category comparison
  4. **Budgets** — every budget + spend history for the current and past periods
  5. **Bills & Loans** — recurring bill cycles + loan amortization progress
  6. **Tax summary (year-end)** — deductible transactions grouped by IRS Schedule with per-category totals
  7. **Register (plain print)** — bare, black-and-white transaction register with running balance when scoped to a single account. Filter surface honours the same account / date / category / clearing options as the on-screen register.

  Loan cards also expose a per-loan **Amortization PDF** button that produces the month-by-month schedule for that specific loan.

---

## Stack

| Layer       | Tech                                                   |
| ----------- | ------------------------------------------------------ |
| Backend     | Node.js 20, Fastify 5, MariaDB 11, BullMQ + Redis, Plaid SDK v27, Nodemailer 8, `@fastify/multipart` for receipt uploads, `web-push` for OS notifications, `@simplewebauthn/server` for biometric app-lock |
| Frontend    | React 18, Vite 6, Tailwind 3, Framer Motion 11, Recharts 2, `@simplewebauthn/browser` |
| Server-side rendering | pdfkit (PDF export), papaparse (CSV import), geoip-lite (offline IP→location for audit log) |
| Auth        | Pick any combination: Google SSO, Microsoft SSO (ID-token verification, no client secrets), passwordless email one-time link. At least one required. |
| Encryption  | AES-256-GCM for Plaid access tokens + note content     |
| Infra       | Docker Compose (5 services)                            |
| Reverse proxy | Caddy with auto-HTTPS (Let's Encrypt) — recommended  |

---

## Quick start (local development)

### Prerequisites

- Docker + Docker Compose
- **At least one** sign-in method (bootstrap.sh will ask):
  - Google Cloud OAuth 2.0 Client ID (see [Google setup](#google-cloud-oauth-setup))
  - Microsoft Entra Application (client) ID (see [Microsoft SSO](#microsoft-sso-optional))
  - Working SMTP + one-time-link enabled (see [Sign in with a one-time link](#sign-in-with-a-one-time-link-optional))
- **Optional** (bootstrap.sh asks about each — skip freely):
  - Plaid account for automatic bank sync (see [Plaid setup](#plaid-setup)) — without Plaid, Coinvane runs manual-only with CSV/QIF/OFX/QFX/.mny import
  - SMTP credentials for email digests + one-time-link
  - VAPID key pair for Web Push (bootstrap.sh auto-generates if you enable it)
- `openssl` for secret generation
- `bash` for the bootstrap script (Linux/macOS, or WSL/Git Bash on Windows)

### 1. Clone and bootstrap

```bash
git clone https://github.com/JKJWL/Coinvane.git coinvane
cd coinvane
./bootstrap.sh
```

`bootstrap.sh` walks you through every optional feature and writes `.env`:
- **Generates** cryptographically-random secrets (JWT, encryption key, DB passwords) automatically
- **Prompts** for your domain, email allowlist, and each optional feature individually — enable only what you want:
  - Google SSO (asks for Client ID; enter blank to skip)
  - Microsoft SSO (asks for Client ID; enter blank to skip)
  - Sign-in with a one-time link (skippable — requires SMTP)
  - SMTP for email digests + one-time-link
  - Plaid bank sync (skip to run Coinvane manual-only)
  - Web Push notifications (auto-generates VAPID keys via docker)
- **Requires at least one sign-in method** — exits with an error if you skip Google + Microsoft + one-time-link
- **Writes** a properly-permissioned `.env` (chmod 600)
- **Prints** your `ENCRYPTION_KEY` once — **save it in a password manager**. If you lose this key, all Plaid access tokens and encrypted note content become unrecoverable.

Any feature you skipped during bootstrap can be turned on later by editing `.env` and rebuilding — see [Sign-in methods](#sign-in-methods).

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

Open http://localhost:8080 (or whatever you've configured) and sign in using whichever method(s) you configured — Google, Microsoft, or a one-time link. The **first sign-in on a fresh instance automatically becomes the owner** of the instance regardless of method — single-owner pattern, no UI to transfer (manual `UPDATE users SET role='owner'` if you ever need to). Subsequent sign-ins from the same email address using a different method just link to the same user (dedup by email), so you can freely add or drop methods later without losing your account.

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
./bootstrap.sh      # walks you through every optional feature; enable only what you want
docker compose build
docker compose up -d
docker compose exec backend npm run migrate
```

Visit `https://<your-domain>` and sign in using whichever method you enabled during bootstrap. The first sign-in becomes the instance owner.

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

**Google is optional.** Skip this section if you're going with Microsoft
SSO or one-time-link only — the sign-in page hides the Google button
entirely when `GOOGLE_CLIENT_ID` is blank (or `GOOGLE_SSO_ENABLED=false`).

If you DO want Google Sign-In:

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

**Plaid is optional.** If you don't want automatic bank sync (or if
you just want to try Coinvane first), leave `PLAID_CLIENT_ID` /
`PLAID_SECRET` blank (or set `PLAID_ENABLED=false`) — the app runs
manual-only:

- Frontend hides every Plaid affordance (Connect Bank, Sync buttons,
  Connected Banks panel, admin Plaid-counts card)
- Backend returns 404 for every `/api/plaid/*` route
- Worker skips scheduling periodic sync jobs

You still get manual entry, CSV/QIF/OFX/QFX/`.mny` import, and `.cvn`
restore. If you later want to add Plaid, edit `.env` + restart the
backend and worker; no rebuild needed.

If you DO want Plaid:

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

- **Email allowlist** — only emails on the list can sign in via ANY of the three methods (Google, Microsoft, one-time link); anyone else gets 403 regardless of whether the identity provider would otherwise let them through. Live-editable from the Admin panel (DB-backed in `app_settings.allowed_emails`); falls back to the `ALLOWED_EMAILS` env on fresh deploys.
- **Three-tier role model** — Owner / Admin / Member. Owner is exclusive per instance and the only role that can edit cross-cutting config (sync interval, allowlist, role promotions, sample emails). Admins are scoped to two destructive actions (delete members, clear notifications), both audit-logged as major.
- **Rate limiting** — 200 req/min global, 10 req/min on `/api/auth/google` and `/api/auth/microsoft`, 20/min on `/api/auth/one-time-link/request` (plus 5/hour per email), 30/min on `/verify` and `/handoff`, 60 req/min on every admin route, 300 req/min on the public `/api/plaid/webhook`, plus explicit per-route caps on the filesystem-touching receipt endpoints (60/120/60 req/min for upload / view / delete) and the `.cvn` backup endpoints (3/min export, 10/min preview, 3 per 5 min import).
- **Helmet** — HSTS, X-Frame-Options DENY, strict Referrer-Policy, no `X-Powered-By`.
- **Strict CORS** — refuses to start in production if `CORS_ORIGIN` isn't set.
- **JWT 30-day expiration** — sessions auto-expire; sign back in with whichever method you use. Role changes require a re-login to take effect (JWTs aren't auto-refreshed).
- **Encryption at rest** — Plaid access tokens and note content encrypted with AES-256-GCM.
- **Prepared statements** — every DB query uses parameterized `?` placeholders; no string concatenation, no SQL injection surface.
- **Error masking** — production 5xx responses return a generic message; stack traces stay in logs.
- **Tiered audit log** — every sign-in (success and failure) recorded with IP, user-agent, and offline GeoIP location. Routine entries prune at 48 h; major entries (role changes, user deletes, settings edits, bulk notification wipes) survive 7 days.
- **Body limit** — 512 KB on JSON, 5 MB on the CSV import route + receipt-upload route only. Receipt uploads are additionally mime-whitelisted to PNG/JPG at the route handler.
- **CSP** — nginx serves a strict Content-Security-Policy locking script sources to self, Google, and Plaid; `connect-src` additionally allows `login.microsoftonline.com` + `login.live.com` for MSAL's OIDC/JWKS fetches (MSAL itself is bundled into our own JS, so no third-party `script-src` origin is required for Microsoft SSO).
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

### The Google Sign-In button doesn't appear on the login page

Google is optional now. The button renders only when `/auth/public-config`
returns `googleEnabled: true`, which requires both:

- `GOOGLE_CLIENT_ID` set (not blank) in the backend env
- `GOOGLE_SSO_ENABLED` is either blank or `true` (not `false`)

Check the backend's view of both:

```bash
docker compose exec backend printenv GOOGLE_CLIENT_ID GOOGLE_SSO_ENABLED
```

And confirm the runtime config in a browser:

```
curl -s https://your-domain/api/auth/public-config | grep googleEnabled
```

`googleEnabled: false` means one of the two conditions failed. Fix the
env and `docker compose up -d --force-recreate backend` — no frontend
rebuild needed for the enable flag itself (the frontend reads it at
runtime).

If `VITE_GOOGLE_CLIENT_ID` isn't reaching the frontend bundle (browser
DevTools console: `import.meta.env.VITE_GOOGLE_CLIENT_ID` returns
undefined), Vite reads env vars **at build time** from build args:
- `.env` must have `VITE_GOOGLE_CLIENT_ID=...`
- `docker-compose.yml` frontend `args:` must include `VITE_GOOGLE_CLIENT_ID: ${VITE_GOOGLE_CLIENT_ID}`

Then rebuild without cache: `docker compose build --no-cache frontend`.
The runtime value from `/auth/public-config` also feeds the frontend, so
in most cases the build-time bake-in is redundant.

### Microsoft sign-in errors with "AADSTS70002: The provided request must include a 'client_secret'"

Your redirect URI is registered under the **Web** platform in the Entra app.
Web registrations are treated as confidential clients that require a secret
on token exchange; MSAL browser has no secret to send, so token exchange
fails. Fix in Azure portal → your app → **Authentication**: delete the URI
from the **Web** section and re-add it under **Single-page application**.
Coinvane's redirect flow only works with SPA-typed URIs (PKCE, no secret).

### Microsoft sign-in errors with "AADSTS50011: redirect URI mismatch"

The redirect URI Coinvane sends (either `MICROSOFT_REDIRECT_URI` from `.env`,
or `window.location.origin + "/auth"` if that env is blank) isn't in your
Entra app's registered SPA redirect URIs. In the Azure portal → your app →
Authentication → **Single-page application**, add each origin you sign in from:

- Production: `https://your-domain.example/auth`
- Local dev (only if you test locally): `http://localhost:5173/auth`

Trailing slashes and paths matter — `.../auth` and `.../auth/` are different URIs.

### Microsoft sign-in returns 401 "Microsoft account has no email"

The `email` optional claim isn't configured on your Entra app. In the Azure
portal → your app → **Token configuration** → **+ Add optional claim** → **ID**
→ check **email** → **Add**. If it prompts to also add the Graph email
permission, click Yes. Sign in again.

### Microsoft sign-in returns 403 "This instance only accepts personal Microsoft accounts" (or similar)

`MICROSOFT_TENANT` in your `.env` is stricter than the account the user signed
in with. Either:

- Loosen `MICROSOFT_TENANT` (e.g. from `consumers` to `common`) — followed by
  `docker compose up -d --force-recreate backend`, no frontend rebuild needed
- Or have the user sign in with an account matching your policy (a work
  account for `organizations`, a personal Outlook / Xbox / Live account for
  `consumers`, or an account in the specific tenant if you pinned to a GUID)

Check the audit log for the exact `tid` claim on the rejected sign-in.

### Microsoft sign-in silently fails — popup closes with no error, or `/api/auth/microsoft` never fires in the Network tab

Both are historical symptoms of bugs that are now fixed (COOP breaking MSAL's
popup handoff; MSAL's post-redirect navigation firing before our code could
call the backend). If you see either behaviour again after an upgrade,
confirm your frontend bundle is current:

```bash
docker compose exec frontend sh -c 'grep -c "Completing Microsoft sign-in" /usr/share/nginx/html/assets/*.js'
```

Anything other than `1` means the new bundle isn't deployed — rebuild with
`docker compose build --no-cache frontend && docker compose up -d frontend`.

### "This link must be opened on the same network it was requested from" (one-time-link)

`ONE_TIME_LINK_STRICT_IP=true` is enforcing that the IP requesting the link must
match the IP clicking it. This blocks cross-device flow (request desktop, click
phone) and mobile IPv6/CGNAT rotation. If your users need cross-device or you're
on a mobile carrier that rotates IPs, set `ONE_TIME_LINK_STRICT_IP=false` in
`.env` and restart the backend. Trade-off: a stolen-email attacker on a
different network could redeem the link.

### "Plaid doesn't support connections between [bank] and Coinvane"

The institution doesn't support every product you're requesting. This app uses
`optional_products: ["investments"]` so most banks should work. If you see this
error for a bank that should work, check the backend logs:
```bash
docker compose logs --tail=100 backend | grep -i plaid
```

### "Internal server error" after sign-in

Almost always: migrations haven't been run. `docker compose exec backend npm run migrate`.

Or: the relevant client-id env var is missing/wrong in the backend. `docker compose exec backend printenv GOOGLE_CLIENT_ID` (or `MICROSOFT_CLIENT_ID`).

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
│   │   ├── sync.js                # Plaid sync orchestration (+ dividend/interest auto-categorization)
│   │   ├── mailer.js              # SMTP / Nodemailer + notification-digest template
│   │   ├── quicken-import.js      # QIF / OFX / QFX parsers with MS Money split-record support
│   │   ├── mny-import.js          # Native .mny reader (mdbtools + optional sunriise unlock)
│   │   ├── push.js                # Web Push helper (VAPID + 410-cleanup + weighted pickTopPush + per-type per-day dedup)
│   │   ├── webauthn.js            # Biometric app-lock ceremonies (register + authenticate)
│   │   ├── microsoft-verify.js    # Microsoft ID-token verifier (multi-tenant Entra + personal MSA, JWKS-cached)
│   │   ├── cvn-export.js          # .cvn full-instance export builder (ZIP + optional AES-256-GCM)
│   │   ├── cvn-import.js          # .cvn restore with SHOW-COLUMNS schema-drift-proof safeInsert
│   │   └── routes/
│   │       ├── auth.js            # Google SSO + Microsoft SSO + One-Time-Link + WebAuthn, /me, members, role updates, test-email/push
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
│   │       ├── reconciliations.js # Quicken-style statement match (draft/locked passes)
│   │       ├── tax.js             # Year-end IRS Schedule roll-up
│   │       ├── reports.js         # Custom pivot builder + saved reports
│   │       ├── assets.js          # Vehicles / valuables + depreciation + damage log + loan link
│   │       ├── backup.js          # .cvn export + import (preview + apply) + Plaid re-link auto-merge candidates
│   │       ├── bills.js           # Recurring bill templates + cycle rollover + auto-match on Plaid sync
│   │       ├── loans.js           # Debt payoff tracking + amortization + linked-account payment mirroring
│   │       └── export.js          # PDF dropdown: full / monthly / yoy / budgets / bills-loans / tax-summary / register / amortization
│   ├── vendor/                    # Optional runtime dependencies (sunriise.jar for encrypted .mny)
│   ├── Dockerfile
│   └── package.json
├── Frontend/
│   ├── src/
│   │   ├── App.jsx             # The whole UI (single-file by design)
│   │   ├── main.jsx
│   │   ├── index.css           # Tailwind + iOS PWA reset + privacy-mode blur rule
│   │   ├── api/client.js       # Thin fetch wrapper + authed file-download helper
│   │   ├── push.js             # Service-worker registration + enroll/unenroll for Web Push
│   │   ├── webauthn.js         # Enroll / unlock helpers wrapping @simplewebauthn/browser
│   │   ├── hooks/useAuth.js
│   │   └── context/DateContext.jsx  # Global data store
│   ├── public/sw.js               # Service worker (push handler + notification click routing)
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
| `GOOGLE_CLIENT_ID`        | Optional | Google OAuth Client ID. Blank = Google button hidden on the login page. At least ONE of Google / Microsoft / one-time-link must be enabled. See [Google SSO](#google-sso-optional). |
| `VITE_GOOGLE_CLIENT_ID`   | Optional | Same value baked into the frontend bundle. Optional — the frontend also reads the id from `/auth/public-config` at runtime, so leaving this blank still works. |
| `GOOGLE_SSO_ENABLED`      | Optional | `false` hides the button + rejects `POST /auth/google` even when the client id is set. Blank/unset = enabled when a client id is present. |
| `MICROSOFT_CLIENT_ID`     | Optional | Entra Application (client) ID. When set (and `MICROSOFT_SSO_ENABLED` isn't false), a "Continue with Microsoft" button appears on the sign-in page. See [Microsoft SSO](#microsoft-sso-optional). |
| `VITE_MICROSOFT_CLIENT_ID` | Optional | Same value baked into the frontend bundle. Optional — the frontend also reads the id from `/auth/public-config` at runtime, so leaving this blank still works. |
| `MICROSOFT_SSO_ENABLED`   | Optional | `false` hides the button + rejects `POST /auth/microsoft` even when the client id is set. Blank/unset = enabled when a client id is present. |
| `MICROSOFT_TENANT`        | Optional | Which Microsoft accounts to accept: `common` (default — any Entra tenant + personal MSA), `consumers` (personal only), `organizations` (Entra tenants only), or a specific tenant GUID. Enforced by both the frontend authority URL and the backend token policy. |
| `MICROSOFT_REDIRECT_URI`  | Optional | Override the MSAL redirect URI. Blank = frontend uses `window.location.origin + "/auth"` at runtime. Must match a Single-page application redirect URI registered on the Entra app. |
| `VITE_MICROSOFT_REDIRECT_URI` | Optional | Build-time fallback for the above. Runtime value from `/auth/public-config` wins if both are set. |
| `ONE_TIME_LINK_ENABLED`   | Optional | `false` (default) hides the passwordless email option; `true` shows it. Requires `EMAIL_CONFIG=enabled`. See [Sign in with a one-time link](#sign-in-with-a-one-time-link-optional). |
| `ONE_TIME_LINK_STRICT_IP` | Optional | `true` (default) enforces same-IP for link request/click and handoff-code issue/redeem. `false` records the IP for audit but doesn't enforce. Loosen if your users need cross-device flow or are on mobile networks with rotating IPv6. |
| `ALLOWED_EMAILS`          | Recommended | Comma-separated allowlist (Google, Microsoft, and one-time-link addresses all match against this list). Used until the owner edits it in the Admin panel; after that the DB-backed allowlist takes over. Empty = anyone with a supported sign-in method can register. |
| `PLAID_ENABLED`           | Optional | `false` forces manual-only mode (hides every Plaid affordance, backend 404s `/api/plaid/*`, worker skips periodic sync). Blank = derived from `PLAID_CLIENT_ID` + `PLAID_SECRET` (enabled when both set). |
| `PLAID_CLIENT_ID` / `PLAID_SECRET` / `PLAID_ENV` | Optional | Plaid keys; env is `sandbox` or `production`. Skip these entirely to run Coinvane as a manual-only budgeting app — you still get manual entry, CSV/QIF/OFX/QFX/.mny import, and `.cvn` restore. |
| `PLAID_REDIRECT_URI`      | Only if Plaid+production | OAuth return URL, must match Plaid dashboard exactly         |
| `PLAID_WEBHOOK_URL`       | Optional | Auto-sync push endpoint; verified by signature                       |
| `APP_URL` / `CORS_ORIGIN` | Yes      | Your full HTTPS URL; CORS won't start without it in production. `APP_URL` is also used as the "Open Coinvane" link target in notification emails. |
| `SIGNUP_MODE`             | Optional | `open` (default) — any allowlisted email can sign up via any configured method. `closed` — no new users; existing users may still sign in. Use `closed` after your household roster is finalised to harden the deployment. |
| `SYNC_INTERVAL_MINUTES`   | Optional | Initial polling cadence for Plaid; default 60. Owners can override this live from the Admin panel (the DB value wins). Webhook-driven syncs fire regardless. |
| `EMAIL_CONFIG`            | Optional | `disabled` (default) or `enabled`. Master kill-switch for outbound email. UI greys out email-notification settings when disabled. |
| `SMTP_*`                  | Optional | SMTP credentials, only consulted when `EMAIL_CONFIG=enabled`. Leave `SMTP_HOST` blank to log emails to console for testing. |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | Optional | Web Push key pair. Generate once with `docker run --rm node:20-alpine npx --yes web-push generate-vapid-keys`. Blank = push silently disabled; rest of app is unaffected. See [Web Push notifications](#web-push-notifications). |
| `VAPID_SUBJECT`           | Optional | Instance-wide operator contact push services use for abuse reports. `mailto:` URL or `https://` URL. Don't put a random user's personal email here on multi-user instances. |

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
