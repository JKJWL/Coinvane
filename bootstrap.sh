#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# ─────────────────────────────────────────────────────────────────────
#  Coinvane — first-time .env generator
#  Generates all secrets, asks about every optional feature (Google,
#  Microsoft, one-time-link, Plaid, SMTP, Web Push), writes .env with
#  secure perms (600). Everything except the DB + JWT + ENCRYPTION_KEY
#  is optional — enable only what you want.
#
#  Usage:  ./bootstrap.sh
#  Re-run: delete .env first, then re-run (we refuse to overwrite).
# ─────────────────────────────────────────────────────────────────────
set -euo pipefail

ENV_FILE=".env"

if [[ -f "$ENV_FILE" ]]; then
  echo "❌ $ENV_FILE already exists."
  echo "   Refusing to overwrite — back it up (especially ENCRYPTION_KEY!) then delete it."
  exit 1
fi

command -v openssl >/dev/null || { echo "openssl not installed"; exit 1; }

# Small helper: prompt yes/no, default is second arg ("y"/"n"), echoes "y" or "n"
ask_yn() {
  local prompt="$1" default="${2:-n}" reply
  local suffix="[y/N]"
  [[ "$default" == "y" ]] && suffix="[Y/n]"
  read -rp "  $prompt $suffix " reply
  reply="${reply:-$default}"
  case "$reply" in
    [Yy]*) echo "y" ;;
    *)     echo "n" ;;
  esac
}

echo "→ Generating cryptographically random secrets..."
DB_ROOT_PASSWORD=$(openssl rand -base64 32 | tr -d '\n=+/')
DB_PASSWORD=$(openssl rand -base64 32     | tr -d '\n=+/')
JWT_SECRET=$(openssl rand -hex 64)
ENCRYPTION_KEY=$(openssl rand -hex 32)   # 32 bytes = 64 hex chars

echo
echo "═══════════════════════════════════════════════════════════════════"
echo "  Coinvane setup — this script asks about every optional feature"
echo "  so you can enable only what you want. Press Enter to skip any"
echo "  optional prompt; you can always enable a feature later by"
echo "  editing .env and rebuilding."
echo "═══════════════════════════════════════════════════════════════════"
echo
echo "→ Required: your domain"
read -rp "  Domain (e.g. coinvane.example.com — without https://; use \"localhost:8080\" for local dev): " DOMAIN

if [[ -z "$DOMAIN" ]]; then
  echo "❌ Domain is required (used for CORS_ORIGIN, APP_URL, and email links)."
  exit 1
fi

# Guess http vs https from the input — bare localhost/dev doesn't have TLS
SCHEME="https"
case "$DOMAIN" in
  localhost*|127.0.0.1*|0.0.0.0*|*.local*) SCHEME="http" ;;
esac
APP_URL="${SCHEME}://${DOMAIN}"

# ── Email allowlist ─────────────────────────────────────────────────
echo
echo "→ Email allowlist"
echo "  Comma-separated list of emails allowed to sign in via any"
echo "  method (Google/Microsoft/one-time-link). Anyone else is"
echo "  rejected with 403. Blank = anyone with a supported sign-in"
echo "  method can register (NOT recommended for public deployments)."
read -rp "  Allowlist (blank to skip, or e.g. \"me@example.com, partner@example.com\"): " ALLOWED_EMAILS

# ── Sign-in methods (must have at least one) ────────────────────────
echo
echo "→ Sign-in methods — pick at least one"
echo "  Every method uses the email allowlist above. All three dedupe"
echo "  on email so a user can switch between them without creating"
echo "  duplicate accounts. You can add more methods later."
echo

GOOGLE_CLIENT_ID=""
MICROSOFT_CLIENT_ID=""
ENABLE_OTL="n"

# --- Google ---
if [[ "$(ask_yn "Enable Google Sign-In?" "y")" == "y" ]]; then
  echo "     https://console.cloud.google.com/apis/credentials"
  echo "     (OAuth 2.0 Client ID → Web application; JS origins = $APP_URL)"
  read -rp "  Google OAuth Client ID (xxxxx.apps.googleusercontent.com): " GOOGLE_CLIENT_ID
