// SPDX-License-Identifier: AGPL-3.0-or-later
import nodemailer from "nodemailer";

let transporter = null;

/**
 * Email is gated by EMAIL_CONFIG. Set EMAIL_CONFIG=enabled to allow sending.
 * Any other value (or unset) means the email subsystem is disabled at the
 * code level — even if SMTP creds happen to be present, no mail goes out.
 *
 * This gate exists so a user can leave SMTP config in their .env (e.g. for
 * forks of the project) without accidentally enabling email until they're
 * explicitly ready to use it.
 */
export function isEmailEnabled() {
  return String(process.env.EMAIL_CONFIG || "").toLowerCase() === "enabled";
}

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
  // Hard kill-switch — controlled by EMAIL_CONFIG env var.
  if (!isEmailEnabled()) {
    console.log(`[mail:disabled] EMAIL_CONFIG=disabled. Would send to: ${to} | Subject: ${subject}`);
    return { ok: true, disabled: true };
  }

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

/**
 * Notification email — branded monthly digest.
 *
 * Color-codes each notification by its `color` field:
 *   "red" / "rose"   → over budget
 *   "amber"          → approaching limit / large transaction
 *   "emerald"        → goal completed
 *   "blue" / "sky"   → goal milestone
 *
 * Renders both HTML (rich) and plaintext (fallback for clients that don't
 * support HTML or for accessibility readers).
 */
export function renderNotificationDigest({ userName, notifications }) {
  const appUrl = process.env.APP_URL || "https://ledger.local";
  const palette = {
    red:     { dot: "#ef4444", bg: "#fef2f2", text: "#b91c1c" },
    rose:    { dot: "#f43f5e", bg: "#fff1f2", text: "#be123c" },
    amber:   { dot: "#f59e0b", bg: "#fffbeb", text: "#b45309" },
    emerald: { dot: "#10b981", bg: "#ecfdf5", text: "#047857" },
    sky:     { dot: "#0ea5e9", bg: "#f0f9ff", text: "#0369a1" },
    blue:    { dot: "#3b82f6", bg: "#eff6ff", text: "#1d4ed8" },
  };

  const items = notifications.map(n => {
    const c = palette[n.color] || palette.sky;
    return `
      <tr><td style="padding:0 0 12px 0">
        <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#ffffff;border:1px solid #e2e8f0;border-radius:14px;border-left:4px solid ${c.dot}">
          <tr>
            <td style="padding:14px 16px">
              <div style="font-size:14px;font-weight:600;color:#0f172a;margin:0 0 4px 0">${n.title}</div>
              ${n.body ? `<div style="font-size:13px;color:#64748b;line-height:1.45">${n.body}</div>` : ""}
            </td>
          </tr>
        </table>
      </td></tr>`;
  }).join("");

  const heading = notifications.length === 1
    ? "1 new notification"
    : `${notifications.length} new notifications`;

  return {
    subject: `Ledger — ${heading}`,
    text: [
      `Hi ${userName || "there"},`,
      "",
      `You have ${heading} from Ledger:`,
      "",
      ...notifications.map(n => `• ${n.title}${n.body ? "\n  " + n.body : ""}`),
      "",
      `Open Ledger: ${appUrl}`,
      "",
      "— You're receiving this because email notifications are enabled.",
      "Turn off in Settings → Profile → Email Notifs.",
    ].join("\n"),
    html: `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
  <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f8fafc;padding:32px 16px">
    <tr><td align="center">
      <table cellpadding="0" cellspacing="0" border="0" width="560" style="max-width:560px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 1px 3px rgba(15,23,42,.05)">
        <!-- Header band -->
        <tr><td style="background:linear-gradient(135deg,#34d399 0%,#059669 100%);padding:24px 28px;color:#ffffff">
          <table cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td style="background:#ffffff;border-radius:8px;width:36px;height:36px;text-align:center;vertical-align:middle;font-size:20px;font-weight:700;color:#059669">$</td>
              <td style="padding-left:12px;font-size:18px;font-weight:700;letter-spacing:-0.02em">Ledger</td>
            </tr>
          </table>
        </td></tr>

        <!-- Body -->
        <tr><td style="padding:28px">
          <div style="font-size:18px;font-weight:600;color:#0f172a;margin:0 0 6px 0">Hi ${userName || "there"},</div>
          <div style="font-size:14px;color:#64748b;margin:0 0 20px 0">You have ${heading}.</div>

          <table cellpadding="0" cellspacing="0" border="0" width="100%">${items}</table>

          <div style="margin-top:24px">
            <a href="${appUrl}" style="display:inline-block;background:#10b981;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;padding:11px 22px;border-radius:10px">Open Ledger →</a>
          </div>
        </td></tr>

        <!-- Footer -->
        <tr><td style="padding:18px 28px;border-top:1px solid #e2e8f0;font-size:12px;color:#94a3b8;line-height:1.5">
          You're receiving this because <strong>Email Notifs</strong> are enabled.
          Turn them off in Settings → Profile.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`,
  };
}