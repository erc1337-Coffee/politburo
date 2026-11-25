# @remilia/politburo-relay

A private store-and-forward relay between the orchestrator and its workers. The
orchestrator stays on the LAN and accepts no connection. Workers run elsewhere.
Both sides connect out to the relay: they send with `POST` and receive with SSE.

The relay routes and buffers messages and checks tokens. It decides nothing,
never reads message content beyond checking it is a JSON object, and holds only
the orchestrator's public key: it can check a token but can never make one.

## Channels and directions

One channel is one task attempt, named by the orchestrator (`[A-Za-z0-9_-]`,
up to 100 characters). Each channel has two directions:

| Direction | Sent by | Received by |
| --- | --- | --- |
| `commands` | orchestrator | worker |
| `telemetry` | worker | orchestrator |

Each direction is an append-only list with its own sequence numbers, starting
at 1. No endpoint creates a channel: a valid token defines it.

## Endpoints

Every endpoint needs `Authorization: Bearer <token>`. Anything else answers 404.

| Method and path | Who | Answer |
| --- | --- | --- |
| `POST /channels/{channel}/{direction}` | the direction's sender | `201 {"seq": n}` |
| `GET /channels/{channel}/{direction}` | the direction's receiver | SSE: `id: <seq>`, `data: {"seq","at","body"}`; resumes after `Last-Event-ID` |
| `DELETE /channels/{channel}` | orchestrator | `204`; ends open streams |
| `GET /stats` | statistics token | `200`: per channel and direction, message and byte counts, last sequence number and time, open streams; refused requests by status. Counters only, no content; at most one read a second per token (`429 too_many_requests`) |

Errors are JSON `{"error": "<code>"}`:

| Status | Code | Cause |
| --- | --- | --- |
| 400 | `invalid_json`, `invalid_last_event_id` | body is not one JSON object, or `Last-Event-ID` is not a sequence number |
| 401 | `unauthorized` | token missing, forged, expired, or for another channel (one answer for all) |
| 403 | `forbidden` | valid token, wrong role for this action |
| 413 | `message_too_large` | body over the size limit |

An SSE stream sends `: keepalive` comments and ends when its token expires; the
client reconnects with a new token and `Last-Event-ID`.

## Tokens

`base64url(claims).base64url(Ed25519 signature)`, where the claims are
`{"v": 1, "channel", "role": "orchestrator" | "worker" | "statistics", "iat", "exp"}` in Unix
seconds. The orchestrator signs one worker token and one orchestrator token per
attempt with `signToken()` from `@remilia/politburo-relay/protocol`. For the
operations view it signs a `statistics` token (channel `statistics`, 60 s), which
reads `GET /stats` and nothing else: it cannot read, write or end a channel.

## Limits (defaults)

| Limit | Default |
| --- | --- |
| Message size | 64 KiB |
| Retention after the sender's token expires | 24 h |
| SSE keepalive | 15 s |

Expired messages are never returned and are purged every minute.

## Run

```sh
# On the orchestrator host, once. Keep the signing key there.
politburo-relay keygen --directory ./keys
# Copy only relay_verification_key.pem to the relay host.
politburo-relay serve --verification-key relay_verification_key.pem --database relay.sqlite  --host 0.0.0.0 --port 8790
# For a manual test, on the orchestrator host:
politburo-relay token --signing-key ./keys/relay_signing_key.pem --channel task-12-r1 --role worker --ttl 3600
```

The relay serves plain HTTP on `--host` (default `127.0.0.1`). Put it behind a
TLS-terminating proxy. Without `--verification-key`, it reads the PEM from
`RELAY_VERIFICATION_KEY`; without `--port`, it uses `PORT`, then 8790.

## Deploy on Railway

The `Dockerfile` here builds the image; Node runs the TypeScript source, so
there is no install or build step.

| Setting | Value |
| --- | --- |
| Root directory | `packages/relay` |
| Variable | `RELAY_VERIFICATION_KEY`: the content of `relay_verification_key.pem` |
| Volume | mounted at `/data` |
| Replicas | 1 (streams and the SQLite file are local to one instance) |

Railway sets `PORT` and terminates TLS.

## Test

```sh
pnpm --filter @remilia/politburo-relay test
```

The package uses only Node built-ins (`node:http`, `node:crypto`, `node:sqlite`) and imports nothing from `board`, `runtime` or `swarm`.
