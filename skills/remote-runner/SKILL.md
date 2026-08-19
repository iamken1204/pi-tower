---
name: remote-runner
description: Dispatch tasks to remote pi runners through a pi-tower relay and list which runners are online. Use when asked to run something on a remote runner or remote machine, or when runner_task, runner_list, runner ids, or a tower are mentioned.
---

# Remote runner

Remote pi agents register with a pi-tower relay; a task sent to a runner id runs on that machine and returns the agent's final answer.

If the `runner_task` / `runner_list` extension tools are available, use them directly. Otherwise use the bundled CLI (paths relative to this skill directory):

```bash
node ../../task.mjs --list                    # list runners: id, busy/idle, connected time
node ../../task.mjs <runner-id> "<prompt>"    # dispatch; blocks until the remote agent finishes
```

`pi-task` on PATH is the same tool. Connection settings come from env `PI_TOWER_URL` / `PI_TOWER_TOKEN`, or `--tower <ws(s)://url>` / `--token <t>` flags. Add `--fresh` to start a fresh session on the runner first.

stdout carries only the final answer, so `$(...)` captures cleanly (progress streams to stderr only in an interactive terminal). A failure exits non-zero with the reason on stderr (an unknown runner id lists the online ids).
