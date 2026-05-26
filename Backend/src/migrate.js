import "dotenv/config";
import bcrypt from "bcrypt";
import { pool, query, queryOne } from "./db.js";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NULL,
    google_id VARCHAR(64) UNIQUE,
    picture VARCHAR(512),
    name VARCHAR(255),
    role ENUM('admin','user') DEFAULT 'user',
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
  `ALTER TABLE users MODIFY COLUMN password_hash VARCHAR(255) NULL`,
  // Income tracker (Feature 4)
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS income_period VARCHAR(32) DEFAULT 'monthly'`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS income_period_days INT NULL`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS income_period_start DATE NULL`,
  // Credit usage tracker (Feature 4)
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS credit_period VARCHAR(32) DEFAULT 'monthly'`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS credit_period_days INT NULL`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS credit_period_start DATE NULL`,

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
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE KEY uq_user_merchant (user_id, merchant)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

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
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

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

  `CREATE TABLE IF NOT EXISTS invitations (
    id INT AUTO_INCREMENT PRIMARY KEY,
    email VARCHAR(255) NOT NULL,
    token VARCHAR(128) UNIQUE NOT NULL,
    invited_by INT,
    accepted BOOLEAN DEFAULT FALSE,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (invited_by) REFERENCES users(id) ON DELETE SET NULL,
    INDEX idx_token (token),
    INDEX idx_email (email)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS password_resets (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    token VARCHAR(128) UNIQUE NOT NULL,
    used BOOLEAN DEFAULT FALSE,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_token (token)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS audit_log (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NULL,
    action VARCHAR(64) NOT NULL,
    ip VARCHAR(45),
    user_agent VARCHAR(255),
    metadata TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_user_time (user_id, created_at),
    INDEX idx_action_time (action, created_at)
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

  const email = process.env.INITIAL_USER_EMAIL;
  const password = process.env.INITIAL_USER_PASSWORD;
  if (email && password) {
    const existing = await queryOne("SELECT id FROM users WHERE email = ?", [email]);
    if (!existing) {
      const hash = await bcrypt.hash(password, 12);
      const result = await query(
        "INSERT INTO users (email, password_hash, name, role) VALUES (?, ?, ?, 'admin')",
        [email, hash, email.split("@")[0]]
      );
      const userId = result.insertId;
      for (const [name, color, icon] of DEFAULT_CATEGORIES) {
        await query(
          "INSERT IGNORE INTO categories (user_id, name, color, icon, custom) VALUES (?, ?, ?, ?, FALSE)",
          [userId, name, color, icon]
        );
      }
      console.log(`Created admin user: ${email}`);
    } else {
      console.log(`Admin user already exists: ${email}`);
    }
  }

  await pool.end();
  console.log("Done.");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});