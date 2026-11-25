# Orchestrator

The orchestrator runs on the LAN and accepts no inbound connection. It claims
ready board tasks, starts one remote worker for each task attempt, exchanges
commands and telemetry with that worker through `@remilia/politburo-relay`,
chooses the next step and opens the draft pull request in the same repository.

| Path | Contents | State |
| --- | --- | --- |
| `launch.ts`, `journal.ts` | Launch a worker session once, record it, recover after a restart | Built; the cloud `Provider` adapter is not |
| `stages/` | Review stages (proposed to done, repair rounds) and the evidence gate | Built; not connected |
