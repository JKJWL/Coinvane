import nodemailer from "nodemailer";

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;
  if (!process.env.SMTP_HOST) {
    console.warn("SMTP not configured; emails will be logged only.");
    return null;
  }
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: process.env.SMTP_USER ? {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    } : undefined,
  });
  return transporter;
}

export async function sendMail({ to, subject, html, text }) {
  const t = getTransporter();
  const from = process.env.SMTP_FROM || "Ledger <noreply@ledger.local>";
  if (!t) {
    console.log(`[mail:dev] To: ${to} | Subject: ${subject}\n${text || html}`);
    return { ok: true, dev: true };
  }
  const info = await t.sendMail({ from, to, subject, html, text });
  return { ok: true, messageId: info.messageId };
}

export function renderInviteEmail({ inviterName, link }) {
  return {
    subject: `${inviterName || "Someone"} invited you to Ledger`,
    text: `You've been invited to Ledger. Accept here: ${link}`,
    html: `<div style="font-family:system-ui,sans-serif;max-width:520px;margin:auto;padding:24px">
      <h2 style="color:#0f172a">You're invited to Ledger</h2>
      <p>${inviterName ? `<strong>${inviterName}</strong> invited you` : "You've been invited"} to join.</p>
      <p><a href="${link}" style="display:inline-block;background:#0ea5e9;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600">Accept invitation</a></p>
      <p style="color:#64748b;font-size:13px">Or paste this link: ${link}</p>
    </div>`,
  };
}

export function renderNotificationDigest({ userName, notifications }) {
  const items = notifications.map(n =>
    `<li style="margin:8px 0"><strong>${n.title}</strong><br/><span style="color:#64748b">${n.body || ""}</span></li>`
  ).join("");
  return {
    subject: `Your Ledger digest — ${notifications.length} update${notifications.length === 1 ? "" : "s"}`,
    text: notifications.map(n => `• ${n.title}\n  ${n.body || ""}`).join("\n\n"),
    html: `<div style="font-family:system-ui,sans-serif;max-width:520px;margin:auto;padding:24px">
      <h2 style="color:#0f172a">Hi ${userName || "there"},</h2>
      <p>Here's what's new in your finances:</p>
      <ul style="list-style:none;padding:0">${items}</ul>
      <p><a href="${process.env.APP_URL || "#"}" style="color:#0ea5e9">Open Ledger →</a></p>
    </div>`,
  };
}

export function renderPasswordResetEmail({ link }) {
  return {
    subject: "Reset your Ledger password",
    text: `Reset your password: ${link}`,
    html: `<div style="font-family:system-ui,sans-serif;max-width:520px;margin:auto;padding:24px">
      <h2>Reset your password</h2>
      <p><a href="${link}" style="display:inline-block;background:#0ea5e9;color:white;padding:12px 24px;border-radius:8px;text-decoration:none">Reset password</a></p>
      <p style="color:#64748b;font-size:13px">If you didn't request this, ignore this email.</p>
    </div>`,
  };
}