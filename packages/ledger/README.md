# @remilia/politburo-ledger

The append-only spend ledger of a party, in one SQLite file (`node:sqlite`). It records
dispatches (who pays for an execution), usage records (one model response or resource interval
each), corrections, and launch intents. Roll-ups give known subtotals and unknown counts per
level; an unknown value is never counted as zero. See `design/swarm-spend.md`.

Writers: the orchestrator (usage of worker rounds) and `swarm ledger`. Readers: the board
inspector (`/operations` usage) and `swarm ledger rollup`.
