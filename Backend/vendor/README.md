# Vendored optional dependencies

This directory is where you drop artifacts the backend can *optionally*
use but that we don't want to depend on a live network fetch at Docker
build time.

## `sunriise.jar` (optional — enables encrypted `.mny` import)

Coinvane can import Microsoft Money `.mny` files via the built-in
`mdbtools`. That covers files with no password. For password-protected
files you need `sunriise`, a community Java tool that strips the
password before extraction. sunriise is Apache 2.0-licensed and
compatible with Coinvane's AGPL v3 license.

**If `vendor/sunriise.jar` is not present, the backend builds fine and
`.mny` import still works on unencrypted files**; encrypted files
will return an actionable error at import time telling the user to
unlock externally.

### Building the jar

Run the helper script once from the repo root:

```bash
Backend/scripts/build-sunriise.sh
```

The script spins up a throwaway Maven/JDK container, clones any active
sunriise fork you point it at (via `SUNRIISE_REPO` env var, default
matches the most-forked mirror), runs `mvn package`, and drops the
resulting fat jar at `Backend/vendor/sunriise.jar`. From then on
`docker compose build backend` includes it automatically.

If the default repo URL is dead, edit the script or override:

```bash
SUNRIISE_REPO=https://github.com/<some-fork>/sunriise.git \
  Backend/scripts/build-sunriise.sh
```

### License note

sunriise ships under Apache 2.0. When you vendor its jar you inherit
that license for the file itself. It does **not** relicense Coinvane —
Apache 2.0 → AGPL v3 is a permitted one-way combination.
</content>
</invoke>