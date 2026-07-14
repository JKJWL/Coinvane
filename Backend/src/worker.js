// SPDX-License-Identifier: AGPL-3.0-or-later
import "dotenv/config";
import { Worker } from "bullmq";
import { fullSyncItem, syncTransactions, syncHoldings } from "./sync.js";
import { decrypt } from "./crypto.js";
import { query, queryOne, pool } from "./db.js";
import { sendMail } from "./mailer.js";
import { generateNotifications } from "./notification-engine.js";
import { syncQueue } from "./queue.js";
import { getSyncIntervalMinutes } from "./app-settings.js";

const connection = {
  host: process.env.REDIS_HOST || "redis",
  port: Number(process.env.REDIS_PORT || 6379),
};

// Sync interval is now stored in the `app_settings` table so an admin can
// change it without restarting the worker. The value falls back to
// SYNC_INTERVAL_MINUTES env when the row is missing. The worker still
// needs a restart for the new schedule to be picked up (we sweep + reseed
// repeatables on every startup); a future enhancement could subscribe to
// a Redis pub/sub channel for live updates.

async function schedulePeriodic() {
  // BullMQ repeatable jobs are keyed by a hash of their full schedule
  // signature (name + interval + jobId). If we just `add()` with a new
  // `repeat.every`, BullMQ will register a SECOND schedule alongside
  // the old one — both would fire forever. Sweep first, then re-add.
  const existing = await syncQueue.getRepeatableJobs();
  for (const r of existing) {
    if (r.name === "periodic-full-sync"
        || r.name === "daily-notifications"
        || r.name === "audit-log-cleanup"
        || r.name === "automation-history-cleanup") {
      await syncQueue.removeRepeatableByKey(r.key);
    }
  }

  const intervalMin = await getSyncIntervalMinutes();
  await syncQueue.add(
    "periodic-full-sync",
    { kind: "periodic" },
    { repeat: { every: intervalMin * 60 * 1000 }, jobId: "periodic-full-sync" }
  );
  console.log(`Scheduled periodic full sync every ${intervalMin} min.`);
  await syncQueue.add(
    "daily-notifications",
    { kind: "notifications" },
    { repeat: { pattern: "0 8 * * *" }, jobId: "daily-notifications" }
  );
  // Audit log gets pruned to a rolling 48h window so the table never grows
  // unbounded and the admin viewer stays cheap to query.
  await syncQueue.add(
    "audit-log-cleanup",
    { kind: "audit-cleanup" },
    { repeat: { pattern: "0 * * * *" }, jobId: "audit-log-cleanup" }
  );
  // Automation history retention. User-facing personal log so we're more
  // generous than the admin audit log: 30 days for non-error rows, and
  // 90 days for errors that the user has ACKNOWLEDGED (unacknowledged
  // errors stay indefinitely — they represent an unresolved sticky
  // pill on a transaction, and vanishing that from under the user
  // silently would be worse than the retention cost).
  await syncQueue.add(
    "automation-history-cleanup",
    { kind: "automation-cleanup" },
    { repeat: { pattern: "0 3 * * *" }, jobId: "automation-history-cleanup" }
  );
}

new Worker("sync", async (job) => {
  const { userId, itemId, kind } = job.data;

  if (kind === "periodic") {
    const items = await query("SELECT id, user_id, institution_name FROM plaid_items");
    for (const it of items) {
      try {
        const r = await fullSyncItem(it.user_id, it.id);
        // Log pending vs posted counts so the user can verify pending
        // transactions are actually arriving from each bank. If a bank
        // consistently shows `pending: 0` it likely doesn't push pending
        // to Plaid before posting — a bank-side limitation, not a bug.
        const t = r?.transactions || {};
        console.log(
          `[sync] item=${it.id} (${it.institution_name || "?"}) ` +
          `added=${t.added ?? 0} (posted=${t.posted ?? 0}, pending=${t.pending ?? 0}) ` +
          `modified=${t.modified ?? 0} removed=${t.removed ?? 0}`
        );
      } catch (e) {
        console.error(`periodic sync failed for item ${it.id}:`, e.message);
      }
    }
    return { ok: true, count: items.length };
  }

  if (kind === "notifications") {
    const users = await query("SELECT id FROM users");
    for (const u of users) {
      try { await generateNotifications(u.id); }
      catch (e) { console.error(`notifications failed for user ${u.id}:`, e.message); }
    }
    return { ok: true };
  }

  if (kind === "automation-cleanup") {
    // Non-error + acknowledged-error retention. Unacknowledged errors are
    // KEPT so the user can still find the row that surfaced their sticky
    // transaction pill.
    const routine = await query(
      `DELETE FROM automation_history
       WHERE status <> 'error'
         AND fired_at < DATE_SUB(NOW(), INTERVAL 30 DAY)`
    );
    const acked = await query(
      `DELETE FROM automation_history
       WHERE status = 'error' AND acknowledged = 1
         AND fired_at < DATE_SUB(NOW(), INTERVAL 90 DAY)`
    );
    const total = (routine.affectedRows || 0) + (acked.affectedRows || 0);
    if (total > 0) {
      console.log(`[automations] pruned ${routine.affectedRows} routine + ${acked.affectedRows} old-acked`);
    }
    return { ok: true, pruned: total };
  }

  if (kind === "audit-cleanup") {
    // Two-tier retention. Routine entries (sign-in success, allowlist
    // rejections, etc.) are pruned at 48 h. Major admin actions —
    // role changes, user deletes, bulk wipes — are flagged is_major=1
    // and kept for 7 days so an audit reviewer has a full week to spot
    // unauthorized escalation.
    const minor = await query(
      `DELETE FROM audit_log
       WHERE (is_major = 0 OR is_major IS NULL)
         AND created_at < DATE_SUB(NOW(), INTERVAL 48 HOUR)`
    );
    const major = await query(
      `DELETE FROM audit_log
       WHERE is_major = 1
         AND created_at < DATE_SUB(NOW(), INTERVAL 7 DAY)`
    );
    const total = (minor.affectedRows || 0) + (major.affectedRows || 0);
    if (total > 0) {
      console.log(`[audit] pruned ${minor.affectedRows} routine + ${major.affectedRows} major`);
    }
    return { ok: true, pruned: total };
  }

  const item = await queryOne("SELECT * FROM plaid_items WHERE id = ?", [itemId]);
  if (!item) throw new Error("Item not found");
  const token = decrypt(item.access_token_enc);

  // Wrap individual-item syncs with the same logging the periodic branch
  // does, so manual Sync-button presses and webhook-driven syncs also
  // surface pending/posted counts.
  const logResult = (r) => {
    const t = r?.transactions || (kind === "transactions" ? r : null);
    if (!t) return;
    console.log(
      `[sync] item=${itemId} (${item.institution_name || "?"}) kind=${kind} ` +
      `added=${t.added ?? 0} (posted=${t.posted ?? 0}, pending=${t.pending ?? 0}) ` +
      `modified=${t.modified ?? 0} removed=${t.removed ?? 0}`
    );
  };

  if (kind === "transactions") {
    const r = await syncTransactions(userId, itemId, token);
    logResult(r);
    return r;
  }
  if (kind === "holdings") return syncHoldings(userId, itemId, token);
  const r = await fullSyncItem(userId, itemId);
  logResult(r);
  return r;
}, { connection, concurrency: 4 });

new Worker("mail", async (job) => sendMail(job.data), { connection, concurrency: 2 });

console.log("Worker started.");
schedulePeriodic().catch(err => console.error("schedule error:", err));

process.on("SIGTERM", async () => { await pool.end(); process.exit(0); });