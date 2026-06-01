// SPDX-License-Identifier: AGPL-3.0-or-later
import "dotenv/config";
import { Worker } from "bullmq";
import { fullSyncItem, syncTransactions, syncHoldings } from "./sync.js";
import { decrypt } from "./crypto.js";
import { query, queryOne, pool } from "./db.js";
import { sendMail } from "./mailer.js";
import { generateNotifications } from "./notification-engine.js";
import { syncQueue } from "./queue.js";

const connection = {
  host: process.env.REDIS_HOST || "redis",
  port: Number(process.env.REDIS_PORT || 6379),
};

// How often the periodic full sync runs, in minutes. Tunable via env so
// the cadence can be adjusted without redeploying code. Default is 60
// minutes; Plaid's general guidance is 4-6 hours for polling, but more
// frequent is reasonable as a safety net for missed webhooks. Going
// below ~15 min is rarely useful — banks themselves don't push to
// Plaid faster than that, and you'll just burn Plaid API quota.
// Webhook-driven syncs continue to fire regardless of this interval.
const SYNC_INTERVAL_MIN = Math.max(
  1,
  Number(process.env.SYNC_INTERVAL_MINUTES) || 60
);

async function schedulePeriodic() {
  // BullMQ repeatable jobs are keyed by a hash of their full schedule
  // signature (name + interval + jobId). If we just `add()` with a new
  // `repeat.every`, BullMQ will register a SECOND schedule alongside
  // the old one — both would fire forever. To make the env var
  // hot-swappable across restarts, sweep any existing periodic-sync
  // repeatables first, then add the one matching the current env.
  const existing = await syncQueue.getRepeatableJobs();
  for (const r of existing) {
    if (r.name === "periodic-full-sync" || r.name === "daily-notifications") {
      await syncQueue.removeRepeatableByKey(r.key);
    }
  }

  await syncQueue.add(
    "periodic-full-sync",
    { kind: "periodic" },
    { repeat: { every: SYNC_INTERVAL_MIN * 60 * 1000 }, jobId: "periodic-full-sync" }
  );
  console.log(`Scheduled periodic full sync every ${SYNC_INTERVAL_MIN} min.`);
  await syncQueue.add(
    "daily-notifications",
    { kind: "notifications" },
    { repeat: { pattern: "0 8 * * *" }, jobId: "daily-notifications" }
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