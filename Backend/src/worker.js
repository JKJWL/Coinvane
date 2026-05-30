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

async function schedulePeriodic() {
  await syncQueue.add(
    "periodic-full-sync",
    { kind: "periodic" },
    { repeat: { every: 6 * 60 * 60 * 1000 }, jobId: "periodic-full-sync" }
  );
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