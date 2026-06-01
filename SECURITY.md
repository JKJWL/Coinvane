# Security Policy

Ledger is a self-hosted personal-finance app maintained by a single
person. It handles sensitive data (bank credentials via Plaid, transaction
history, encrypted notes), so I take vulnerability reports seriously and
will act on them quickly. This document explains what's in scope, how to
report something privately, and what you can expect back.

## Supported versions

| Version              | Supported               |
| -------------------- | ----------------------- |
| Latest `master` HEAD | ✅ Security fixes land here |
| Anything older       | ❌ Please update           |

There are no LTS branches. The expectation is that self-hosters keep their
deployment reasonably current — `git pull && docker compose build
--no-cache backend frontend && docker compose up -d && docker compose
exec backend npm run migrate` runs the full upgrade.

## Reporting a vulnerability

**Please do not open a public GitHub issue for security bugs.** Use one of
these private channels:

1. **GitHub Security Advisory (preferred)** — go to the
   [Security tab](https://github.com/JKJWL/Ledger/security/advisories/new)
   and click *Report a vulnerability*. This creates a private advisory
   that only the maintainer can see. GitHub will notify me automatically.

2. **Email** — if you'd rather not use GitHub, encrypted email is fine.
   Open an issue titled "Security contact request" (no details) and I'll
   reply with a current address.

When you report, please include:

- A clear description of the issue and its impact
- Steps to reproduce (or a proof-of-concept)
- The commit SHA / version you tested against
- Any suggested mitigation if you have one

## What you can expect

- **Acknowledgement within 72 hours** that I've received the report.
- **Initial assessment within 7 days** (severity, scope, repro confirmed).
- **Fix targeted within 30 days** for high/critical severity; lower
  severity issues are queued against normal maintenance.
- **Coordinated disclosure** — I'll work with you on a public disclosure
  timeline once a fix is ready and deployed. The default is 30 days post-fix
  unless we agree otherwise.
- **Credit** — if you'd like to be credited in the fix's commit message
  and the GitHub advisory, just say so when you report. Anonymous reports
  are also fine.

## Scope

### In scope
- The application code in this repository (Backend, Frontend, Worker)
- The Dockerfiles and `docker-compose.yml`
- The `nginx.conf` / `nginx-headers.conf` served by the frontend image
- `bootstrap.sh` and any helper scripts
- Documentation that, if followed, would lead to an insecure deploy

### Out of scope
- Vulnerabilities in **your specific deployment** (your VPS, your
  Caddyfile, your firewall rules, your domain DNS) — those are operator
  responsibilities; see the [Operator Responsibility](#operator-responsibility-self-hosters)
  section below.
- **Plaid, Google Sign-In, MariaDB, Redis, Caddy, nginx, Docker**, or any
  other upstream component — please report those to the respective
  upstream projects. I'll happily forward a report if you're unsure
  where it belongs.
- **Social engineering** of the maintainer.
- **Denial of service** via brute-force traffic to the public endpoint
  (rate-limiting + Caddy / fail2ban + your firewall handle this layer).
- **Vulnerabilities that require physical access** to the host machine
  hosting the deployment.
- Reports based on **automated scanner output without a working PoC**
  (especially "missing X-Powered-By header on a path that doesn't exist"
  style noise).

## Operator responsibility (self-hosters)

This project is designed to be run by individual operators on their own
infrastructure. **You are the system administrator for your deployment**,
which means *you* are responsible for:

- Keeping your VPS / OS patched
- SSH hardening (key-only auth, fail2ban, restricted source IPs)
- Firewall rules at the OS *and* cloud-provider level
- Your domain's DNS hygiene (no dangling CNAMEs to expired services, etc.)
- Backing up `ENCRYPTION_KEY` off-server (lose it, lose all encrypted data)
- Backing up `.backup-key` off-server
- Reviewing your Google OAuth allowlist (`ALLOWED_EMAILS`)
- Reviewing your Plaid webhook / redirect configuration
- Rotating any credentials if you suspect compromise
- Monitoring your own logs for anomalies

The application ships with sensible defaults (no client-side caching,
strict CSP, helmet, rate-limit, AES-256-GCM for tokens and notes, prepared
statements only, COOP/CORP, signed Plaid webhooks, allowlist-only sign-in)
but those defaults can only protect you if your underlying infrastructure
is sound. See the production deployment section of the
[README](README.md) for the recommended starting posture.

## No warranty

Ledger is licensed under the **GNU Affero General Public License v3.0**
(see [LICENSE](LICENSE)). Per the standard AGPL disclaimer:

> THIS PROGRAM IS PROVIDED "AS IS" WITHOUT WARRANTY OF ANY KIND, EITHER
> EXPRESSED OR IMPLIED, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
> WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE.

That's not me being dismissive — it's a personal-use project, not a
commercial product with a support contract. I will act on real
vulnerability reports as fast as I reasonably can, but I am not on call
and there is no SLA. If you need that level of guarantee for your
deployment, hire a security firm to audit and harden your fork.

## Thank you

Time spent finding and responsibly reporting vulnerabilities is genuinely
appreciated. Please don't be discouraged by the scope rules — when in
doubt, send the report.
