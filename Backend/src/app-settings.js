// SPDX-License-Identifier: AGPL-3.0-or-later
import { query, queryOne } from "./db.js";

/**
 * DB-backed admin settings. Each key is read from `app_settings`; if the
 * row is missing or empty, we fall back to the matching environment
 * variable so existing deployments work without a manual seed step.
 *
 * Currently exposed keys:
 *   sync_interval_minutes — overrides SYNC_INTERVAL_MINUTES
 *   allowed_emails        — overrides ALLOWED_EMAILS (CSV)
 */
export async function getAppSetting(key, fallbackEnv) {
  const row = await queryOne(
    "SELECT `value` FROM app_settings WHERE `key` = ?",
    [key]
  );
  const v = row?.value;
  if (v !== undefined && v !== null && String(v).length > 0) return String(v);
  return fallbackEnv !== undefined ? process.env[fallbackEnv] : null;
}

export async function setAppSetting(key, value) {
  await query(
    `INSERT INTO app_settings (\`key\`, \`value\`) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE \`value\` = VALUES(\`value\`)`,
    [key, value == null ? null : String(value)]
  );
}

export async function getSyncIntervalMinutes() {
  const v = await getAppSetting("sync_interval_minutes", "SYNC_INTERVAL_MINUTES");
  return Math.max(1, Number(v) || 60);
}

export async function getAllowedEmails() {
  const v = await getAppSetting("allowed_emails", "ALLOWED_EMAILS");
  return (v || "")
    .split(",")
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
}
