# Vendored optional dependencies

This directory is where you drop optional runtime artifacts the backend
can use but that we don't want to build inside every Docker image.

## `sunriise.jar` (optional — enables encrypted `.mny` import)

Coinvane can import Microsoft Money `.mny` files via the built-in
`mdbtools` package. That covers files with no password. For
password-protected files you need `sunriise`, a community Java tool
that strips the password before extraction.

**How to add it:** drop the sunriise fat jar (jar-with-dependencies)
into this directory as `sunriise.jar`, then rebuild the backend
image:

```bash
docker compose build backend && docker compose up -d backend
```

The Dockerfile copies `vendor/sunriise.jar` into `/opt/sunriise.jar`
and the MNY importer picks it up automatically. If you skip this step
the backend still builds and unencrypted `.mny` files still import;
encrypted ones return an actionable error at import time.

Get the jar from any sunriise release page (as of writing,
<https://github.com/clmsoft/sunriise>). Any recent fat jar from a
maintained fork should work.

### License note

sunriise ships under **Apache 2.0**. Vendoring the jar inherits that
license for the file itself. It does **not** relicense Coinvane —
Apache 2.0 → AGPL v3 is a permitted one-way combination.