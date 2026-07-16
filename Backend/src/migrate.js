// SPDX-License-Identifier: AGPL-3.0-or-later
import "dotenv/config";
import { pool, query, queryOne } from "./db.js";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    google_id VARCHAR(64) UNIQUE,
    picture VARCHAR(512),
    name VARCHAR(255),
    role ENUM('owner','admin','user') DEFAULT 'user',
    currency VARCHAR(8) DEFAULT 'USD',
    timezone VARCHAR(64) DEFAULT 'UTC',
    dark_mode BOOLEAN DEFAULT FALSE,
    notification_email BOOLEAN DEFAULT TRUE,
    notification_push BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // ── ALTER statements for upgrading existing databases ────────────
  // MariaDB 10.0+ supports IF NOT EXISTS on ADD COLUMN
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS google_id VARCHAR(64) UNIQUE`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS picture VARCHAR(512)`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS dark_mode BOOLEAN DEFAULT FALSE`,
  // Income tracker (Feature 4)
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS income_period VARCHAR(32) DEFAULT 'monthly'`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS income_period_days INT NULL`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS income_period_start DATE NULL`,
  // Credit usage tracker (Feature 4)
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS credit_period VARCHAR(32) DEFAULT 'monthly'`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS credit_period_days INT NULL`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS credit_period_start DATE NULL`,

  // Notification preferences — every notification type has a per-user
  // enable flag and (where applicable) a threshold. These are read by
  // notification-engine.js on each daily run.
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS notify_large_txn BOOLEAN DEFAULT TRUE`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS large_txn_threshold INT DEFAULT 500`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS notify_income BOOLEAN DEFAULT TRUE`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS income_threshold INT DEFAULT 100`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS notify_budget_warning BOOLEAN DEFAULT TRUE`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS budget_warning_pct INT DEFAULT 80`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS notify_budget_exceeded BOOLEAN DEFAULT TRUE`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS notify_goal_milestone BOOLEAN DEFAULT TRUE`,
  // Misc user prefs
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS privacy_mode BOOLEAN DEFAULT FALSE`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS week_start TINYINT DEFAULT 0`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS email_frequency VARCHAR(16) DEFAULT 'daily'`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS email_weekday TINYINT DEFAULT 1`,

  `CREATE TABLE IF NOT EXISTS plaid_items (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    plaid_item_id VARCHAR(128) UNIQUE NOT NULL,
    access_token_enc TEXT NOT NULL,
    institution_id VARCHAR(64),
    institution_name VARCHAR(255),
    sync_cursor TEXT,
    last_sync_at TIMESTAMP NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS accounts (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    plaid_item_id INT,
    plaid_account_id VARCHAR(128) UNIQUE,
    name VARCHAR(255) NOT NULL,
    type VARCHAR(32) NOT NULL,
    subtype VARCHAR(64),
    balance DECIMAL(14,2) NOT NULL DEFAULT 0,
    limit_amount DECIMAL(14,2),
    institution VARCHAR(255),
    last_sync_at TIMESTAMP NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (plaid_item_id) REFERENCES plaid_items(id) ON DELETE CASCADE,
    INDEX idx_user (user_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS transactions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    account_id INT,
    plaid_transaction_id VARCHAR(128) UNIQUE,
    date DATE NOT NULL,
    merchant VARCHAR(255) NOT NULL,
    category VARCHAR(64) NOT NULL DEFAULT 'Other',
    amount DECIMAL(14,2) NOT NULL,
    pending BOOLEAN DEFAULT FALSE,
    note TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE SET NULL,
    INDEX idx_user_date (user_id, date),
    INDEX idx_category (category)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS categories (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    name VARCHAR(64) NOT NULL,
    color VARCHAR(16) NOT NULL DEFAULT '#6b7280',
    icon VARCHAR(64) DEFAULT 'Tag',
    custom BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE KEY uq_user_name (user_id, name)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS budgets (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    category VARCHAR(64) NOT NULL,
    amount DECIMAL(14,2) NOT NULL,
    period VARCHAR(32) DEFAULT 'monthly',
    period_start DATE NULL,
    period_days INT NULL,
    account_id INT NULL,
    sort_order INT DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
    UNIQUE KEY uq_user_cat_account (user_id, category, account_id),
    INDEX idx_user_sort (user_id, sort_order)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // ── Budget table upgrades for existing installs ────────────────
  `ALTER TABLE budgets MODIFY COLUMN period VARCHAR(32) DEFAULT 'monthly'`,
  `ALTER TABLE budgets ADD COLUMN IF NOT EXISTS period_start DATE NULL`,
  `ALTER TABLE budgets ADD COLUMN IF NOT EXISTS period_days INT NULL`,
  `ALTER TABLE budgets ADD COLUMN IF NOT EXISTS account_id INT NULL`,
  `ALTER TABLE budgets ADD COLUMN IF NOT EXISTS sort_order INT DEFAULT 0`,

  // ── Per-merchant category rules (Feature 3) ────────────────────
  // When the user re-categorises a transaction and chooses "apply to all",
  // we save a rule here. Sync.js consults this map when inserting new
  // Plaid transactions; the user's category wins over Plaid's classifier.
  `CREATE TABLE IF NOT EXISTS merchant_rules (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    merchant VARCHAR(255) NOT NULL,
    category VARCHAR(64) NOT NULL,
    is_default BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE KEY uq_user_merchant (user_id, merchant)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  // is_default flag lets the "clear all merchant rules" admin action skip
  // app-shipped defaults. Currently every row is user-created (no shipped
  // defaults exist yet), so all rows have is_default=FALSE.
  `ALTER TABLE merchant_rules ADD COLUMN IF NOT EXISTS is_default BOOLEAN DEFAULT FALSE`,

  // ── Budget audit log (historical accuracy) ─────────────────────
  // One row per create/update/delete event with a full state snapshot.
  // `GET /budgets/history` resolves each past period against this table:
  // for each budget, it picks the latest audit row with effective_at <
  // periodEnd, and skips the budget if that latest row is a 'delete'.
  // budget_id is intentionally NOT a foreign key so audit rows survive
  // their parent budget being deleted.
  `CREATE TABLE IF NOT EXISTS budget_audit (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    budget_id INT NOT NULL,
    category VARCHAR(64) NOT NULL,
    amount DECIMAL(14,2) NULL,
    period VARCHAR(32) NULL,
    period_start DATE NULL,
    period_days INT NULL,
    account_id INT NULL,
    action ENUM('create','update','delete') NOT NULL,
    effective_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_user_budget_eff (user_id, budget_id, effective_at),
    INDEX idx_user_eff (user_id, effective_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS goals (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    name VARCHAR(128) NOT NULL,
    target DECIMAL(14,2) NOT NULL,
    saved DECIMAL(14,2) NOT NULL DEFAULT 0,
    deadline DATE,
    icon VARCHAR(64) DEFAULT 'Target',
    color VARCHAR(16) DEFAULT '#0ea5e9',
    account_id INT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE SET NULL,
    INDEX idx_goal_account (account_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // Bank-account-linked goals: when set, the goal's "saved" amount is
  // computed live from the linked account's current balance rather than
  // tracked via manual contributions. ON DELETE SET NULL so unlinking
  // an account just detaches the goal instead of cascading.
  `ALTER TABLE goals ADD COLUMN IF NOT EXISTS account_id INT NULL`,

  `CREATE TABLE IF NOT EXISTS notes (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    title VARCHAR(255),
    content TEXT,
    pinned BOOLEAN DEFAULT FALSE,
    color VARCHAR(16) DEFAULT '#fef3c7',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS notifications (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    type VARCHAR(64) NOT NULL,
    icon VARCHAR(64),
    color VARCHAR(16),
    title VARCHAR(255) NOT NULL,
    body TEXT,
    read_at TIMESTAMP NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_user_created (user_id, created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS securities (
    id INT AUTO_INCREMENT PRIMARY KEY,
    plaid_security_id VARCHAR(128) UNIQUE NOT NULL,
    name VARCHAR(255) NOT NULL,
    ticker_symbol VARCHAR(32),
    type VARCHAR(64),
    close_price DECIMAL(14,4),
    currency VARCHAR(8) DEFAULT 'USD',
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_ticker (ticker_symbol)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS holdings (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    account_id INT NOT NULL,
    security_id INT NOT NULL,
    quantity DECIMAL(20,8) NOT NULL,
    cost_basis DECIMAL(14,4),
    institution_value DECIMAL(14,2) NOT NULL,
    institution_price DECIMAL(14,4) NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
    FOREIGN KEY (security_id) REFERENCES securities(id) ON DELETE CASCADE,
    INDEX idx_user (user_id),
    INDEX idx_account (account_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // ── App-level admin settings (DB-backed, hot-editable) ────────────
  // Stores key/value pairs that used to live exclusively in .env. Reads
  // fall back to env when a key is missing so existing deployments keep
  // working without manual seeding.
  //   "sync_interval_minutes" — overrides SYNC_INTERVAL_MINUTES at runtime
  //   "allowed_emails"        — overrides ALLOWED_EMAILS (CSV of emails)
  `CREATE TABLE IF NOT EXISTS app_settings (
    \`key\` VARCHAR(64) PRIMARY KEY,
    \`value\` TEXT,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS audit_log (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NULL,
    action VARCHAR(64) NOT NULL,
    ip VARCHAR(45),
    user_agent VARCHAR(255),
    metadata TEXT,
    is_major BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_user_time (user_id, created_at),
    INDEX idx_action_time (action, created_at),
    INDEX idx_major_time (is_major, created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  // ── Role + audit upgrades for existing installs ──────────────────
  // MariaDB needs an explicit MODIFY to extend an ENUM in place.
  `ALTER TABLE users MODIFY COLUMN role ENUM('owner','admin','user') DEFAULT 'user'`,
  `ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS is_major BOOLEAN DEFAULT FALSE`,

  // ── Internal-transfer detection (Bug fix) ────────────────────────
  // When money moves between two of the user's own accounts (savings →
  // checking, etc), Plaid reports it as TWO rows — one negative on the
  // source, one positive on the destination. Both flags below get set
  // for either half of a detected pair:
  //   is_transfer         = TRUE  → excluded from income/spending rollups
  //                                 and from category-budget spent totals
  //   transfer_group_id   = UUID  → used to collapse the pair to a single
  //                                 row in the transactions list
  // Detection lives in sync.js and runs after every Plaid sync:
  //   (a) Plaid tagged the txn as TRANSFER_IN / TRANSFER_OUT       — strong signal
  //   (b) opposite-signed match on another of user's accounts       — fallback
  //       (same |amount| within $0.01, within ±3 days)
  `ALTER TABLE transactions ADD COLUMN IF NOT EXISTS is_transfer BOOLEAN DEFAULT FALSE`,
  `ALTER TABLE transactions ADD COLUMN IF NOT EXISTS transfer_group_id VARCHAR(64) NULL`,

  // ── Paystub / income breakdown (Feature: paystub detail sheet) ──
  // JSON blob attached to any positive-amount transaction. Structure:
  //   {
  //     companyName: "Foo Inc",
  //     memo: "…",
  //     earnings: [{ name, category, amount }],
  //     preTax:   [{ name, category, amount }],
  //     taxes:    [{ name, category, amount }],
  //     postTax:  [{ name, category, amount }],
  //     deposits: [{ accountId?, memo, amount }],
  //   }
  // Stored as LONGTEXT (MariaDB JSON is an alias) to keep the migration
  // simple and let us iterate the shape without more ALTERs. Server never
  // parses the payload — it's opaque to backend queries — the client owns
  // rendering + validation.
  `ALTER TABLE transactions ADD COLUMN IF NOT EXISTS paystub_json LONGTEXT NULL`,

  // ── Scheduled transactions (Feature: schedule + copy + auto-match) ──
  // User-authored placeholder rows for upcoming income / bills. Rules:
  //   - is_scheduled = TRUE     → hidden from budget income, cashflow, and
  //                                notification triggers until it "arrives"
  //   - has no plaid_transaction_id (all scheduled rows are user-created)
  //   - listed in the dedicated Scheduled section at the top of the
  //     Transactions tab regardless of its `date` (which is the future
  //     expected date, not today)
  //   - sync.js's Plaid pipeline treats these as PROTECTED: real Plaid
  //     rows that match (same account, |amount| within $5, date within
  //     ±3 days) ADOPT the scheduled row instead of inserting a new one
  //     — the row keeps its id but flips is_scheduled=0 and gets the
  //     Plaid transaction_id + real merchant/date/amount stamped in.
  //   - user can toggle is_scheduled manually from the detail sheet if
  //     the matcher guesses wrong
  `ALTER TABLE transactions ADD COLUMN IF NOT EXISTS is_scheduled BOOLEAN DEFAULT FALSE`,
  `ALTER TABLE transactions ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMP NULL`,

  // ── Automations (Feature: Automations tab) ──────────────────────
  // Per-user rule engine. Each rule is:
  //   trigger:    one of transaction_arrived | income_landed |
  //               period_rolled_over | daily_check | balance_changed
  //   conditions: JSON array of { field, op, value } — ALL must pass
  //   actions:    JSON array of { kind, params } — run in order
  //   enabled:    on/off without deleting the rule
  //   sort_order: user-defined execution order within a trigger
  // Author + edit is DESKTOP-ONLY per user spec; mobile just executes.
  `CREATE TABLE IF NOT EXISTS automation_rules (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    name VARCHAR(128) NOT NULL,
    trigger_type VARCHAR(32) NOT NULL,
    conditions LONGTEXT,
    actions LONGTEXT,
    enabled BOOLEAN DEFAULT TRUE,
    sort_order INT DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_user_trigger (user_id, trigger_type, enabled)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // Per-user PRIVATE history of rule fires. Kept separate from
  // audit_log (which is admin/security-scoped) per user requirement:
  // "Nothing in audit log should fire for peoples personal automations".
  // Worker prunes rows older than 30 days daily (idx_user_fired covers
  // the retention scan).
  `CREATE TABLE IF NOT EXISTS automation_history (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    rule_id INT NULL,
    rule_name VARCHAR(128),
    status ENUM('success','error','skipped') NOT NULL,
    summary VARCHAR(255),
    error_message TEXT,
    transaction_id INT NULL,
    budget_id INT NULL,
    goal_id INT NULL,
    acknowledged BOOLEAN DEFAULT FALSE,
    fired_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_user_fired (user_id, fired_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // Sticky error flag: set when an automation errors on this row. Only
  // clears when the user acknowledges the error in the Automations tab.
  // Surfaced as a red "Error" pill on the txn with a tooltip pointing
  // the user at Automation history.
  `ALTER TABLE transactions ADD COLUMN IF NOT EXISTS has_automation_error BOOLEAN DEFAULT FALSE`,

  // ── Automations Stage 4: budget rules ───────────────────────────
  // rollover_credit is a one-time per-period adjustment on top of the
  // budget's standing amount. Effective cap = amount + rollover_credit.
  //   - rollover_unused_budget action SETS this at period boundary
  //   - seasonal_bump action ADDS to it if the current period's month
  //     matches
  //   - move_budget_slack action shifts it between two budgets
  // Kept simple on purpose: no per-period audit trail of what changed, no
  // audit table beyond automation_history. If a rule stops firing, the
  // credit just... freezes at its last value until another rule touches
  // it or the user edits the budget.
  `ALTER TABLE budgets ADD COLUMN IF NOT EXISTS rollover_credit DECIMAL(14,2) DEFAULT 0`,

  // Per-user "last master-period start we processed" — the daily cron
  // uses this to fire period_rolled_over EXACTLY ONCE per boundary
  // (rather than once per cron tick). Nullable so brand-new users
  // don't trigger a bogus rollover on their first cron run.
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS last_budget_period_processed DATE NULL`,

  // Goals archived-at timestamp (Stage 6: archive_completed_goals).
  // GET /goals excludes rows with archived_at set by default, so
  // completed goals disappear from the main list without losing
  // history / audit context.
  `ALTER TABLE goals ADD COLUMN IF NOT EXISTS archived_at TIMESTAMP NULL`,

  // ── Receipt attachments (1:1 per transaction) ─────────────────────
  // Filesystem-backed. The columns are the entire row metadata; the
  // actual image lives at attachment_path (relative to the shared
  // uploads volume mounted into backend + worker at /data/attachments).
  //   - Only PNG / JPG. Enforced at upload.
  //   - Max 5 MB. Enforced at upload.
  //   - Replace-on-reupload: same row updated, old file unlinked.
  //   - Split children can't have their own — enforced by checking
  //     `note LIKE '[Split from #%'` at upload time. The parent gets
  //     the receipt; children reference the parent for print.
  //   - has_attachment denormalised for fast "receipts first" sorts.
  `ALTER TABLE transactions ADD COLUMN IF NOT EXISTS has_attachment TINYINT DEFAULT 0`,
  `ALTER TABLE transactions ADD COLUMN IF NOT EXISTS attachment_path VARCHAR(255) NULL`,
  `ALTER TABLE transactions ADD COLUMN IF NOT EXISTS attachment_mimetype VARCHAR(64) NULL`,
  `ALTER TABLE transactions ADD COLUMN IF NOT EXISTS attachment_size INT NULL`,
  `ALTER TABLE transactions ADD COLUMN IF NOT EXISTS attachment_uploaded_at TIMESTAMP NULL`,

  // Upload log — used purely for rate-limit windowing. Two windows:
  //   3 uploads per transaction per 5 minutes
  //   50 uploads per user per 30 minutes
  // Rows older than 30 minutes are pruned lazily on each rate check.
  `CREATE TABLE IF NOT EXISTS attachment_upload_log (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    transaction_id INT NOT NULL,
    uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_user_time (user_id, uploaded_at),
    INDEX idx_txn_time (transaction_id, uploaded_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // ── Bills (recurring outgoing obligations) ────────────────────────
  // Distinct from scheduled_transactions in three ways:
  //   1. Recurring template that regenerates each cycle
  //   2. Per-cycle "paid?" state, variance vs rolling average
  //   3. Dashboard surfaces "due this week" / "paid this cycle"
  // Auto-match: on each transaction arrival we look for an unpaid cycle
  // whose merchant_pattern matches the txn merchant + amount within
  // tolerance, and mark it paid. Manual fallback is always available.
  `CREATE TABLE IF NOT EXISTS bills (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    name VARCHAR(128) NOT NULL,
    category VARCHAR(64) DEFAULT 'Bills',
    cycle VARCHAR(16) NOT NULL DEFAULT 'monthly',
    cycle_days INT NULL,
    cycle_anchor DATE NOT NULL,
    expected_amount DECIMAL(14,2) NOT NULL DEFAULT 0,
    average_amount DECIMAL(14,2) NULL,
    account_id INT NULL,
    autopay TINYINT DEFAULT 0,
    account_hint VARCHAR(32) NULL,
    min_payment DECIMAL(14,2) NULL,
    merchant_pattern VARCHAR(128) NULL,
    notes VARCHAR(500) NULL,
    archived_at TIMESTAMP NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_user_active (user_id, archived_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // Per-cycle history. One row per bill per billing cycle. cycle_start
  // is the anchor for that cycle; due_date is when we expect to pay
  // (usually cycle_end - a few days, but simplest = cycle_end).
  //   paid_at NULL  = unpaid (may be upcoming or overdue)
  //   paid_at set   = paid, with paid_amount + variance_pct populated
  //   skipped = 1   = user marked "skip this cycle" (doesn't count as unpaid)
  // ── User preference: cashflow forecast visibility ───────────────
  // Default TRUE so new users see it out of the box. Settings-panel
  // toggle just PATCHes /auth/me with this field.
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS show_cashflow_forecast BOOLEAN DEFAULT TRUE`,

  // ── Loans (debt-payoff tracking) ─────────────────────────────────
  // Sits alongside goals conceptually (the Goals tab hosts a second
  // section for these). current_balance is authoritative for payoff
  // math and is manually updated by the user OR auto-decremented on
  // Plaid loan-account balance changes when linked_account_id is set.
  `CREATE TABLE IF NOT EXISTS loans (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    name VARCHAR(128) NOT NULL,
    loan_type VARCHAR(24) DEFAULT 'other',
    principal DECIMAL(14,2) NOT NULL,
    current_balance DECIMAL(14,2) NOT NULL,
    apr DECIMAL(6,3) NOT NULL DEFAULT 0,
    term_months INT NOT NULL DEFAULT 0,
    monthly_payment DECIMAL(14,2) NOT NULL DEFAULT 0,
    start_date DATE NOT NULL,
    linked_account_id INT NULL,
    notes VARCHAR(500) NULL,
    archived_at TIMESTAMP NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_user_active (user_id, archived_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // ── Reconciliation flow (Stage 1: parity with Quicken statement match) ──
  // One row per finished statement pass on a single account. While a
  // reconciliation is in-progress (status='draft'), the user ticks
  // transactions off; when the "difference" between the account's
  // cleared-total and the statement's ending balance hits zero, the user
  // finalizes and status flips to 'locked'. Locked reconciliations are
  // immutable and their transactions are frozen at reconciliation_id.
  // Transactions can only belong to ONE finalized reconciliation per
  // account — enforced at the app layer (checked on toggle).
  `CREATE TABLE IF NOT EXISTS reconciliations (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    account_id INT NOT NULL,
    statement_date DATE NOT NULL,
    statement_ending_balance DECIMAL(14,2) NOT NULL,
    starting_balance DECIMAL(14,2) NOT NULL DEFAULT 0,
    cleared_total DECIMAL(14,2) NOT NULL DEFAULT 0,
    txn_count INT NOT NULL DEFAULT 0,
    status ENUM('draft','locked') NOT NULL DEFAULT 'draft',
    locked_at TIMESTAMP NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
    INDEX idx_user_account (user_id, account_id, statement_date)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // Cleared bit on the transaction. reconciliation_id points at the locked
  // pass that captured this txn (NULL while it's ticked in a draft — only
  // gets stamped on finalize).
  `ALTER TABLE transactions ADD COLUMN IF NOT EXISTS cleared TINYINT DEFAULT 0`,
  `ALTER TABLE transactions ADD COLUMN IF NOT EXISTS reconciliation_id INT NULL`,

  // ── Tax tagging (Stage 1: parity with Quicken tax schedules) ──────
  // tax_schedule on categories = 'A' | 'B' | 'C' | 'D' | 'E' | NULL
  //   A = itemized deductions (mortgage int, SALT, charity, medical)
  //   B = interest & dividends income
  //   C = business income/expense
  //   D = capital gains
  //   E = rental / royalty
  // is_deductible on individual transactions overrides the category default
  // when the user manually flags one (e.g. a business meal on a personal
  // card). The tax-summary endpoint uses:
  //   effective_deductible = t.is_deductible OR c.tax_schedule IS NOT NULL
  `ALTER TABLE categories ADD COLUMN IF NOT EXISTS tax_schedule VARCHAR(2) NULL`,
  `ALTER TABLE transactions ADD COLUMN IF NOT EXISTS is_deductible TINYINT DEFAULT 0`,

  `CREATE TABLE IF NOT EXISTS bill_cycles (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    bill_id INT NOT NULL,
    cycle_start DATE NOT NULL,
    cycle_end DATE NOT NULL,
    due_date DATE NOT NULL,
    expected_amount DECIMAL(14,2) NOT NULL,
    paid_at TIMESTAMP NULL,
    paid_amount DECIMAL(14,2) NULL,
    matched_txn_id INT NULL,
    skipped TINYINT DEFAULT 0,
    variance_pct DECIMAL(6,2) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (bill_id) REFERENCES bills(id) ON DELETE CASCADE,
    INDEX idx_user_open (user_id, paid_at, cycle_end),
    INDEX idx_bill_start (bill_id, cycle_start)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
];

const DEFAULT_CATEGORIES = [
  ["Groceries", "#10b981", "Utensils"], ["Restaurants", "#f59e0b", "Coffee"],
  ["Gas & Fuel", "#ef4444", "Car"], ["Entertainment", "#ec4899", "Film"],
  ["Shopping", "#8b5cf6", "ShoppingBag"], ["Utilities", "#3b82f6", "Zap"],
  ["Subscriptions", "#06b6d4", "Repeat"], ["Health & Fitness", "#f43f5e", "Heart"],
  ["Income", "#10b981", "DollarSign"], ["Travel", "#0ea5e9", "Plane"],
  ["Home", "#a855f7", "Home"], ["Transfer", "#64748b", "ArrowUpRight"],
  ["Other", "#6b7280", "Briefcase"],
];

// "Soft" statements that may fail on a fresh DB (e.g. dropping an index
// that doesn't exist). We swallow the error so re-runs stay idempotent.
const SOFT_SCHEMA = [
  // Swap the old single-column unique key for the new composite one on budgets.
  // The composite key was created by the CREATE TABLE; if the old index also
  // exists (from a pre-upgrade install), drop it.
  `ALTER TABLE budgets DROP INDEX uq_user_cat`,
  // Older deployments got the goals.account_id column added by the
  // idempotent ALTER above but without the FK / index — add them here.
  // Both fail silently on fresh DBs where the CREATE TABLE already
  // included them.
  `ALTER TABLE goals ADD INDEX idx_goal_account (account_id)`,
  `ALTER TABLE goals ADD CONSTRAINT fk_goals_account
     FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE SET NULL`,
  // Transfer-group index — MariaDB pre-10.5 doesn't support IF NOT EXISTS on
  // ADD INDEX, so this lives in SOFT_SCHEMA and errors are swallowed on
  // subsequent runs where the index already exists.
  `ALTER TABLE transactions ADD INDEX idx_transfer_group (transfer_group_id)`,
  // Adopt-match lookup runs on every Plaid insert, so this index is
  // load-bearing (user_id, account_id, is_scheduled, date).
  `ALTER TABLE transactions ADD INDEX idx_scheduled_match (user_id, account_id, is_scheduled, date)`,
];

async function run() {
  console.log("Running migrations...");
  for (const stmt of SCHEMA) {
    await query(stmt);
  }
  for (const stmt of SOFT_SCHEMA) {
    try { await query(stmt); }
    catch (e) { /* expected on fresh DBs */ }
  }
  console.log("Schema OK.");

  // Backfill budget_audit for any pre-existing budgets that have no audit
  // history yet. Seeds one 'create' row at the original created_at so the
  // history endpoint can resolve periods that pre-date the audit table.
  // Idempotent: only inserts rows missing from budget_audit, so re-runs
  // after migrations do nothing.
  const orphans = await query(
    `SELECT b.id, b.user_id, b.category, b.amount, b.period, b.period_start,
            b.period_days, b.account_id, b.created_at
     FROM budgets b
     LEFT JOIN budget_audit ba ON ba.budget_id = b.id
     WHERE ba.id IS NULL`
  );
  if (orphans.length > 0) {
    for (const b of orphans) {
      await query(
        `INSERT INTO budget_audit
           (user_id, budget_id, category, amount, period, period_start,
            period_days, account_id, action, effective_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'create', ?)`,
        [b.user_id, b.id, b.category, b.amount, b.period, b.period_start,
         b.period_days, b.account_id, b.created_at]
      );
    }
    console.log(`Backfilled budget_audit: ${orphans.length} budget(s).`);
  }

  // ── Owner backfill ──────────────────────────────────────────────
  // Single-instance deployments need exactly one owner. If none exists
  // yet, promote the oldest admin. If there are also no admins (e.g. an
  // old deployment where the seed code never set role='admin' for the
  // first user — or that row was manually edited), fall through and
  // promote the lowest-id user instead. The "oldest user is the owner"
  // assumption matches the single-tenant pattern this app is built for.
  const existingOwner = await queryOne(
    "SELECT id FROM users WHERE role = 'owner' LIMIT 1"
  );
  if (!existingOwner) {
    let candidate = await queryOne(
      "SELECT id, email FROM users WHERE role = 'admin' ORDER BY id ASC LIMIT 1"
    );
    if (!candidate) {
      candidate = await queryOne(
        "SELECT id, email FROM users ORDER BY id ASC LIMIT 1"
      );
    }
    if (candidate) {
      await query("UPDATE users SET role = 'owner' WHERE id = ?", [candidate.id]);
      console.log(`Promoted first user (#${candidate.id} ${candidate.email}) to owner.`);
    }
  }

  await pool.end();
  console.log("Done.");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});