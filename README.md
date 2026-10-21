# jiflow-canvas-mcp

A standalone **[MCP (Model Context Protocol)](https://modelcontextprotocol.io/) stdio server** that lets AI agents
read and modify a local **canvas graph** safely.

The server exposes exactly nine whitelisted `canvas_*` tools over newline-delimited JSON-RPC 2.0 on
stdin/stdout. Every write is authenticated with a scoped static token, guarded by a compare-and-swap (CAS)
revision check and a **safe per-canvas lock** (owner-token file + monotonic fence, crash recovery only for
provably dead same-host owners), and committed atomically together with a durable operation receipt, so an
interrupted or retried operation can be replayed idempotently instead of double-applied.

> **Project status: MIT-licensed open-source project — publicly available on GitHub.**
> Repository: [`q973946080/jiflow-canvas-mcp`](https://github.com/q973946080/jiflow-canvas-mcp). The v0.1.0 source release
> is available in GitHub Releases. The project is **not published to npm** and makes no claim of external adoption
> or an OpenAI/Codex-for-OSS benefit. Verified before release: **179/179 automated tests and 11/11 functional
> acceptance checks**.
>
> **License: MIT.** Copyright (c) 2026 chen gs; `package.json` and `package-lock.json` declare `MIT`.
>
> **Release scope:** only the files in this repository are part of the public release. Internal audit,
> provenance and verification records are not part of this repository and are never published.

## Contents

- [What it is](#what-it-is)
- [Features](#features)
- [Requirements](#requirements)
- [Install](#install)
- [Quickstart](#quickstart)
- [MCP client configuration](#mcp-client-configuration)
- [Authentication and scopes](#authentication-and-scopes)
- [Tools](#tools)
- [Writes: CAS, receipts and idempotent replay](#writes-cas-receipts-and-idempotent-replay)
- [CLI reference](#cli-reference)
- [Store layout](#store-layout)
- [Error codes](#error-codes)
- [Examples](#examples)
- [Recovery and safe retries](#recovery-and-safe-retries)
- [Verification status](#verification-status)
- [Limitations](#limitations)
- [Security](#security)
- [License](#license)

## What it is

`jiflow-canvas-mcp` is a small, dependency-free local service that gives an AI agent a *narrow, safe tool
surface* over one directory of canvas data:

- an agent can **list and read** canvases, nodes and operation receipts;
- an agent can **create/patch nodes and connect nodes**, individually or as an ordered batch;
- it can do **nothing else** — there is no shell, file, HTTP or delete tool, and no anonymous access;
- concurrent agents (separate server processes sharing one store) cannot silently overwrite each other:
  a stale revision is rejected and the caller must re-read and retry;
- concurrent writers cannot preempt a **live** lock holder: the lock carries an owner token, process
  identity and a monotonic fence; an owner that lost its lock generation cannot commit, and an unsafe or
  unverifiable lock fails closed instead of being stolen;
- every applied operation leaves a **receipt** with a hash of the exact payload, so a retry with the same
  `operationId` returns the original result instead of writing twice.

The canvas model is deliberately generic: five node kinds (`text`, `image`, `video`, `audio`, `note`), a
small set of mutable node data fields, and capability-validated edges. No product-specific vocabulary or
business logic is included. See [`ARCHITECTURE.md`](ARCHITECTURE.md) for the design.

## Features

- **Nine whitelisted tools** — five read tools and four write tools; the whitelist is the single source of
  truth for tool names and argument schemas. There is no shell/file/network tool and no bypass flag.
- **Zero runtime dependencies** — the server imports only Node built-ins (`node:fs`, `node:path`,
  `node:crypto`, `node:url`, `node:process`). The only devDependency is the MIT-licensed
  `@modelcontextprotocol/sdk@1.30.0`, used only by the protocol test suite and the acceptance runner; `src/`
  never imports it.
- **Scoped static tokens** — each principal has a SHA-256 token digest, a mode (`READ_ONLY` or
  `CANVAS_WRITE`), a canvas allowlist and an optional tool allowlist. Startup fails closed.
- **CAS revision conflict detection** — writes carry `expectedRevision`; a mismatch returns
  `CANVAS_REVISION_CONFLICT` with `{expectedRevision, actualRevision}` and writes nothing.
- **Atomic file store** — one JSON file per canvas, written through a same-directory temp file + `fsync` +
  atomic `rename`, with `0600` permissions on state files.
- **Durable receipts + idempotent replay** — receipts live in the same JSON file as the canvas state, so the
  state change and its receipt commit together. Replaying an `operationId` with an identical payload returns
  the stored result (`replayed: true`) without a second write.
- **Safe per-canvas lock** — writers claim a JSON **owner record** atomically (hard link of a fully
  written, `0600` claim file) carrying a unique token, PID, hostname and a **monotonic fence**. A live owner
  is never preempted; release verifies ownership and never deletes a foreign lock; recovery of a
  **provably dead same-host owner** (liveness `ESRCH` plus an age gate) is serialised by a per-canvas
  **recovery marker**, and a dead marker may itself be reclaimed only while holding a separate
  **recovery guard**. A live recovery guard or marker is never preempted; a dead/foreign/corrupt/ambiguous
  recovery guard fails closed with `CANVAS_LOCK_UNVERIFIABLE` and a manual operator-cleanup action (a
  marker-holder crash auto-recovers through the guard; a guard-holder crash deliberately does not).
  A writer whose lock generation is no longer current is rejected with `CANVAS_LOCK_OWNERSHIP_LOST` before
  any state write; corrupt records, foreign hosts or ambiguous liveness fail closed with
  `CANVAS_LOCK_UNVERIFIABLE`.
- **Audit logs** — one JSON object per line on **stderr only** (stdout is a pure protocol channel), with an
  arguments digest instead of raw arguments and never any token material.

## Requirements

- **Node.js >= 20** (`engines.node: ">=20.0.0"`). Development and the recorded acceptance run used
  Node.js **v24.11.1**.
- A local directory to use as the store (created by you; it must exist before the server starts).
- `npm` is needed only to install the test-time devDependency; **the server itself has no runtime
  dependencies and runs from a copy of `src/` alone**.
- Operating system: developed and tested on macOS (darwin arm64). The code uses only portable Node built-ins,
  but other platforms have not been tested in this candidate.

## Install

The repository is public: [q973946080/jiflow-canvas-mcp](https://github.com/q973946080/jiflow-canvas-mcp). Clone it with:

```bash
git clone https://github.com/q973946080/jiflow-canvas-mcp.git
cd jiflow-canvas-mcp
npm ci   # optional: installs @modelcontextprotocol/sdk@1.30.0 (test-only devDependency)
```

The server itself has no runtime dependencies; if you only want to run it, you can skip `npm ci` and run
`node src/server/main.mjs` from the checkout. The project is distributed as source on GitHub; it is not published to npm.

If you only want to run the server, you can skip `npm ci`: copy the repository and run
`node src/server/main.mjs` from it.

## Quickstart

The examples use **fictional demo data** only (canvas ids `canvas-demo-a` / `canvas-demo-b`,
`example.invalid` URLs and documented `demo-*` placeholder tokens).

```bash
npm run seed:demo       # writes examples/demo-store/ and examples/auth.demo.json (fictional, idempotent)
npm run demo            # spawns a real server: read → create → patch → connect → receipt → idempotent replay
npm run demo:conflict   # two server processes race one stale revision; exactly one wins, loser retries
```

Run the server directly against the demo store (stdin/stdout are the MCP transport; `Ctrl-D` / EOF exits 0):

```bash
CANVAS_MCP_TOKEN=demo-reader-token \
  node src/server/main.mjs \
    --store examples/demo-store \
    --auth examples/auth.demo.json
```

## MCP client configuration

Any MCP client that can spawn a stdio server can use this server. Use an **absolute path** to
`src/server/main.mjs` and absolute paths for `--store` and `--auth`:

```json
{
  "mcpServers": {
    "jiflow-canvas-mcp": {
      "command": "node",
      "args": [
        "/absolute/path/to/jiflow-canvas-mcp/src/server/main.mjs",
        "--store", "/absolute/path/to/canvas-store",
        "--auth", "/absolute/path/to/auth.json"
      ],
      "env": {
        "CANVAS_MCP_TOKEN": "<your-token>"
      }
    }
  }
}
```

Notes:

- The `mcpServers` shape is the common MCP client configuration format; consult your client's documentation
  if it uses a different envelope. The important part is: `command: "node"`, the absolute server entry path,
  the two required flags, and the token supplied through the environment.
- The token is **only** accepted through the `CANVAS_MCP_TOKEN` environment variable. It is never accepted as
  a command-line argument.
- The server processes one JSON-RPC message at a time; each client `initialize` handshake negotiates a
  protocol version (see [ARCHITECTURE.md](ARCHITECTURE.md#mcp-method-support)).
- Logs go to the server's stderr, responses to stdout. A client should not mix the two.

## Authentication and scopes

Authentication is mandatory: **there is no anonymous mode, no demo bypass flag, and no way to start the
server without a matching token.** On startup the server checks the CLI configuration, the store directory,
the auth config file, and the token, in that order, and exits non-zero on the first failure.

The auth config is a JSON file containing only **SHA-256 digests** of tokens — never raw tokens:

```json
{
  "version": 1,
  "principals": [
    {
      "principalId": "agent-writer-a",
      "tokenSha256": "<64 lowercase hex characters>",
      "mode": "CANVAS_WRITE",
      "canvasIds": ["canvas-demo-a"],
      "allowedTools": null
    },
    {
      "principalId": "agent-reader",
      "tokenSha256": "<64 lowercase hex characters>",
      "mode": "READ_ONLY",
      "canvasIds": ["*"],
      "allowedTools": null
    }
  ]
}
```

Rules:

| Field | Rules |
|---|---|
| `version` | must be `1`. |
| `principalId` | `^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$`; unique token digests required. |
| `tokenSha256` | exactly 64 lowercase hex characters; duplicate digests across principals are rejected. |
| `mode` | `READ_ONLY` or `CANVAS_WRITE`; anything else makes the config invalid. |
| `canvasIds` | non-empty array of canvas ids, or the single wildcard `["*"]`; duplicates rejected. |
| `allowedTools` | `null`/absent = all whitelisted tools (subject to mode); otherwise a non-empty array of whitelisted tool names. Unknown tool names make the config invalid. |

Generate the digest for a token with Node (the token is read from the argument, never written to disk):

```bash
node -e "console.log(require('node:crypto').createHash('sha256').update(process.argv[1],'utf8').digest('hex'))" "your-token"
```

At startup the server hashes the token from `CANVAS_MCP_TOKEN` and compares it with every configured digest in
constant time (`crypto.timingSafeEqual`); exactly one match is required. A missing token exits **3** with
`CANVAS_AUTH_REQUIRED`; an unknown token exits **3** with `CANVAS_PRINCIPAL_UNKNOWN`.

`--agent-id` (optional) is recorded in audit logs and receipts as a label. It can never change the
authenticated `principalId` or the principal's permissions.

### Demo tokens (fictional, public, demo-only)

`npm run seed:demo` creates `examples/auth.demo.json` with these **deliberately weak, public demo fixtures**.
They are documented so the examples are reproducible; **never reuse them anywhere else**.

| Principal | Mode | Canvas scope | Token (public demo fixture) |
|---|---|---|---|
| `agent-writer-a` | `CANVAS_WRITE` | `canvas-demo-a` | `demo-writer-a-token` |
| `agent-writer-b` | `CANVAS_WRITE` | `canvas-demo-b` | `demo-writer-b-token` |
| `agent-reader` | `READ_ONLY` | `*` (all canvases) | `demo-reader-token` |

The auth file stores only the SHA-256 digest of each demo token.

## Tools

Exactly nine tools, all named `canvas_*` (the host/client may add its own namespace prefix). Every write tool
also accepts optional `expectedRevision` and `operationId` arguments.

| # | Tool | Permission | Required arguments | Optional arguments |
|---|---|---|---|---|
| 1 | `canvas_list_canvases` | `READ` | — | — |
| 2 | `canvas_read_canvas` | `READ` | `canvasId` | — |
| 3 | `canvas_read_node` | `READ` | `canvasId`, `nodeId` | — |
| 4 | `canvas_read_receipt` | `READ` | `canvasId`, `operationId` | — |
| 5 | `canvas_list_receipts` | `READ` | `canvasId` | `limit` (integer 1–100, default 20) |
| 6 | `canvas_create_node` | `WRITE` | `canvasId`, `kind`, `label` | `position`, `data`, `nodeId`, `expectedRevision`, `operationId` |
| 7 | `canvas_patch_node` | `WRITE` | `canvasId`, `nodeId` | `data`, `position`, `expectedRevision`, `operationId` (at least one of `data`/`position` required) |
| 8 | `canvas_connect_nodes` | `WRITE` | `canvasId`, `source`, `target` | `relation` (default `reference`), `edgeId`, `expectedRevision`, `operationId` |
| 9 | `canvas_commit_batch` | `WRITE` | `canvasId`, `actions` (1–100 actions) | `expectedRevision`, `operationId` |

Canvas/node/edge model summary (full tables in [`ARCHITECTURE.md`](ARCHITECTURE.md#data-model); a detailed
per-tool reference with every argument, result shape and raw JSON-RPC example is in
[`docs/TOOLS.md`](docs/TOOLS.md)):

- **Node kinds:** `text`, `image`, `video`, `audio`, `note`; each node is
  `{id, type, position: {x, y}, data}`.
- **Writable node data fields:** `label`, `status` (`idle`/`running`/`done`/`error`/`skipped`), `source`,
  `content`, `prompt`, `url` (must start with `http://` or `https://`), `mimeType`, `width`, `height`,
  `duration`, `errorMessage`. Protected fields (`nodeType`, `assetId`, `stateId`, and node-level `id`/`type`)
  are rejected if supplied by a caller.
- **Edges:** `{id, source, target, relation}`. Allowed relations are `image → video` with `reference` and
  `text → note` with `context`; self edges and duplicate ids/triples are rejected.
- **Batch actions:** `node.create`, `node.patch`, `edge.connect`. A batch is applied atomically as one
  revision.
- **Read results** include `ok`, `tool`, `permission`, `server: "jiflow-canvas-mcp"`, `principalId` and
  `agentId`. **Write results** additionally include `operationId`, `kind: "canvas.batch"`, `replayed`,
  `payloadHash`, `revision`, `result: {canvasId, revision, nodes, edges}` and the affected id(s).

Tool failures are returned as MCP tool results with `isError: true` and a JSON payload
`{ok: false, code, error, detail?}` using the stable error codes below — never as a crash.

## Writes: CAS, receipts and idempotent replay

A write is one `canvas.batch` operation:

```
{operationId, kind: "canvas.batch", payload: {canvasId, expectedRevision, actions: [...]}}
```

- **`expectedRevision`** — the revision the caller believes is current. If omitted, the dispatcher reads the
  current revision first (write results report `source: "provided"` or `source: "read"`), but the store still
  performs the CAS check. If the revision has moved in the meantime, the write fails with
  `CANVAS_REVISION_CONFLICT` and **nothing is written, no revision is bumped and no receipt is persisted**.
- **`operationId`** — the idempotency key. If omitted, the server generates `op-<uuid v4>`. If the same
  `operationId` is sent again:
  - same scope, same kind and **identical payload** (after canonical-JSON normalisation) → the stored result
    is returned with `replayed: true` at the original `resultingRevision`; no mutation, no new receipt;
  - a different payload/scope/kind → `CANVAS_OPERATION_PAYLOAD_CONFLICT` /
    `CANVAS_OPERATION_SCOPE_CONFLICT` / `CANVAS_OPERATION_KIND_CONFLICT`.
- **`payloadHash`** = `sha256(canonicalJson(payload))`; the receipt also records a **`scopeHash`** =
  `sha256(canonicalJson({principalId, canvasId}))`. Both use a deterministic canonical JSON form (sorted keys,
  `-0` normalised to `0`, non-finite numbers and cycles rejected).
- **Receipt fields** (public projection): `operationId`, `kind`, `payloadHash`, `scopeHash`,
  `expectedRevision`, `resultingRevision`, `actionKinds`, `principalId`, `agentId`, `committedAt`, `result`.
  Tokens, raw arguments and file contents are never stored in receipts.
- The receipt is written **inside the same canvas JSON state file, in the same atomic write** as the state
  change, so a committed operation always has a receipt and a failed operation has neither.

Because generated ids are fresh UUIDs on every call, a blind retry that omits `nodeId`/`edgeId`/`operationId`
is a *different* payload and will be rejected by the replay check. For retry-safe writes, pass explicit ids
and reuse them. See [Recovery and safe retries](#recovery-and-safe-retries).

## CLI reference

```text
node src/server/main.mjs --store <dir> --auth <file.json> [options]
```

| Flag | Required | Default | Description |
|---|---|---|---|
| `--store <dir>` | yes | — | Existing directory used as the canvas store (may be empty; subdirectories are created). |
| `--auth <file.json>` | yes | — | Auth config with token SHA-256 digests and scopes. |
| `--agent-id <id>` | no | principal id | ASCII label recorded in receipts and logs (1–64 printable characters). |
| `--lock-timeout-ms <n>` | no | `5000` | Maximum time to wait for a held canvas lock before `CANVAS_STORE_BUSY`. |
| `--stale-lock-ms <n>` | no | `10000` | Minimum age gate before a **provably dead** owner's lock is quarantined for recovery (liveness on the same host must say dead; age alone is never treated as death). |
| `--help`, `-h` | — | — | Print usage to stdout and exit `0`. |
| `--version`, `-v` | — | — | Print `0.1.0` to stdout and exit `0`. |

Exit codes:

| Code | Meaning |
|---|---|
| `0` | Normal operation: `--help`/`--version`, EOF on stdin, or graceful `SIGINT`/`SIGTERM`. |
| `1` | Unexpected internal error (`CANVAS_INTERNAL_ERROR`). |
| `2` | Configuration/store problem (missing/invalid `--store`, bad numeric flag, unknown flag, corrupt store on startup). |
| `3` | Authentication problem (`CANVAS_AUTH_REQUIRED`, `CANVAS_AUTH_CONFIG_INVALID`, `CANVAS_PRINCIPAL_UNKNOWN`). |

stdout is the protocol channel and carries only JSON-RPC responses. All diagnostics and audit logs are JSON
lines on stderr.

## Store layout

```text
<store>/
  canvases/
    <canvasId>.json        # one canvas state file per canvas (state + receipts + lockFence)
  .locks/
    <canvasId>.lock        # JSON lock owner record: token, pid, hostname, fence (0600 file)
    <canvasId>.fence       # monotonic lock-generation counter (0600 file)
    .<canvasId>.recovery   # hidden per-canvas recovery marker (0600 file; serialises dead-owner recovery)
    .<canvasId>.recovery-guard # hidden recovery guard (0600 file; serialises dead-marker reclaim; never auto-reclaimed)
    .claim-… / .marker-claim-… / .guard-claim-… / .quarantine-… / .marker-quarantine-…   # short-lived temp files
```

- Canvas ids must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` and may not contain `..`, `/` or `\`; they are
  validated **before** any path join, so the store never reads or writes outside `<store>`.
- State files are JSON with top-level `storeVersion: 1`, `canvas`, `revision`, `data: {nodes, edges}`,
  `tombstones`, `receipts`, `updatedAt` and an optional `lockFence` (the lock generation that committed the
  last write). A malformed or wrong-shape file is reported as `CANVAS_STORE_CORRUPT` and is never silently
  re-initialised.
- Temp files used for atomic writes are created inside `canvases/` with mode `0600` and cleaned up on failure.
- Reads do not take the lock: writes replace the whole file atomically, so a reader sees either the old or
  the new state. Writes acquire the owner-record lock, verify ownership, re-read the authoritative revision
  and `lockFence` inside it, and commit exactly once. Crash recovery additionally uses the hidden recovery
  marker and recovery guard; `inspectCanvasLock(storeDir, canvasId)` reports their state read-only.

A full example state file is in [`ARCHITECTURE.md`](ARCHITECTURE.md#store-format).

## Error codes

All error codes are stable, machine-readable strings. The MCP payload is
`{ok: false, code, error: "<message>", detail?: {...}}`; `detail` never contains tokens or raw caller content
beyond ids and revisions. The registry contains **40 stable codes in six groups**.

**Tool and argument errors**

| Code | Meaning |
|---|---|
| `CANVAS_TOOL_NOT_WHITELISTED` | A tool name that is not one of the nine whitelisted tools (checked before any store access). |
| `CANVAS_TOOL_UNKNOWN` | Missing or non-string tool name. |
| `CANVAS_TOOL_DENIED` | Tool is whitelisted but not in the principal's `allowedTools`. |
| `CANVAS_ARGUMENTS_INVALID` | Arguments fail schema validation / unknown keys / malformed shape. |
| `CANVAS_ACTION_NOT_WHITELISTED` | Batch action kind is not `node.create`, `node.patch` or `edge.connect`. |
| `CANVAS_ACTION_INVALID` | Malformed action shape or invalid action values. |

**Authentication and authorisation errors**

| Code | Meaning |
|---|---|
| `CANVAS_AUTH_REQUIRED` | `CANVAS_MCP_TOKEN` missing or empty (startup, exit 3). |
| `CANVAS_AUTH_CONFIG_INVALID` | Auth config unreadable, invalid JSON or schema violation (startup, exit 3). |
| `CANVAS_PRINCIPAL_UNKNOWN` | Token matches no configured principal (startup, exit 3). |
| `CANVAS_READ_ONLY` | `READ_ONLY` principal attempted a write tool. |
| `CANVAS_AUTH_DENIED` | Authorisation failed (including forged/untrusted operation scopes). |
| `CANVAS_CANVAS_SCOPE_MISMATCH` | Canvas is outside the principal's `canvasIds`. |

**Canvas model errors**

| Code | Meaning |
|---|---|
| `CANVAS_CANVAS_ID_INVALID` | Invalid canvas id (shape/traversal). |
| `CANVAS_CANVAS_NOT_FOUND` | No state file for an in-scope canvas. |
| `CANVAS_NODE_ID_INVALID` | Invalid node id (shape/traversal). |
| `CANVAS_NODE_ID_CONFLICT` | Node id already used by a node, edge, tombstone, canvas or operation id. |
| `CANVAS_NODE_NOT_FOUND` | Node (or edge endpoint) does not exist. |
| `CANVAS_NODE_FIELD_PROTECTED` | Caller supplied a protected node data field. |
| `CANVAS_NODE_FIELD_UNKNOWN` | Unknown node data field. |
| `CANVAS_NODE_FIELD_INVALID` | Node data field has an invalid type/length/value. |
| `CANVAS_POSITION_INVALID` | Position is not exactly two finite numbers. |
| `CANVAS_EDGE_ID_INVALID` | Invalid edge id. |
| `CANVAS_EDGE_ID_CONFLICT` | Duplicate edge id or duplicate `(source,target,relation)`. |
| `CANVAS_EDGE_NOT_FOUND` | Edge does not exist. |
| `CANVAS_EDGE_RELATION_INVALID` | Relation not allowed by the capability table, or self edge. |

**Revision, operation and receipt errors**

| Code | Meaning |
|---|---|
| `CANVAS_REVISION_REQUIRED` | No usable `expectedRevision` (omitted and the current revision could not be read). |
| `CANVAS_REVISION_CONFLICT` | `expectedRevision` is stale; `detail` has `{expectedRevision, actualRevision}`. |
| `CANVAS_REVISION_EXHAUSTED` | Revision space exhausted (never expected in practice). |
| `CANVAS_OPERATION_ID_INVALID` | Invalid `operationId` shape. |
| `CANVAS_OPERATION_REQUEST_INVALID` | Malformed operation envelope. |
| `CANVAS_OPERATION_SCOPE_CONFLICT` | `operationId` already used by a different scope. |
| `CANVAS_OPERATION_KIND_CONFLICT` | `operationId` already used by a different operation kind. |
| `CANVAS_OPERATION_PAYLOAD_CONFLICT` | `operationId` already used with a different payload. |
| `CANVAS_RECEIPT_NOT_FOUND` | No receipt for that `operationId` on that canvas. |

**Lock errors**

| Code | Meaning |
|---|---|
| `CANVAS_LOCK_OWNERSHIP_LOST` | The operation's lock generation is no longer the current owner/fence; **no state is written**. Re-read the canvas revision and retry (never delete lock files). |
| `CANVAS_LOCK_UNVERIFIABLE` | The lock/recovery state cannot be validated safely (corrupt lock/marker/guard record, foreign host, hard links unavailable, ambiguous liveness, or a **dead recovery-guard holder**). **Fail closed**: no write, no takeover. For a dead/foreign/corrupt/ambiguous recovery guard the `detail` carries `action: MANUAL_OPERATOR_CLEANUP_REQUIRED` and `reason` one of `GUARD_OWNER_DEAD`, `GUARD_FOREIGN_HOST`, `GUARD_RECORD_INVALID`, `GUARD_LIVENESS_UNKNOWN`; live or foreign state is never moved or deleted. |

**Store and runtime errors**

| Code | Meaning |
|---|---|
| `CANVAS_STORE_UNAVAILABLE` | Store directory missing/unwritable, or state could not be persisted. |
| `CANVAS_STORE_BUSY` | A live owner holds the canvas lock (or a live recovery guard/marker is mid-recovery) and `--lock-timeout-ms` elapsed. Live holders are never preempted. |
| `CANVAS_STORE_CORRUPT` | A canvas state file is unparseable or has the wrong shape. |
| `CANVAS_INTERNAL_ERROR` | Unexpected internal failure (no internal details leaked). |

## Examples

The [`examples/`](examples/README.md) directory contains zero-cost, fictional-data demos:

| Command | What it demonstrates |
|---|---|
| `npm run seed:demo` | Recreates two fictional canvases (revision 0) and the fictional auth config from scratch. |
| `npm run demo` | Real stdio server: `initialize` → `tools/list` (9 tools) → read → create → patch → connect → receipt → idempotent replay. |
| `npm run demo:conflict` | Two real server processes read the same revision, both attempt a write with stale `expectedRevision`: exactly one succeeds, one gets `CANVAS_REVISION_CONFLICT`; the loser re-reads and retries; the winner's operation is replayed cross-process. |

`examples/` is included in the package `files` allowlist; the generated `examples/demo-store/` is git-ignored
and never part of a release.

## Recovery and safe retries

The server is designed so that a crash, a timeout or a lost response never requires guessing whether a write
landed:

1. **Check before retrying.** If a response was lost, read `canvas_read_receipt` with the explicit
   `operationId` (or `canvas_list_receipts` to see the newest receipts on the canvas). A receipt means the
   operation committed; its `resultingRevision` and `result` tell you what changed.
2. **Retry with the identical payload.** To get idempotent replay, resend the exact same `operationId` and
   the same arguments. Include explicit `nodeId`/`edgeId` when creating things so the payload is stable.
3. **A stale revision is not an error condition to abuse.** `CANVAS_REVISION_CONFLICT` means another writer
   won; re-read the canvas, recompute your change against the new state, and submit with the fresh
   `expectedRevision` (use a new `operationId`, because the payload/state changed).
4. **`CANVAS_STORE_BUSY`** means a **live** owner holds the per-canvas lock, or a live recovery guard/marker is
   mid-recovery, and `--lock-timeout-ms` elapsed. Retry after a short delay. Live holders are never preempted;
   a crashed lock owner is recovered only when it is **provably dead on the same host** (liveness check) and
   its lock is older than `--stale-lock-ms` (default 10 s). Never delete a lock file manually.
5. **`CANVAS_LOCK_OWNERSHIP_LOST`** means your operation's lock generation was superseded before the write:
   nothing was written. Re-read the canvas (fresh revision) and retry with a new attempt; do not reuse the
   stale lock state and do not remove lock files.
6. **`CANVAS_LOCK_UNVERIFIABLE`** means the lock/recovery state could not be validated safely (corrupt
   owner/fence/marker/guard record, foreign host, hard links unavailable, ambiguous liveness, or a **dead
   recovery-guard holder**). The server fails closed and writes nothing. Recovery nuance:
   - a crashed **recovery-marker** holder is recovered automatically — the next process claims the recovery
     guard and safely reclaims the dead marker, then continues dead-owner recovery;
   - a crashed **recovery-guard** holder is **not** auto-reclaimed (this would re-open the race the guard
     exists to prevent); dead-marker recovery for that canvas fails closed and needs operator action. A dead
     guard reports `detail.reason` `GUARD_OWNER_DEAD` (or `GUARD_FOREIGN_HOST` / `GUARD_RECORD_INVALID` /
     `GUARD_LIVENESS_UNKNOWN`) with `action: MANUAL_OPERATOR_CLEANUP_REQUIRED`. The guard is only used by the
     recovery path, so normal reads/writes on a healthy canvas never touch it.

   Operator procedure for a dangling recovery guard (only if writes keep failing with this code):
   1. stop every canvas server process that uses this store;
   2. run the read-only library diagnostic `inspectCanvasLock(storeDir, canvasId)` and confirm the reported
      `recoveryGuard` owner is dead and that no live writer/marker/guard exists;
   3. only then remove the dangling file `<store>/.locks/.<canvasId>.recovery-guard`;
   4. retry. Never remove a live or foreign guard, and never delete the write lock `.lock` file.

   Treat a cross-host or network-filesystem store as unsupported.
7. **`CANVAS_STORE_CORRUPT`** means the state file is unreadable; back it up and inspect it manually. The
   server never re-initialises or overwrites a corrupt canvas.

A longer, copy-pasteable set of retry patterns is in [`docs/RECOVERY.md`](docs/RECOVERY.md).

## Verification status

This candidate passed independent technical verification: the tests and acceptance matrix below were
re-executed by an independent reviewer with real server subprocesses speaking real JSON-RPC over stdio
(no protocol mocks). The results below are from those real runs; raw logs are internal verification records
and are **not** part of this repository.

| Command | Result |
|---|---|
| `npm test` (`node --test "test/**/*.test.mjs"`) | **exit 0 — 179 tests / 40 suites, 179 pass, 0 fail, 0 skipped** (Node.js v24.11.1; captured as acceptance check `C11_automated_test_suite`). The explicit glob makes discovery deterministic: only `*.test.mjs` files run. Composition: **155 preserved regression tests** (lock-primitive tests adapted 1:1, no assertions weakened) **+ 13 multi-process lock-safety tests + 5 scanner tests + 6 recovery-marker-race tests** = 179 real tests. (An earlier bare `node --test` discovery also counted 9 helper modules as file-level entries; the explicit glob no longer does.) |
| Lock-safety suite (inside `npm test`: `test/concurrency/lock-safety.test.mjs`) | **13/13 PASS** — live owner past the old stale threshold is not preempted (`CANVAS_STORE_BUSY` for the contender); ownership-checked release cannot delete a foreign lock; A/B/C critical sections are strictly non-overlapping (15 critical sections, 0 overlaps); a stale handle write is rejected with `CANVAS_LOCK_OWNERSHIP_LOST` and leaves the state byte-identical; SIGKILLed holder recovery waits for proven death + age and completes safely; 4 real MCP server processes keep revisions/receipts exact under CAS retry; the same `operationId` from two real processes applies once and replays once; different canvases run without unnecessary blocking; **25 rounds of randomized 3–5-process contention ran 94 operations with 0 overlapping critical sections** (final revision 94, nodes 97, receipts 94); a multi-recoverer race on one dead-owner lock had exactly one winner; corrupt/foreign-host/malformed-fence/legacy locks fail closed as `CANVAS_LOCK_UNVERIFIABLE` and are never taken over. |
| Recovery-marker race suite (inside `npm test`: `test/concurrency/recovery-marker-race.test.mjs`) | **6/6 PASS** — a deterministic pre-fix reproduction on the earlier implementation **reproduces** the race (a live recovery marker moved/deleted; two recovery owners), while on this implementation the race is **not reproducible**. Coverage: live guard/marker never preempted; two recoverers of a dead marker cannot both pass the guard (one wins, the other gets `CANVAS_STORE_BUSY`); dead-marker reclaim happens only under the guard after same-dead-owner revalidation; a crashed guard holder fails closed with `CANVAS_LOCK_UNVERIFIABLE` and intact marker/state; a crashed marker holder auto-recovers through the guard; a stale-handle write is rejected with `CANVAS_LOCK_OWNERSHIP_LOST` and the state is unchanged. |
| `npm run test:acceptance` (`node scripts/verify/run-acceptance.mjs`) | **exit 0 — overall `PASS`, 11/11 checks PASS** (`C01_standalone_start`, `C02_mcp_handshake`, `C03_read_canvas`, `C04_create_node`, `C05_patch_node`, `C06_connect_nodes`, `C07_concurrency_conflict`, `C08_unauthorized_rejected`, `C09_operation_receipt`, `C10_isolation_security`, `C11_automated_test_suite` with 179/179) on Node.js v24.11.1 / npm 11.6.2 / darwin arm64. |
| `npm run audit:secrets` (secret/PII/private-reference scan) | **exit 0 — RESULT CLEAN**: 63 text files scanned, 10 findings all allowlisted fictional demo/fixture references, 0 failures; strict internal mode loaded 10 local-only restricted rules (the public scanner is generic and does not need that local file). |
| `npm run seed:demo && npm run demo && npm run demo:conflict` | Each command exited `0`; the demo exercised read/create/patch/connect/receipt/replay and a two-process CAS conflict + retry (the independent verifier covers the same behaviours in C01–C09). |

The acceptance matrix is black-box: it boots the server from an isolated temp copy of `src/` + `package.json`
without `node_modules`, exercises raw JSON-RPC and the official `@modelcontextprotocol/sdk@1.30.0` client, and
checks standalone start, handshake, reads, writes, concurrency conflict, authorization rejection, receipts,
isolation/security and the full test suite. See [`ARCHITECTURE.md`](ARCHITECTURE.md#verification-evidence) for
what these checks do and do not prove.

## Limitations

This is an early, single-user-local server, not a production multi-tenant service. Known limitations:

- **Local single-user store.** One store directory on one machine; no sharing, replication, backup or
  migration tooling is provided.
- **Static tokens only.** Tokens are configured in a JSON file with no rotation, expiry, revocation API or
  per-session identities. Changing a token means editing the auth file and restarting the server.
- **No TLS.** Authentication is a bearer token over a local stdio pipe; there is no network listener and no
  transport encryption. If you wrap or expose the server remotely, transport security is your responsibility.
- **No multi-tenant auth server / identity provider.** Principals are operator-configured; there is no OAuth,
  no directory integration and no delegated identity.
- **No delete tools.** v1 supports create/patch/connect only; there is no node/edge delete, group or
  move/copy tool.
- **Synchronous I/O.** Store reads/writes and the lock wait are synchronous (deliberate, for a simple
  single-writer critical section); a large canvas delays other messages in that process.
- **One message at a time per process.** The server processes stdin JSON-RPC messages in arrival order; it
  does not parallelise tool calls within a process. Multi-process concurrency is supported through the store,
  not through in-process parallelism.
- **Single-host lock safety.** Crash recovery relies on same-host process liveness (`process.kill(pid, 0)`).
  Stores shared across hosts (network filesystems, NFS/SMB, containers with different hostnames) are
  **unsupported**: a foreign-host owner record fails closed with `CANVAS_LOCK_UNVERIFIABLE`; it is never
  taken over. There is also no distributed consensus or cross-machine coordination.
- **PID reuse is fail-closed, not resolved.** If a crashed owner's PID is immediately reused by another live
  process, the lock is treated as held by a live owner (wait → `CANVAS_STORE_BUSY`) rather than preempted;
  there is no PID-start-time check. Recovery happens only when liveness is definitively `ESRCH` and the age
  gate has elapsed.
- **Recovery-guard crash needs operator cleanup.** A crashed recovery-guard holder is deliberately not
  auto-reclaimed (auto-reclaim would re-open the recovery race). Dead-marker recovery for that canvas then
  fails closed with `CANVAS_LOCK_UNVERIFIABLE` until a trusted operator, with all canvas processes stopped,
  verifies the state with `inspectCanvasLock` and removes the dangling guard file. Normal writes on a healthy
  canvas are unaffected because they never touch the guard. This is a fail-closed availability trade-off, not
  silent repair.
- **No external security audit yet.** No fuzzing or penetration-test evidence exists; the security claims in
  [`SECURITY.md`](SECURITY.md) are design/verification claims, not an audit certification.
- **No release yet.** No npm package, no Git tag, no CI pipeline, no published repository. The final public
  release requires the final independent audit and verification of the real repository URL.

## Security

See [`SECURITY.md`](SECURITY.md) for the threat model, trust boundary, token handling, fail-closed startup,
path containment, audit log fields and known risks. In short: the server is a local stdio process with only
nine canvas tools; it has no shell/file/network tools, refuses to start without a matching token, and keeps raw
tokens out of disk, receipts and logs.

To report a security issue, use the private reporting instructions in [`SECURITY.md`](SECURITY.md#reporting).

## License

**MIT licensed. The full MIT license text is in [`LICENSE`](LICENSE). The source is publicly available on GitHub; it is not published to npm.**

- Copyright (c) 2026 chen gs; the MIT `LICENSE` file is included in this repository. The LICENSE applies
  only to the project code in this repository, not to third-party dependencies.
- The third-party dependency audit found **zero runtime dependencies** and an all-permissive dev-only tree
  (`@modelcontextprotocol/sdk@1.30.0`, MIT) — no third-party licensing conflict with an MIT release.
- The owner has approved the MIT license for this candidate; the provenance audit found no copied upstream
  source in the package, and the only dev dependency is MIT-licensed (`@modelcontextprotocol/sdk@1.30.0`).
- `package.json` declares `"license": "MIT"` and the repository contains the `LICENSE` file.
- The v0.1.0 source release is available through GitHub Releases; no npm package has been published.
- The public release contains **only** the files in this repository; internal audit, provenance and verification
  records are never published.

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for the architecture, [`SECURITY.md`](SECURITY.md) for the security
model, and [`docs/TOOLS.md`](docs/TOOLS.md) / [`docs/RECOVERY.md`](docs/RECOVERY.md) for the tool and recovery
references.