fi

# --- Microsoft ---
echo
if [[ "$(ask_yn "Enable Microsoft Sign-In (Entra ID + personal MSA)?" "n")" == "y" ]]; then
  echo "     https://portal.azure.com → App registrations → New registration"
  echo "     Platform: Single-page application, redirect URI = ${APP_URL}/auth"
  read -rp "  Microsoft Entra Application (client) ID: " MICROSOFT_CLIENT_ID
fi

# --- One-Time Link ---
echo
if [[ "$(ask_yn "Enable Sign-in-with-a-one-time-link (email-based passwordless)?" "n")" == "y" ]]; then
  echo "     Requires working SMTP below — the /request endpoint returns"
  echo "     503 if EMAIL_CONFIG=disabled. You'll be asked about SMTP next."
  ENABLE_OTL="y"
fi

# --- Sanity check: at least one method ---
if [[ -z "$GOOGLE_CLIENT_ID" && -z "$MICROSOFT_CLIENT_ID" && "$ENABLE_OTL" != "y" ]]; then
  echo
  echo "❌ You must enable at least one sign-in method (Google, Microsoft, or one-time-link)."
  echo "   Re-run bootstrap.sh and pick at least one."
  exit 1
fi

# ── SMTP + email ────────────────────────────────────────────────────
echo
echo "→ Email subsystem"
echo "  Used for notification digests + one-time sign-in links + test"
echo "  emails from the admin panel. Skip if you don't want any email."
SMTP_HOST=""
SMTP_PORT="587"
SMTP_USER=""
SMTP_PASS=""
EMAIL_CONFIG="disabled"
if [[ "$ENABLE_OTL" == "y" ]] || [[ "$(ask_yn "Configure SMTP now?" "n")" == "y" ]]; then
  EMAIL_CONFIG="enabled"
  echo "     Compatible with Resend, Postmark, SES, Mailgun, Gmail app-passwords, or your own SMTP."
  read -rp "  SMTP host (e.g. smtp.resend.com; blank = log to console for testing): " SMTP_HOST
  if [[ -n "$SMTP_HOST" ]]; then
    read -rp "  SMTP port [587]: " SMTP_PORT_IN
    SMTP_PORT="${SMTP_PORT_IN:-587}"
    read -rp "  SMTP username: " SMTP_USER
    read -rsp "  SMTP password (input hidden): " SMTP_PASS
    echo
  fi
fi

# ── Plaid ───────────────────────────────────────────────────────────
echo
echo "→ Plaid bank sync (optional — Coinvane can run manual-only)"
echo "  Skip this to disable every Plaid affordance in the UI. You'll"
echo "  still get manual entry, CSV/QIF/OFX/QFX/.mny import, and .cvn"
echo "  restore — enough for a full personal-finance experience with"
echo "  zero external service dependency."
PLAID_CLIENT_ID=""
PLAID_SECRET=""
PLAID_ENABLED="false"
if [[ "$(ask_yn "Enable Plaid?" "n")" == "y" ]]; then
  PLAID_ENABLED="true"
  echo "     Get keys at https://dashboard.plaid.com → Team Settings → Keys"
  read -rp "  Plaid Client ID: " PLAID_CLIENT_ID
  read -rsp "  Plaid Production Secret (input hidden; use the sandbox secret if you're testing): " PLAID_SECRET
  echo
fi

