# pi-tower

![pi-tower](assets/cover.svg)

Control tower for remote [pi](https://github.com/earendil-works/pi) runners. Register a headless pi on any machine, then let an interactive pi session anywhere dispatch tasks to it by name — like calling a remote coding agent as a tool.

```
┌────────────────────── interactive pi (anywhere) ─────────────────────────────────┐
│  process: pi (interactive TUI)                                                   │
│  ┌────────────────────────────────────────────────────────────┐                  │
│  │  extension.ts                                              │                  │
│  │  ├─ registerFlag("--tower", "--tower-token")               │                  │
│  │  └─ registerTool("runner_list", "runner_task")             │                  │
│  │       execute() ──── wss ────────────────────────────────────────┐            │
│  └────────────────────────────────────────────────────────────┘     │            │
└─────────────────────────────────────────────────────────────────────┼────────────┘
                                                                      │
                                              wss (RPC JSONL frames, token auth)
                                                                      │
┌────────────────── tower (any reachable host) ───────────────────────┼────────────┐
│  process: pi-tower (tower.mjs)                                      ▼            │
│  ┌────────────────────────────────────────────────────────────┐                  │
│  │  registry: { "win-test-1" → control ws + session pipes }   │                  │
│  │  pure relay per session pipe, client ⇄ runner untouched    │                  │
│  │  one client per session; sessions run in parallel          │                  │
│  └──────────────────────────────▲─────────────────────────────┘                  │
└─────────────────────────────────┼────────────────────────────────────────────────┘
                                  │
              wss outbound (runner dials out, NAT/firewall friendly)
                                  │
┌───────────────────── runner (any machine with pi) ─┼─────────────────────────────┐
│  process: pi-runner (runner.mjs)                   │                             │
│  ┌─────────────────────────────────────────────────┴──────────┐                  │
│  │  pi-runner --hq wss://hq.example.com --id win-test-1       │                  │
│  │  control ws + one data ws per session (LF JSONL)           │                  │
│  └───────────────┬────────────────────────────────────────────┘                  │
│                  ▼                                                               │
│  child processes: pi --mode rpc × N   (one per session, tools run locally)       │
└──────────────────────────────────────────────────────────────────────────────────┘
```

## Setup

Requires Node.js 22.22.0 or newer. Compatibility checks passed with pi 0.85.1 on Node 22.22.0 and 26.8.2. This records the tested combination, not a discovered minimum pi version; older pi versions have not been established as supported. Cloud Threads is opt-in and remains under development.

Three roles, each runnable on any machine (even all three on one box); the runner and interactive sides also need `pi` installed.

**Tower** (any host the runner and interactive sides can both reach)

```sh
npx pi-tower --port 9000 --token <shared-token>   # or --token-file /path/to/token
```

Or with Docker plus a Cloudflare Tunnel (no exposed port, TLS terminates at the edge):

```sh
cp .env.example .env   # set PI_TOWER_TOKEN and TUNNEL_TOKEN
docker compose up -d
```

In the Zero Trust dashboard, point the tunnel's public hostname at `http://tower:9000`; the tower URL everywhere else is then `wss://<that-hostname>`.

Open `https://<that-hostname>/` and enter the shared token to view live runner and session state. The tower exchanges it for a signed, HTTP-only session cookie valid for 30 days; the raw token is not retained by the page.

The token admits a request but does not say who sent it. When Tower is reachable only through a proxy that authenticates people and sets or overwrites an identity header, such as Cloudflare Access (`cf-access-authenticated-user-email`) or oauth2-proxy (`x-forwarded-user`), pass that header name as `--subject-header` / `PI_TOWER_SUBJECT_HEADER`. Tower then records the value on every command receipt as `actor.subject`; a request carrying an empty or over-long value is rejected. Do not set it while Tower is reachable directly, since any token holder could then choose the name. Without it, receipts record `{ kind: "user" }`.

Permissions are a programmatic port. Embedding Tower from Node with `createTower({ policy })` supplies `policy(principal, action, resource)`, a function returning whether the action is allowed; the CLI has no flag for it, and the default lets every token holder do everything. `principal` is `{ kind: "user", subject? }` for a person and `{ kind: "thread", threadId, runnerId }` for a thread acting through its runner. `action` is `read`, `prompt`, `abort`, `extension_ui_response`, `sleep`, `create`, `restore` or `update`. `resource` is the thread description (`threadId`, `runnerId`, `cwd`, `project`, `hostname`, `title` and more) or, for runner listings and `create`, `{ runnerId, cwd? }`. A denied read hides the thread from listings, the home page, `thread_list` and the stream, which closes with code 1008; a denied action answers 403 over HTTP or `forbidden` over WebSocket. Read permission is checked when a stream opens, not on every frame, and a listing page can come back short when it hid threads. Policy covers Cloud Threads only; the legacy relay and `/api/managed/usage` ask nothing beyond the token.

**Runner** (the machine that executes tasks: a CI box, a lab PC, a server)

```sh
npx pi-runner --hq wss://hq.example.com --id win-test-1 --token-file /path/to/token -- --no-session
```

The tower, runner, and `pi-task` commands accept either `--token <value>` / `PI_TOWER_TOKEN` or `--token-file <path>` / `PI_TOWER_TOKEN_FILE`. Explicit flags override the environment, and `PI_TOWER_TOKEN` takes precedence when both environment variables are set; with none of them, all three read `~/.pi-tower/token`. `pi-runner` alone starts the interactive Cloud Threads terminal described below; args after `--` (or `--no-interactive`) select this headless relay instead. Args after `--` go to the spawned `pi --mode rpc` and are all optional. `--no-session` keeps task transcripts off the runner's disk; drop it for an on-machine audit trail of what remote tasks did. The runner dials out and reconnects every 3s, so it works behind NAT. `--id` defaults to the hostname.

**Interactive side** (wherever you drive pi from)

pi-tower is a pi package bundling the extension (`runner_task` / `runner_list` tools) and the `remote-runner` skill. Install it from npm or GitHub, or try a local checkout without installing:

```sh
pi install npm:pi-tower
pi install git:github.com/iamken1204/pi-tower  # or from GitHub
pi -e /local/path                              # or try a local checkout (this run only)
```

Then start pi with the tower flags and prompt "use runner_task on win-test-1 to ...":

```sh
pi --tower wss://hq.example.com --tower-token <shared-token>
```

Providers with a direct API key see the extension tools natively. Providers that run their agent loop server-side (and never expose extension tools) get the `remote-runner` skill instead, which teaches the model the `pi-task` CLI below.

## pi-task CLI

Some providers run their agent loop server-side and never expose extension-registered tools to the model. `pi-task` is the provider-agnostic fallback: any agent (or human) dispatches with one shell command instead of the extension tools.

```sh
export PI_TOWER_URL=wss://hq.example.com PI_TOWER_TOKEN=<shared-token>
pi-task --list                    # who's online
pi-task win-test-1 "run the failing job and report the error"
```

stdout carries only the final answer, so `$(pi-task ...)` captures cleanly; progress streams to stderr only in an interactive terminal, keeping piped output clean for agent callers. `--session <name>` picks the session (see below); `--fresh` resets the session's conversation first; Ctrl-C forwards an abort to the runner.

## Sessions

Each runner runs one `pi --mode rpc` process per session, so different sessions run in parallel with full process isolation. Tasks that reuse a session name continue its conversation — context survives between tasks and across detach/reattach. The default session is `main`; names match `[A-Za-z0-9._-]{1,64}`. A session nobody is attached to is closed after 30 minutes without output, which ends its `pi` process and discards its conversation. Tune that with `--idle-ttl 2h` / `PI_TOWER_IDLE_TTL` (`s`, `m`, or `h`; `0` disables), or close a session by hand from the web UI.

pi users get discovery via the bundled `remote-runner` skill automatically. For non-pi agents, add a line to the project's AGENTS.md instead:

```md
Remote runner tasks: `pi-task <runner-id> "<prompt>"`; list runners: `pi-task --list` (env: PI_TOWER_URL and PI_TOWER_TOKEN or PI_TOWER_TOKEN_FILE).
```

## Wire contract

Session pipes are pure relays: each WebSocket text frame is one pi RPC JSONL record (see pi's `docs/rpc.md`), untouched in both directions. The runner's control channel carries only `{"type":"open","session":"<name>"}` frames from the tower; the runner answers by dialing a session pipe.

The public UI shell and health response expose no runner state. CLI requests and every WebSocket upgrade authenticate with an `Authorization: Bearer <token>` header. The UI exchanges the token for an HMAC-signed, HTTP-only cookie scoped to `/api`; `/api/state` and `/api/events` accept either form of authentication. The tower sends a heartbeat every 30s and terminates WebSocket peers that miss two pings.

| Endpoint | Purpose |
|----------|---------|
| `GET /healthz` | health, returns `pi-tower` |
| `GET /` | public HTML state viewer shell |
| `GET /ui/` | redirects to `/` (old bookmarks) |
| `POST /api/session` | validate a UI token, set the signed session cookie, and redirect |
| `GET /api/state` | protected JSON runner and session state |
| `GET /api/events` | protected SSE stream of runner and session state |
| `GET /runners` | JSON `[{id, connectedAt, sessions}]` |
| `WS /runner?id=<id>` | runner control channel; same id reconnect replaces the socket, live sessions survive |
| `WS /managed/runner?id=<id>&instance=<uuid>&boot=<uuid>` | one managed process; several per id, each hosting its own threads; a reconnect with the same boot replaces its stale socket |
| `WS /runner-session?id=<id>&session=<name>` | runner-dialed data pipe, one per session |
| `WS /attach?runner=<id>&session=<name>` | client attachment, one per session (`session` defaults to `main`) |

| Close code | Meaning |
|-----------|---------|
| 4001 | bad token |
| 4004 | unknown runner (reason lists online ids) |
| 4005 | session busy (another client attached or attaching) |
| 4006 | session disconnected while attached |
| 4007 | runner failed to open the session (15s timeout or runner offline) |

Detaching a client leaves its session pipe idle on the tower, so a later attach with the same name resumes the conversation without a new `open`. Once a detached session has been quiet for the idle TTL, or on `DELETE /api/session?runner=<id>&session=<name>`, the tower sends `{"type":"close","session":"<name>"}` on the control socket and the runner kills that `pi` process.

## Security

Single shared token, sent as an Authorization header on every upgrade and HTTP request, so it stays out of URLs and access logs. Run the tower behind a TLS reverse proxy (caddy/nginx) so the public URL is `wss://`; the token and all traffic are plaintext otherwise. Anyone with the token can drive any runner — runners execute arbitrary commands, so treat the token like an SSH key.

## Verify

```sh
npm run verify:phase0 # all checks in a disposable workspace with an empty pi profile
```

The four legacy scripts cover relay semantics, a real no-LLM RPC chain, extension/CLI behavior and package loading. Additional probes cover full-tree SDK restoration, UTF-8 framing, wrapper crashes and managed thread persistence. Real pi tests use scripted providers and isolated credentials; `PI_COMPAT_PACKAGE` can specify the installed pi package directory.

## Cloud Threads (opt-in)

Cloud Threads connects a native local pi terminal to browser input, with a persistent catalog, saved history and command receipts. Start the runner from your workspace in a terminal:

```sh
pi-tower --data-dir /persistent/tower
pi-runner --hq wss://tower.example.com
```

Both read the shared token from `~/.pi-tower/token` unless told otherwise. The runner keeps its data in `~/.pi-tower` (`--data-dir` or `PI_RUNNER_DATA_DIR` override) and uses the hostname as its id.

After signing in at `https://tower.example.com/`, open `https://tower.example.com/threads/`. The same shared token grants access to every thread and runner. Use HTTPS/WSS outside a trusted local network.

The local thread appears automatically. The list shows active threads only: awake on an online runner. Tick **Inactive** to include sleeping ones. Every thread shows the directory and host it runs on. The home page counts online runners and active threads. Send from the terminal or any authenticated browser without acquiring or releasing control. Browser input during a run queues a follow-up; **Steer current run** uses pi steering. **Stop** cancels the run and pending queue. Closing the browser does not stop pi. When Tower is disconnected, the local terminal continues and uploads progress after reconnecting.

Exit pi normally, then resume the way native pi does: from the same directory, `-c` continues that directory's newest thread and `-r` lists its threads to pick from; `--thread <UUID from the thread URL>` names one from anywhere. All three restore the thread's original directory, full session tree and saved active leaf; a thread never follows the terminal's cwd. `/new` creates another managed thread in the same directory; `/reload` preserves the connection bridge. An inactive native thread cannot start itself from the web: resume it in a local terminal. Open more terminals the same way: each is another connection of the same runner sharing `~/.pi-tower`, and every thread is served by exactly one process at a time. Copying runner data between hosts is unsupported. There is no orb or replacement runtime.

`--managed-threads` selects the older background RPC mode for browser-created threads. It has no native terminal and accepts prompts only while idle. It is the only process that hosts browser-created threads, and one per data directory. **New thread** in the browser needs one on the chosen runner and picks one of the directories that runner already works in, the one it started from or any existing thread's; the runner refuses any other path. Legacy relay commands are unchanged.

Run the wrapper from the workspace used for new threads. Existing threads retain that cwd across restarts and always execute on the same runner host. Do not clone or copy a runner data directory to another host; Cloud Threads does not migrate the repo, working tree, credentials, or tool side effects. Managed mode currently accepts pi 0.85.1; this is the tested version, not a minimum inferred from package discovery. `--pi-package /absolute/package/directory` overrides global npm discovery. Configure models and extensions through normal pi settings. Managed mode rejects passthrough pi arguments, including session, continue, and no-session overrides. Legacy sessions and the commands above remain unchanged when managed mode is disabled.

For background RPC mode, `--managed-idle-ms` defaults to 1800000 (0 disables idle sleep); `--managed-max-awake` defaults to 4. Idle sleep applies after all viewers disconnect and the run settles, not while tools or dialogs are active. Interactive mode does not idle-sleep. The wrapper and each pi child hold separate OS-backed SQLite locks; interactive pi runs inside the wrapper process. Restart refuses to open a second writer while an old writer holds its lock. After confirmed exit, it validates the local checkpoint and complete appended entries, marks the run interrupted, and never replays uncertain commands. Never delete lock files based on PID absence or age. Use local filesystems, not network shares.

Tower limits default to a 256 KiB prompt or dialog response, 512 KiB managed WebSocket frame, 64 MiB snapshot, 1 GiB retained snapshot BLOB quota, 256 MiB minimum free disk, two concurrent uploads, and a 1 MiB slow-viewer buffer. Thread lists default to 50 rows (maximum 100); history defaults to 100 entries (maximum 1000). Set Tower limits with the variables in `.env.example`. Set `PI_MANAGED_TEXT_BYTES` on both Tower and runner. If raising the snapshot limit, also set the runner's download ceiling `PI_RUNNER_MAX_SNAPSHOT_BYTES` (default 67108864). Frame limits apply to serialized JSON, including escaping and metadata.

`GET /api/managed/usage` reports retained BLOB, database, WAL and free-space bytes. Every successful snapshot transaction prunes older BLOBs only after verifying their entries survive unchanged in the new full snapshot. Revision/hash indexes and command receipts remain. The quota counts retained BLOBs after pruning; reserve additional disk for old/new overlap, WAL and backups. SQLite reuses freed pages but does not necessarily shrink its main file. WAL autocheckpoint runs at 1000 pages; Tower also requests a passive checkpoint every 60 seconds. Avoid external long-lived read transactions that prevent checkpoint progress. Sync/storage errors disable new prompts on the affected thread; stopping and reading remain available.

Native extension select/confirm/input dialogs can be answered from either interface; the first answer closes the other prompt. Extension editor dialogs stay local, with a browser notice to use the terminal. Custom TUI widgets, browser slash commands and uploads are not supported. `settled` means the run stopped and a local checkpoint was saved, not that every tool succeeded or external side effects were undone. Every command receipt also carries `actor`: `{ kind: "user" }` for browser or bearer-token commands and `{ kind: "thread", threadId, runnerId }` for delegations. Tower records it when it admits the command and never changes it afterwards; a runner cannot set or alter it. Receipts that only a runner remembers, such as those republished after restoring an older Tower backup, and receipts recorded before this version carry `actor: null`. Cloud sync is a separate status. Unknown commands are never automatically retried; inspect saved history before explicitly sending a new command.

Run `npm run verify:phase0` for isolated regression tests, and `npm run verify:native` for the actual Tower + native pi + two WebSocket clients test (requires tmux). Both use isolated profiles and no paid LLM calls. Set `PI_NATIVE_PREVIEW=1` for the native test to keep its browser fixture open; it prints a local stop URL that cleans up its test data.

### Asynchronous thread collaboration

Managed pi exposes `thread_list`, `thread_delegate`, `thread_tasks`, and `thread_report`. Discovery covers connected threads across **all projects and hosts in the same HQ**. Optional project, hostname and runner filters match complete values. Choose a thread ID after checking the directory and host; duplicate project names do not identify a unique checkout. Each thread retains one writer. Delegations queue as follow-ups, and the sender can keep working while the target runs. No file isolation, repo synchronization or cross-HQ routing is provided.

Generate a UUID `requestId` once per delegation and reuse it for retries. Admission waits at most 10 seconds; a timeout means unknown, not unexecuted. Query `thread_tasks` with that request ID rather than submitting a new one. Targets must use `thread_report` with the task ID and a `completed` or `failed` summary. An ordinary assistant answer never completes a task. The first durable report is immutable; its outcome is the agent's claim, not independent verification.

The thread page separates runner reports from ordinary user-facing answers, identifies both runners and threads, and distinguishes submitted reports from confirmed receipt. Results automatically reach the original source thread when its runtime is available. `/new` does not receive the previous thread's results; resume that original thread to receive them. Report delivery uses a stable notification ID and durable session evidence. An interrupted insertion with no confirmable session record stays unknown and does not retrigger the agent. LLM or tool side effects are **not exactly-once**.

Every thread already carries its runtime's absolute cwd and, since schema 5, the runner's system hostname; the project shown in listings and used by `thread_list` filters is the directory's last component. Runners collect no other environment variables or directory contents. Paths and hostnames may be sensitive; all authenticated users of this HQ can read them, including for offline threads. Local and Web renames use `metadataVersion`; an offline conflict preserves the local name and shows a warning. Review the Tower name, then rename locally again to resolve it.

Tool queries default to 10 records, maximum 20 per page, ordered by thread/task UUID with an exclusive cursor. Task prompt and report summary limits are 256 KiB of UTF-8 each (`PI_MANAGED_TEXT_BYTES`); metadata/filter values are limited to 4096 UTF-8 bytes, and names to 200 characters. Browser frames retain their 512 KiB limit; the authenticated runner channel retains its 64 MiB limit. JSON escaping and envelopes count toward frame limits.

Tower migrates its SQLite schema to 5 at startup, preserving catalog metadata, snapshots and command receipts. Threads recorded before the upgrade show no host until their runner reconnects. Tasks, first reports and notification state live in that same database; runner task evidence and pending reports live alongside the command journal. Back up both sides before upgrading. Restore an older Tower backup only with the original runner's retained evidence: unconfirmed work becomes unknown, never automatically rerun. Snapshot pruning does not prune collaboration records. There is no downgrade migration.

Reproduce the collaboration checks without real sessions or paid calls:

```sh
npm run verify:collaboration  # public API gate, store/recovery/protocol, real pi and native TUIs
npm run verify:phase0        # full regression in disposable HOME/profile/workspace
node test/compat/collaboration-browser-fixture.mjs # local offline UI fixture; Ctrl-C to stop
```

The native test requires tmux and uses a private socket and separate temporary pi profiles. The real-pi tests use pi 0.85.1's scripted provider. They exercise parallel target barriers, FIFO admission, explicit reports, automatic results, `/reload`, `/new`, and restarting the original native thread. Protocol tests use fake runners for cross-host routing, conflicts, disconnection, receipt retry, Tower restart and backup restoration. Recovery tests reconstruct specific durable-write boundaries; they are not SIGKILL tests at every instruction. Physical multi-host networking and a deployed HQ are not part of these local checks. See the [collaboration specification and evidence](plans/2-open/env-meta-and-runner-collaboration.md).

### Docker storage and backup

The Compose deployment enables managed Tower storage at `/data` on the `tower-data` volume. Its web interface is available at `https://<tunnel-hostname>/threads/`. Runner data is separate and must remain on each runner host; each managed runner keeps its own persistent data directory, `~/.pi-tower` unless `PI_RUNNER_DATA_DIR` or `--data-dir` says otherwise.

Snapshots can contain prompts, tool output, source code, and secrets. They are not end-to-end encrypted. Restrict and encrypt the Tower volume and backups, rotate the shared token if it leaks, and back up each runner's data and workspace separately. Losing the Tower volume loses cloud history; losing runner data or its workspace cannot be repaired by moving a Tower backup to a different runner.

Make a consistent backup only while Tower is stopped. This archive retains the catalog, snapshots, and command receipts, including receipts for pruned snapshot revisions:

```sh
mkdir -p backups
docker compose stop tower
docker compose run --rm --no-deps --user 0 -v "$PWD/backups:/backup" tower \
  sh -c 'tar -C /data -czf /backup/pi-tower-data.tgz .'
docker compose start tower
```

Restore into the same deployment and then check SQLite before starting Tower. Keep Tower stopped throughout the restore. The command below saves a second archive of the current volume before replacing it; retain that archive until the restored data has been checked:

```sh
docker compose stop tower
docker compose run --rm --no-deps --user 0 -v "$PWD/backups:/backup" tower sh -c \
  'tar -C /data -czf /backup/pre-restore-$(date +%s).tgz . && find /data -mindepth 1 -maxdepth 1 -exec rm -rf -- {} + && tar -C /data -xzf /backup/pi-tower-data.tgz && node --input-type=module -e '\''import Database from "better-sqlite3"; import {createSnapshotStore} from "./managed-snapshots.mjs"; const db=new Database("/data/tower.sqlite",{readonly:true}); if(db.pragma("integrity_check",{simple:true})!=="ok") throw new Error("integrity_check failed"); const snapshots=createSnapshotStore(db); for(const row of db.prepare("SELECT thread_id FROM managed_snapshot_latest").all()) snapshots.latest(row.thread_id); db.close()'\'''
docker compose start tower
```

Do not copy only `tower.sqlite` from a running Tower: committed data may still be in `tower.sqlite-wal`. Test restores on disposable storage and confirm expected threads, history, and receipts before relying on a backup.

On reconnect, the original runner reconciles receipts and cloud revision/hash before accepting work. It can republish a verified local superset after Tower rolls back to an older backup, using a fresh random generation. Divergent history fails closed. Threads created after that backup are absent from its catalog: the runner retains them locally and logs `thread_missing_from_catalog`, without recreating metadata or blocking other threads. Recover a newer Tower backup to make those threads available again. If both sides lost newer records, backups cannot prove or recover the missing side effects or receipts.

With Docker already running and pi installed locally, run `node test/verify-docker.mjs` to build the product image and verify stopped-volume backup, restoration to a new volume, and continuation through the original runner. It uses isolated data and a local faux provider, then removes its test resources. This passed with Node 22.22.0 Alpine and pi 0.85.1; it does not test a live Cloudflare Tunnel. See [implementation evidence and remaining acceptance work](docs/cloud-threads-progress.md); do not treat the current work as completed Cloud Threads v1.
