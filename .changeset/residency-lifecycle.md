---
"@npc/runtime": minor
---

Residency lifecycle in the production daemon (reside → distill → publish → move). A new `ResidencyController` owns the live residency and runs a cycle: close the session socket (travel-gap inbound is dropped, never queued) → `Session.depart` (distill the live transcript, host cosign review, candidate/rejected records, journal to `NPC_JOURNAL_DIR`, departure + travel) → optional commit sweep of the departed epoch → re-arrival at the same Door under `epoch + 1` with a new session socket. Depart failures retry, then abandon crash-style so the Wanderer is never stranded; re-arrival retries with backoff; single-flight; SIGTERM aborts cleanly.

All triggers default **off**: `NPC_RESIDENCY_OPERATOR_TRIGGER` (SIGUSR2 or the new `wanderer depart` command, which drops a request into `NPC_CONTROL_DIR`), `NPC_RESIDENCY_MAX_MS` timer (≥ 1 h, waits for `NPC_RESIDENCY_MIN_LINES`), and `NPC_QUARANTINE_COMMIT_INTERVAL_MS` commit sweep (runs in the travel gap because the Door forgets an epoch's review on the next arrival; requires `NPC_QUARANTINE_WINDOW_MS` ≤ 1 h). SIGUSR2 is now always handled, so a stray signal no longer terminates the daemon.

`Session.depart` now writes the journal after host review from approved shards only, so rejected prose cannot reach the published journal. `commitQuarantinedShards` accepts a `residency` scope. New exports: `ResidencyController`, `loadResidencyConfig`, control-dir helpers; `ResidencyDaemonHandle` gains `requestCycle()` / `currentEpoch()`.
