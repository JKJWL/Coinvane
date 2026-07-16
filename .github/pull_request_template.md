<!--
  Please read CONTRIBUTING.md before opening a PR. Short version:
    - One feature / bug / refactor per PR
    - SPDX header on any new source file
    - Prepared statements only, no string-concatenated SQL
    - Migrations idempotent (CREATE TABLE IF NOT EXISTS, ALTER ... IF NOT EXISTS)
    - No secrets in commits — ever
-->

## What problem does this solve?

<!-- One sentence. What was broken / missing / awkward before this change? -->

## What does this change do?

<!--
  Bullet list of the actual code changes. Skip if the diff is small
  enough to speak for itself.
-->

- 
- 

## How did you test it?

<!--
  Concrete steps you ran locally. "It compiles" is not testing.
  For frontend changes, please note browser + whether you tested
  mobile viewport too.
-->

- [ ] Ran `docker compose exec backend npm run migrate` (if schema changed)
- [ ] Verified the changed flow end-to-end in a browser
- [ ] Checked mobile viewport (if UI changed)
- [ ] Did not check in any `.env`, secret, or real bank / financial data

## Anything else?

<!-- Screenshots, follow-up work, callouts for the reviewer, etc. -->
