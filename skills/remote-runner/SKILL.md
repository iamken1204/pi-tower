---
name: remote-runner
description: Discover threads and delegate work across projects with pi-tower. Use when asked to contact another runner, thread, project or remote machine. Prefer thread_list/thread_delegate in managed or native interactive threads; ordinary pi can use the legacy runner relay.
---

# Remote runner

## Managed and native interactive threads

When `thread_list`, `thread_delegate`, `thread_tasks` and `thread_report` are available, use them first. They reuse the current Runner's Tower connection, including connections configured with startup flags. No additional `PI_TOWER_URL` or `PI_TOWER_TOKEN` is needed. Do not fall back to `runner_list`, `runner_task`, `pi-task` or `task.mjs` for thread collaboration; those address legacy relay sessions.

1. Call `thread_list` to discover connected threads. Filters such as `project` match complete values; follow pagination when needed. Check `project`, `cwd`, `threadId` and host. A runner ID identifies a host, not a workspace: `pi` and `fx` can be projects under the same Runner ID. Ask the user only if candidates remain ambiguous after checking their metadata. If none match, report that the target thread is unavailable.
2. Generate one UUID `requestId` and call `thread_delegate` with the selected `targetThreadId`, the work, and that request ID. For example, from `fx`, find the `pi` project thread and ask it to list its local Git branches and report them with `thread_report`.
3. The delegate response is admission, not completion. Use `thread_tasks` and the explicit report to determine the result. Reuse the same `requestId` for retries. On timeout or an unknown result, query `thread_tasks` with that request ID; never create a new request ID to repeat uncertain work.
4. The target calls `thread_report` with the delegated `taskId`, `outcome` (`completed` or `failed`) and a summary. An ordinary assistant answer does not complete the task. The first report is immutable and is delivered to the originating thread. Its outcome is the target's claim, not independent verification.

Delegations run asynchronously; the source can continue working. Shared cwd does not provide file isolation, and concurrent edits can conflict.

## Legacy relay in ordinary pi

For ordinary pi without the thread tools, remote agents can register with the legacy pi-tower relay. A task sent to a runner ID runs on that machine and returns the agent's final answer.

If the `runner_task` / `runner_list` extension tools are available, use them directly. Otherwise use the bundled CLI for legacy relay work (paths relative to this skill directory):

```bash
node ../../task.mjs --list                    # list runners: id, session count, connected time
node ../../task.mjs <runner-id> "<prompt>"    # dispatch; blocks until the remote agent finishes
```

`pi-task` on PATH is the same tool. Connection settings come from `PI_TOWER_URL` plus `PI_TOWER_TOKEN` or `PI_TOWER_TOKEN_FILE`, with matching `--tower`, `--token`, and `--token-file` flags; with none of the token settings it reads `~/.pi-tower/token`. `--session <name>`: tasks with the same name share conversation context on the runner, different names run in parallel (default: main). Add `--fresh` to reset the session's conversation first.

stdout carries only the final answer, so `$(...)` captures cleanly (progress streams to stderr only in an interactive terminal). A failure exits non-zero with the reason on stderr (an unknown runner id lists the online ids).