# ── Web Push ────────────────────────────────────────────────────────
echo
echo "→ Web Push (OS-level lock-screen notifications) — optional"
echo "  Skip if you don't want push. Rest of the app works normally."
VAPID_PUBLIC_KEY=""
VAPID_PRIVATE_KEY=""
if [[ "$(ask_yn "Enable Web Push?" "n")" == "y" ]]; then
  echo "     Generating VAPID key pair via docker (needs docker on the PATH)..."
  if command -v docker >/dev/null 2>&1; then
    VAPID_OUTPUT=$(docker run --rm node:20-alpine npx --yes web-push generate-vapid-keys 2>/dev/null || true)
    VAPID_PUBLIC_KEY=$(echo "$VAPID_OUTPUT"  | grep -Eo 'Public Key:[[:space:]]*[A-Za-z0-9_-]+' | awk '{print $NF}')
    VAPID_PRIVATE_KEY=$(echo "$VAPID_OUTPUT" | grep -Eo 'Private Key:[[:space:]]*[A-Za-z0-9_-]+' | awk '{print $NF}')
    if [[ -n "$VAPID_PUBLIC_KEY" && -n "$VAPID_PRIVATE_KEY" ]]; then
      echo "     ✓ VAPID keys generated."
    else
      echo "     ⚠ VAPID auto-generation failed. Run this later and paste into .env:"
      echo "         docker run --rm node:20-alpine npx --yes web-push generate-vapid-keys"
    fi
  else
    echo "     ⚠ docker not on PATH. Run this later and paste the two keys into .env:"
    echo "         docker run --rm node:20-alpine npx --yes web-push generate-vapid-keys"
  fi
fi

# ── Write .env ──────────────────────────────────────────────────────
cat > "$ENV_FILE" <<EOF
# ─────────────────────────────────────────────────────────────────────
# Generated by bootstrap.sh on $(date -u +"%Y-%m-%d %H:%M:%S UTC")
# DO NOT COMMIT THIS FILE TO GIT.
# ─────────────────────────────────────────────────────────────────────
NODE_ENV=production

# ─── Domain ──────────────────────────────────────────────────────
APP_URL=${APP_URL}
CORS_ORIGIN=${APP_URL}

# ─── Database ────────────────────────────────────────────────────
DB_NAME=coinvane
DB_USER=coinvane
DB_ROOT_PASSWORD=${DB_ROOT_PASSWORD}
DB_PASSWORD=${DB_PASSWORD}

# ─── Auth secrets ────────────────────────────────────────────────
# ⚠  ENCRYPTION_KEY: if lost, ALL encrypted data is unrecoverable
#    (Plaid access tokens, encrypted note content).
JWT_SECRET=${JWT_SECRET}
ENCRYPTION_KEY=${ENCRYPTION_KEY}

# ─── Email allowlist ─────────────────────────────────────────────
# Comma-separated list of emails allowed to sign in via any method.
ALLOWED_EMAILS=${ALLOWED_EMAILS}

# ─── Google SSO (optional) ───────────────────────────────────────
# Blank client id = Google button hidden on the login page.
# GOOGLE_SSO_ENABLED=false forces disable even with a client id set.
GOOGLE_CLIENT_ID=${GOOGLE_CLIENT_ID}
VITE_GOOGLE_CLIENT_ID=${GOOGLE_CLIENT_ID}
GOOGLE_SSO_ENABLED=

# ─── Microsoft SSO (optional) ────────────────────────────────────
# Blank = feature hidden. See .env.example for the app-registration
# walkthrough. Both vars take the same Application (client) ID.
# MICROSOFT_SSO_ENABLED=false forces disable even with a client id.
# MICROSOFT_TENANT: common | consumers | organizations | <tenant-guid>
MICROSOFT_CLIENT_ID=${MICROSOFT_CLIENT_ID}
VITE_MICROSOFT_CLIENT_ID=${MICROSOFT_CLIENT_ID}
MICROSOFT_SSO_ENABLED=
MICROSOFT_TENANT=common
MICROSOFT_REDIRECT_URI=
VITE_MICROSOFT_REDIRECT_URI=

# ─── Plaid (optional) ────────────────────────────────────────────
# PLAID_ENABLED=false runs Coinvane as a manual-only budgeting app:
#   • frontend hides every Plaid affordance
#   • backend 404s every /api/plaid/* route
#   • worker skips scheduling periodic-full-sync
# You can still add manual accounts, import QIF/OFX/QFX/.mny/.cvn, etc.
PLAID_ENABLED=${PLAID_ENABLED}
PLAID_CLIENT_ID=${PLAID_CLIENT_ID}
PLAID_SECRET=${PLAID_SECRET}
PLAID_ENV=production
PLAID_REDIRECT_URI=${APP_URL}/
PLAID_WEBHOOK_URL=${APP_URL}/api/plaid/webhook

