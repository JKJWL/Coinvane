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
    // ── Defense-in-depth flags (Nodemailer's documented sandboxing) ──
    // We never intentionally pass {path:…} or {href:…} content shapes, but
    // setting these at the transport level means a future contributor who
    // accidentally introduces such a code path can't turn it into arbitrary
    // file disclosure or SSRF. Every well-known advisory in this class
    // (GHSA-wqvq-jvpq-h66f, the raw-option bypass closed in 9.0.1) lists
    // "application sets disableFileAccess/disableUrlAccess on the
    // transporter" as the protective baseline — we set both, always.
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  return transporter;
}

// Strict allowlist of fields we accept from internal callers. Anything else
// is dropped before it reaches Nodemailer. The point isn't to scrub user
// input (callers are our own routes) — it's to make it structurally
// impossible for a future maintainer to feed `raw`, `attachments`,
// `icalEvent`, `watchHtml`, `amp`, `dkim`, etc. into sendMail without an
// explicit code change to this allowlist. Same posture every "untrusted
// input + sandbox flags" advisory in the Nodemailer ecosystem expects.
const ALLOWED_MAIL_FIELDS = ["from", "to", "subject", "html", "text"];

export async function sendMail(payload = {}) {
  // Hard kill-switch — controlled by EMAIL_CONFIG env var.
  if (!isEmailEnabled()) {
    console.log(`[mail:disabled] EMAIL_CONFIG=disabled. Would send to: ${payload.to} | Subject: ${payload.subject}`);
    return { ok: true, disabled: true };
  }

  // Rebuild the message from the allowlist — every other key is silently
  // dropped. This is the structural guarantee against raw-option bypass and
  // every related "untrusted shape" advisory.
  const message = {};
  for (const k of ALLOWED_MAIL_FIELDS) {
    if (payload[k] !== undefined) message[k] = payload[k];
  }
  // Type-check the four user-facing fields. Anything that isn't a plain
  // string is rejected so attacker-controlled objects like { path } /
  // { href } can never slip in even if a future caller forgot to coerce.
  for (const k of ["to", "subject", "html", "text"]) {
    if (message[k] !== undefined && typeof message[k] !== "string") {
      throw new Error(`mailer: field "${k}" must be a string, got ${typeof message[k]}`);
    }
  }

  const t = getTransporter();
  const from = process.env.SMTP_FROM || "Ledger <noreply@ledger.local>";
  message.from = message.from || from;
  if (!t) {
    console.log(`[mail:dev] To: ${message.to} | Subject: ${message.subject}\n${message.text || message.html}`);
    return { ok: true, dev: true };
  }

  // Paranoia-mode logging. Any throw from Nodemailer surfaces with the
  // full stack + the recipient (NOT the body, which can contain PII) so a
  // surprise 9.x regression — or an SMTP-side rejection — is debuggable
  // from `docker compose logs worker` without re-running the failing send.
  try {
    const info = await t.sendMail(message);
    return { ok: true, messageId: info.messageId };
  } catch (err) {
    console.error(`[mail:error] to=${message.to} subject="${message.subject}" — ${err?.message || err}`);
    if (err?.stack) console.error(err.stack);
    throw err;
  }
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
export function renderNotificationDigest({ userName, notifications, disclaimer }) {
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

  // When a disclaimer is supplied (e.g. for test emails), it gets:
  //  - prepended to the text/plain body
  //  - rendered as a yellow banner above the notification cards in HTML
  //  - tagged "[TEST]" in the subject so it's obvious in the inbox
  const subjectPrefix = disclaimer ? "[TEST] " : "";
  return {
    subject: `${subjectPrefix}Ledger — ${heading}`,
    text: [
      ...(disclaimer ? [`*** ${disclaimer} ***`, ""] : []),
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
          ${disclaimer ? `
          <div style="background:#fef3c7;border:1px solid #fde68a;border-radius:12px;padding:12px 14px;margin:0 0 18px 0;color:#92400e;font-size:13px;font-weight:600;line-height:1.45">
            ⚠ ${disclaimer}
          </div>` : ""}
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