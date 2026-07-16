# Contributing to Coinvane

Thanks for taking a look. Before you open an issue or PR, please read this
whole page — it's short, and it will save both of us time.

## Project scope

Coinvane is a **self-hosted personal finance app for one person or a small
household**. It is deliberately *not*:

- a multi-tenant SaaS
- a team / small-business accounting tool
- a general-purpose ledger with plug-in modules
- a cryptocurrency wallet or DeFi tracker

Decisions that only make sense at those scales — organisation membership,
role-based access beyond Owner/Admin/Member, multi-currency ledgers,
per-tenant data isolation beyond the current single-tenant model — are
outside scope by design. Please don't be surprised if a PR in that direction
is politely declined.

## Before opening an issue

- **Bug reports** — please use the issue template and include the commit SHA
  you tested against, your browser + OS, reproduction steps, and what you
  expected vs. what happened. Reports that don't include a version are the
  first thing I have to ask about, so pre-empting that speeds up the fix.
- **Security issues** — do **not** open a public issue. Follow the process
  in [SECURITY.md](SECURITY.md) — private GitHub Security Advisory
  preferred.
- **Feature ideas** — open a [GitHub Discussion](../../discussions) first,
  not an issue. If we agree it fits the scope above, then it becomes an
  issue and (eventually) a PR.
- **"Please add X to compete with Quicken / YNAB / Mint"** — most likely
  declined unless X is a workflow a single-person / small-household user
  would use daily. See [scope](#project-scope) above.

## Before opening a pull request

- **Small, focused PRs get merged fast. Sprawling PRs get lost.** One
  feature, one bug, one refactor per PR.
- **Match the existing style.** The whole frontend is a single ~9000-line
  `App.jsx` on purpose — please don't split it. See
  [.claude/CLAUDE.md](/) for the "why" if you have local access, or just
  observe the pattern in `Frontend/src/App.jsx`.
- **SPDX header on every new source file** — line 1 (or line 2 if the
  file has a required preamble like `<!DOCTYPE>` or a shebang):
    ```
    // SPDX-License-Identifier: AGPL-3.0-or-later
    ```
- **Prepared statements only** on the backend. Every DB query goes through
  `mysql2.execute` with `?` placeholders. No string concatenation into
  SQL — ever. Existing code is clean; keep it that way.
- **Migrations are idempotent.** `migrate.js` uses `CREATE TABLE IF NOT
  EXISTS` and `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`. If your PR
  adds a schema change, follow that pattern so `npm run migrate` stays
  safe to re-run on any deployed instance.
- **Do NOT check secrets into git**, ever. Don't commit `.env`, don't
  commit generated `ENCRYPTION_KEY` values, don't commit real Plaid keys.
  If you accidentally do, please email me privately (see
  [SECURITY.md](SECURITY.md)) before pushing — I can help scrub the
  history.
- **User-facing text**: no example strings drawn from real financial
  data. Placeholders should be generic ("Company name", "Utility bill"),
  not "Verizon" or "Ameriprise" or bank-specific merchant strings.

## PR review posture

I'm the single maintainer and I do this in my spare time. Expect:

- **Acknowledgement within a few days** that I've seen the PR.
- **Review round within ~2 weeks** for reasonably-scoped PRs.
- **Larger PRs may sit longer** while I find the time to review them
  properly. Please don't take a slow review as disinterest — small,
  focused PRs get merged much faster than large ones.
- **Requests for scope reduction** are common. If a PR does two things,
  I'll usually ask to split it into two PRs.

## License agreement

By opening a PR you agree that your contribution is licensed under the
**GNU Affero General Public License v3.0** (the project license). No CLA
to sign — the AGPL header on the file you're editing is the whole
agreement.

## Code of conduct

By participating you agree to abide by the [Code of Conduct](CODE_OF_CONDUCT.md).

## Thanks

The project is intentionally small in scope, but that doesn't mean
contributions aren't appreciated. Bug reports and small quality-of-life
PRs are especially welcome.