# How often the worker polls Plaid for new transactions, in minutes.
# Webhook-driven syncs fire instantly regardless of this value. Going
# below ~15 min mostly burns Plaid API quota — see .env.example.
SYNC_INTERVAL_MINUTES=60

# ─── Misc ────────────────────────────────────────────────────────
# Signup mode: "open" (default), "invite", or "closed".
# "closed" = existing users can still sign in but no new accounts.
SIGNUP_MODE=open

# ─── Sign in with a one-time link (optional) ─────────────────────
# Requires EMAIL_CONFIG=enabled + working SMTP. Google/Microsoft users
# can still use the link — all three methods dedupe on email.
ONE_TIME_LINK_ENABLED=$([[ "$ENABLE_OTL" == "y" ]] && echo "true" || echo "false")

# Bind the one-time link to the requesting IP. true (default) requires
# the same public IP on click as on request — blocks stolen-email
# replay from a different network but breaks cross-device flow
# (request desktop, click phone). Set to false if your users are on
# mobile networks or need cross-device.
ONE_TIME_LINK_STRICT_IP=true

# ─── Email subsystem ──────────────────────────────────────────────
# disabled = no emails sent. Set to "enabled" to actually send.
# UI greys out Email Notifs whenever this is disabled.
EMAIL_CONFIG=${EMAIL_CONFIG}

# SMTP (only used when EMAIL_CONFIG=enabled; leave SMTP_HOST blank for dev logs)
SMTP_HOST=${SMTP_HOST}
SMTP_PORT=${SMTP_PORT}
SMTP_USER=${SMTP_USER}
SMTP_PASS=${SMTP_PASS}
SMTP_FROM=Coinvane <noreply@${DOMAIN}>

# ─── Web Push (OS-level notifications, optional) ─────────────────
# Blank = push silently disabled. Rest of the app works normally.
# Generate a key pair with:
#     docker run --rm node:20-alpine npx --yes web-push generate-vapid-keys
VAPID_PUBLIC_KEY=${VAPID_PUBLIC_KEY}
VAPID_PRIVATE_KEY=${VAPID_PRIVATE_KEY}
# Instance-wide operator contact — used ONLY by push services (FCM /
# Apple / Mozilla) to reach whoever runs this server about abuse or
# delivery issues. End users never see it. Defaults to the app's own
# URL, which is fine for most self-hosters. If you'd rather a mailbox,
# change to mailto:you@${DOMAIN}.
VAPID_SUBJECT=${APP_URL}
EOF

chmod 600 "$ENV_FILE"

echo
echo "✓ $(pwd)/$ENV_FILE created (chmod 600)"
echo
echo "═══════════════════════════════════════════════════════════════════"
echo "  ⚠  BACK UP YOUR ENCRYPTION_KEY NOW:"
echo
echo "     ${ENCRYPTION_KEY}"
echo
echo "  Save this in a password manager. If you lose it, all Plaid"
echo "  access tokens and encrypted note content become unrecoverable."
echo "═══════════════════════════════════════════════════════════════════"
echo
echo "Enabled features summary:"
[[ -n "$GOOGLE_CLIENT_ID"    ]] && echo "  • Google SSO"
[[ -n "$MICROSOFT_CLIENT_ID" ]] && echo "  • Microsoft SSO (tenant scope: common — edit MICROSOFT_TENANT in .env to narrow)"
[[ "$ENABLE_OTL" == "y"      ]] && echo "  • Sign in with a one-time link"
[[ "$PLAID_ENABLED" == "true" ]] && echo "  • Plaid bank sync"
[[ "$EMAIL_CONFIG" == "enabled" ]] && echo "  • Email subsystem (SMTP=${SMTP_HOST:-console})"
[[ -n "$VAPID_PUBLIC_KEY"    ]] && echo "  • Web Push"
echo
echo "Next steps:"
echo "  1. docker compose build"
echo "  2. docker compose up -d"
echo "  3. docker compose exec backend npm run migrate"
echo "  4. Open ${APP_URL} and sign in — the first sign-in becomes the owner."
