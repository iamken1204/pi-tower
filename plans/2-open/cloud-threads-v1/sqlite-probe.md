# Cloud threads SQLite phase-0 probe

Status: historical record from 2026-09-14. `better-sqlite3@13.0.3` became a product dependency, then gave way to Bun's built-in `bun:sqlite` on 2026-09-19 when Tower and the runner moved to Bun. The probe scripts named below were removed with it; commit 9734d26 is the last one where they run under `test/compat/`.

## Decision

Use exactly `better-sqlite3@13.0.3` as the phase-0 candidate. Its published
Node engine range is `>=22`, and the isolated probe passes on both Node
22.22.0/musl and Node 26.8.2/macOS arm64. The probe does not change the root
dependency tree; this remains compatibility evidence rather than a release
dependency or production storage implementation.

Production code must still set `journal_mode=WAL`, `synchronous=FULL`, and a
bounded `busy_timeout` on the relevant connections.

## Reproduce

Run on any supported local Node version:

```sh
sh test/compat/sqlite-phase0-run.sh
```

Run the pinned Alpine floor:

```sh
docker build -f test/compat/sqlite-phase0.Dockerfile -t pi-tower-sqlite-phase0 test/compat
docker run --rm pi-tower-sqlite-phase0
```

The runner creates and removes an isolated fixture, packs the exact package,
installs that tarball with lifecycle scripts enabled, and runs the probe. It
does not use or modify root `node_modules`, `package.json`, or the lockfile.
The Docker build repeats the complete install and probe before producing the
image; `docker run` repeats it in a fresh container.

## Recorded results (2026-09-14)

Host: macOS 26.5.1 arm64, Node 26.8.2, npm 11.19.1:

```text
added 2 packages; 0 vulnerabilities
{"result":"PASS","node":"v26.8.2","driver":"13.0.3","sqlite":"3.53.4","busyTimeoutMs":1250,"observedBusyWaitMs":1332}
```

Container: `node:22.22.0-alpine` (musl), npm 10.9.4. Both the image-build
transaction and a fresh `docker run --rm` passed:

```text
added 2 packages; 0 vulnerabilities
{"result":"PASS","node":"v22.22.0","driver":"13.0.3","sqlite":"3.53.4","busyTimeoutMs":1250,"observedBusyWaitMs":1331}
{"result":"PASS","node":"v22.22.0","driver":"13.0.3","sqlite":"3.53.4","busyTimeoutMs":1250,"observedBusyWaitMs":1327}
```

Each pass verifies WAL mode, `synchronous=FULL`, the bounded busy timeout,
rollback after an unclean process exit before COMMIT, complete recovery after
an unclean process exit after COMMIT, and an integrity-checked online backup
that includes committed WAL-only data. A main-file-only copy is checked as a
negative control and omits that WAL-only row.

Crash injection uses `process.exit(91)` without closing the connection. It
tests cross-process interruption and restart, not power loss, ENOSPC, or torn
storage writes. Snapshot hash/graph validation and all higher-level storage
boundaries remain outside this driver probe.
