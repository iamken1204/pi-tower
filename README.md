# pi-tower

![pi-tower](assets/cover.svg)

Control tower for remote [pi](https://github.com/earendil-works/pi) runners. Register a headless pi on any machine, then let an interactive pi session anywhere dispatch tasks to it by name — like calling a remote coding agent as a tool.

```
┌─────────────────────────── laptop (interactive) ─────────────────────────────────┐
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
┌───────────────────────────── tower (any VPS) ───────────────────────┼────────────┐
│  process: pi-tower (tower.mjs)                                      ▼            │
│  ┌────────────────────────────────────────────────────────────┐                  │
│  │  registry: { "win-test-1" → runner socket, ... }           │                  │
│  │  pure relay: client frames ──→ runner, runner ──→ client   │                  │
│  │  one attached client per runner at a time                  │                  │
│  └──────────────────────────────▲─────────────────────────────┘                  │
└─────────────────────────────────┼────────────────────────────────────────────────┘
                                  │
              wss outbound (runner dials out, NAT/firewall friendly)
                                  │
┌────────────────────────── runner PC (e.g. CI box) ─┼─────────────────────────────┐
│  process: pi-runner (runner.mjs)                   │                             │
│  ┌─────────────────────────────────────────────────┴──────────┐                  │
│  │  pi-runner --hq wss://hq.example.com --id win-test-1       │                  │
│  │  pipes: wss frame ↔ child stdin/stdout (LF JSONL)          │                  │
│  └───────────────┬────────────────────────────────────────────┘                  │
│                  ▼                                                               │
│  child process: pi --mode rpc   (full agent, tools run locally)                  │
└──────────────────────────────────────────────────────────────────────────────────┘
```

## Setup

Everything lives in this package; runners and the laptop also need `pi` installed.

**Tower (VPS)**

```sh
npx pi-tower --port 9000 --token <shared-token>   # or PI_TOWER_TOKEN env
```

**Runner PC**

```sh
npx pi-runner --hq wss://hq.example.com --id win-test-1 --token <shared-token> -- --no-session
```

Args after `--` go to the spawned `pi --mode rpc`. The runner dials out and reconnects every 3s, so it works behind NAT. `--id` defaults to the hostname.

**Laptop**

pi-tower is a pi package bundling the extension (`runner_task` / `runner_list` tools) and the `remote-runner` skill. Install once:

```sh
pi install git:github.com/<you>/pi-tower   # or npm:pi-tower, or /local/path
pi -e /local/path                          # try without installing (this run only)
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

Each runner runs one `pi --mode rpc` process per session, so different sessions run in parallel with full process isolation. Tasks that reuse a session name continue its conversation — context survives between tasks and across detach/reattach. The default session is `main`; names match `[A-Za-z0-9._-]{1,64}`. Idle session processes stay alive until the runner stops (`ponytail:` an idle reaper is the upgrade path if long-lived runners accumulate too many).

pi users get discovery via the bundled `remote-runner` skill automatically. For non-pi agents, add a line to the project's AGENTS.md instead:

```md
Remote runner tasks: `pi-task <runner-id> "<prompt>"`; list runners: `pi-task --list` (env: PI_TOWER_URL, PI_TOWER_TOKEN).
```

## Wire contract

Session pipes are pure relays: each WebSocket text frame is one pi RPC JSONL record (see pi's `docs/rpc.md`), untouched in both directions. The runner's control channel carries only `{"type":"open","session":"<name>"}` frames from the tower; the runner answers by dialing a session pipe.

| Endpoint | Purpose |
|----------|---------|
| `GET /` | health, returns `pi-tower` |
| `GET /runners?token=t` | JSON `[{id, connectedAt, sessions}]` |
| `WS /runner?id=<id>&token=t` | runner control channel; same id reconnect replaces the socket, live sessions survive |
| `WS /runner-session?id=<id>&session=<name>&token=t` | runner-dialed data pipe, one per session |
| `WS /attach?runner=<id>&session=<name>&token=t` | client attachment, one per session (`session` defaults to `main`) |

| Close code | Meaning |
|-----------|---------|
| 4001 | bad token |
| 4004 | unknown runner (reason lists online ids) |
| 4005 | session busy (another client attached or attaching) |
| 4006 | session disconnected while attached |
| 4007 | runner failed to open the session (15s timeout or runner offline) |

Detaching a client leaves its session pipe idle on the tower, so a later attach with the same name resumes the conversation without a new `open`.

## Security

Single shared token checked on every upgrade and HTTP request. Run the tower behind a TLS reverse proxy (caddy/nginx) so the public URL is `wss://`; the token and all traffic are plaintext otherwise. Anyone with the token can drive any runner — runners execute arbitrary commands, so treat the token like an SSH key.

## Verify

```sh
npm run verify
```

Four assert-based scripts: tower relay semantics (fake runner), full chain through a real `pi --mode rpc` (no LLM call), the extension's tools plus the `pi-task` CLI driven against a fake runner, and pi-package loading via `pi -e .` (extension flag registered, skill listed).
