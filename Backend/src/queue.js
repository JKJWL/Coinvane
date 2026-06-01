// SPDX-License-Identifier: AGPL-3.0-or-later
import { Queue } from "bullmq";

const connection = {
  host: process.env.REDIS_HOST || "redis",
  port: Number(process.env.REDIS_PORT || 6379),
};

export const syncQueue = new Queue("sync", { connection });
export const mailQueue = new Queue("mail", { connection });

export async function enqueueSync({ userId, itemId, kind = "transactions" }) {
  return syncQueue.add(
    `sync-${kind}-${itemId}`,
    { userId, itemId, kind },
    { attempts: 3, backoff: { type: "exponential", delay: 5000 }, removeOnComplete: 100, removeOnFail: 500 }
  );
}

export async function enqueueMail(payload) {
  return mailQueue.add("send", payload, {
    attempts: 5, backoff: { type: "exponential", delay: 30_000 },
    removeOnComplete: 100, removeOnFail: 500,
  });
}