# Phase 0 runner crash probe

## Result

`test/compat/verify-crash.mjs` runs the current `runner.mjs` against an in-process Tower and a uniquely scoped fake `pi`. Each case gets separate temporary `HOME`, cwd, and `XDG_DATA_HOME` directories. The probe opens a real Tower session, records the spawned child PID, sends input only in the busy case, and sends `SIGKILL` only to the wrapper. The fake intentionally remains alive after stdin EOF so the test can distinguish wrapper cleanup from incidental child exit.

On macOS with Node v26.8.2 and pi 0.85.1 installed, both idle and busy children received EOF and remained alive for the bounded 750 ms observation. This demonstrates that the current wrapper does not provide a crash-time child-death guarantee. The test terminates only PIDs it directly spawned or learned from its private fake-pi log and removes its temporary tree.

The probe also loads the installed pi 0.85.1 CLI through a test-only launcher that records its own PID before importing the public CLI entry. Under an empty profile, real pi was no longer alive 750 ms after wrapper SIGKILL, both idle and awaiting an extension dialog. No LLM was called. This bounded observation is not a guarantee for running tools, detached descendants, other operating systems, or future pi versions.

The busy fake sends JSON one byte at a time. The baseline runner preserved one LF frame but corrupted its UTF-8 text into replacement characters. Phase 0 fixed this with `child.stdout.setEncoding("utf8")`; the probe now asserts exact Chinese, emoji, U+2028 and U+2029 text equality within one frame. The fixed test and all existing regressions pass on Node 22.22.0 and 26.8.2. The crash cases remain characterization tests, not proof of implemented exclusion.

Run:

```sh
node test/compat/verify-crash.mjs

# Existing regression suite plus phase-0 probes, all in a disposable workspace
npm run verify:phase0
```

This is a compatibility probe, not shipped crash recovery. The fake's post-EOF behavior deliberately represents a child or descendant that does not exit voluntarily; it does not claim every real pi invocation will remain alive.

## Fail-closed runtime exclusion proposal

Before managed threads can start a runtime, acquire an exclusive lock for the runner data directory and a separate exclusive lease for each thread. Keep the thread lease in a dedicated supervisor process that is the pi child's parent and survives wrapper/network restarts. Put each runtime in its own process group, and have the supervisor terminate the group on wrapper loss. A replacement wrapper must ask that same supervisor for the lease; it may start a child only after the supervisor has observed and reaped the prior child (`waitpid`/equivalent) and confirmed the process group is empty.

If the supervisor is unavailable, its durable state is inconsistent, or prior-child exit cannot be confirmed, mark the runtime `interrupted/unknown` and refuse all writes. Require bounded reconciliation or operator recovery rather than starting a second writer.

A persisted PID is not proof: PIDs are reused, ownership can change between checks, and `kill(pid, 0)` proves neither identity nor that descendants have stopped. A PID file may be diagnostic metadata only. The exclusion proof must come from ownership of the live child handle plus reap notification, combined with the exclusive thread lease. On Linux, a parent-death signal may reduce orphaning but is not portable and does not replace exclusion/reaping. Descendants can escape a process group; group emptiness alone must not authorize restarting a writer if containment is uncertain. Use OS-managed containment where available, otherwise require operator recovery. No proof-of-concept lock was added because a wrapper-held file lock is released by `SIGKILL` while its orphan remains; by itself it would incorrectly authorize a second writer.

This proposal addresses same-host lifecycle only. The user has excluded copying a runner directory to another host and continuing there, even when the original host is stopped; see [spec sections 2 and 8](specs/cloud-threads-v1.md). Offline work remains supported. Cross-host clone exclusion is not required, but same-host crash recovery must still prevent a second writer. The supervisor remains an engineering proposal, not implemented protection.
