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
    const items = await query("SELECT id, user_id FROM plaid_items");
    for (const it of items) {
      try { await fullSyncItem(it.user_id, it.id); }
      catch (e) { console.error(`periodic sync failed for item ${it.id}:`, e.message); }
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

  if (kind === "transactions") return syncTransactions(userId, itemId, token);
  if (kind === "holdings")     return syncHoldings(userId, itemId, token);
  return fullSyncItem(userId, itemId);
}, { connection, concurrency: 4 });

new Worker("mail", async (job) => sendMail(job.data), { connection, concurrency: 2 });

console.log("Worker started.");
schedulePeriodic().catch(err => console.error("schedule error:", err));

process.on("SIGTERM", async () => { await pool.end(); process.exit(0); });