# Architecture — jiflow-canvas-mcp

This document describes the implemented architecture of `jiflow-canvas-mcp` v0.1.0: the process model,
layers, data model, on-disk store format, locking/CAS/atomic-commit protocol, operation receipts and replay,
authentication and authorization, the MCP protocol surface, the concurrency model, the library API, and the
design rationale for its generic mechanisms.

Everything here describes the code under `src/` in this repository. Where a claim is backed by test or
acceptance evidence, that evidence is summarized in this document.

> **Status:** **MIT licensed**; the project is publicly available at
> [`q973946080/jiflow-canvas-mcp`](https://github.com/q973946080/jiflow-canvas-mcp). Release verification passed 179/179
> automated tests and 11/11 functional acceptance checks. The v0.1.0 source release is available through GitHub
> Releases; the project is not published to npm. Internal audit, provenance and verification records are not published.

## Contents

- [Process model](#process-model)
- [Layers](#layers)
- [Data model](#data-model)
- [Store format](#store-format)
- [Locking, CAS and atomic commit](#locking-cas-and-atomic-commit)
- [Operation receipts and replay](#operation-receipts-and-replay)
- [Canonical JSON and hashes](#canonical-json-and-hashes)
- [Authentication and authorization](#authentication-and-authorization)
- [MCP method support](#mcp-method-support)
- [Concurrency model](#concurrency-model)
- [Audit logging](#audit-logging)
- [Library API](#library-api)
- [Verification evidence](#verification-evidence)
- [Design note](#design-note)

## Process model

One server process = one MCP client connection over a stdio pipe.

```text
MCP client (agent host)
   │  newline-delimited JSON-RPC 2.0 on stdin
   ▼
node src/server/main.mjs --store <dir> --auth <auth.json>
   │  responses on stdout, audit/diagnostic JSON lines on stderr
   ▼
<store>/canvases/*.json  +  <store>/.locks/*.lock  +  <store>/.locks/*.fence
```

- The server is spawned by the MCP client; it is not a daemon and does not listen on a network port.
- The process reads newline-delimited JSON-RPC messages from stdin and writes responses to stdout. stdout is
  a **pure protocol channel**: nothing else is ever written there. Logs go to stderr.
- Multiple server processes may share one `<store>` directory; that is the supported multi-agent model.
- The store directory must already exist. The server creates `<store>/canvases/` and `<store>/.locks/` on
  startup.
- Authentication is resolved **once at startup** from a static token; a server process serves exactly one
  principal. Permissions cannot change while the process runs.

## Layers

```text
┌────────────────────────────────────────────────────────────────────┐
│ 1. Transport: newline-delimited JSON-RPC 2.0 over stdio            │
│    src/mcp/server.mjs              (one message at a time)         │
├────────────────────────────────────────────────────────────────────┤
│ 2. Protocol methods: initialize / ping / tools/list / tools/call   │
│    + notifications (no response)                                   │
├────────────────────────────────────────────────────────────────────┤
│ 3. Dispatcher pipeline  src/mcp/dispatch.js                        │
│    a. tool whitelist                                               │
│    b. identity validation (canvas/node/edge/operation ids)         │
│    c. JSON-Schema-subset argument validation + narrowing           │
│    d. principal authorization (allowedTools, mode, canvas scope)   │
├────────────────────────────────────────────────────────────────────┤
│ 4. Canvas domain  src/canvas/domain.js                             │
│    read/list projections · execute(scope, envelope)                │
├────────────────────────────────────────────────────────────────────┤
│ 5. Operation runtime  src/operations/runtime.js                    │
│    envelope validation · authorize() === true · receipts · replay  │
│    · CAS revision check · action handlers · atomic commit          │
├────────────────────────────────────────────────────────────────────┤
│ 6. Store + lock  src/store/store.js, src/store/lock.js             │
│    atomic JSON files · fenced owner-file lock · temp+fsync+rename  │
└────────────────────────────────────────────────────────────────────┘
        audit logger (stderr JSON lines) is used by the dispatcher
```

Design rules visible in the code:

- **Whitelist-first.** The dispatcher rejects any tool name not in the nine-tool whitelist before touching
  arguments or the store. The whitelist (`src/mcp/whitelist.js`) is the single source of truth for tool
  names, permissions and input schemas; `tools/list` serves its public projection.
- **Narrowing, not coercion.** Argument validation (`src/mcp/validate.js`) supports a small JSON-Schema
  subset (`type`, `oneOf`, `properties`, `required`, `additionalProperties`, `items`, `enum`, `const`),
  rejects unknown keys (`additionalProperties: false` everywhere), and returns a narrowed copy — undeclared
  keys are dropped, never silently accepted. Values are never coerced.
- **Authorization authority below the gateway.** The dispatcher checks principal permissions, but the domain
  and the operation runtime also call `authorize(...)` and require it to return exactly `true` before
  mutating. A forged operation scope is rejected by the runtime (trusted scopes are tracked in a `WeakSet`).
- **Side-effect-free reads.** Read tools never take the lock and never write; they read the current state file
  and project it. Writes go through the operation runtime only. The store exposes one write closure
  (`updateCanvas`) that always runs inside a **fenced** canvas lock: it verifies lock ownership before the
  updater, stamps the persisted `lockFence`, and verifies ownership again immediately before the atomic write.

## Data model

### Nodes

- Node kinds (`CANVAS_NODE_KINDS`): **`text`**, **`image`**, **`video`**, **`audio`**, **`note`**.
- Node shape:

  ```json
  {
    "id": "node-welcome",
    "type": "text",
    "position": { "x": 0, "y": 0 },
    "data": { "nodeType": "text", "label": "Welcome", "content": "hello", "status": "idle" }
  }
  ```

- `id` shape: `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`, no `..`, `/` or `\`. Node ids must not collide with an
  existing node, edge, tombstone, the canvas id or an operation id (`CANVAS_NODE_ID_CONFLICT`).
- `position` must be exactly `{x, y}` with two finite numbers; create defaults to `{x: 0, y: 0}`.
- `type` equals `data.nodeType` for stored nodes. On create the server injects `data.nodeType = kind`, and
  callers may not supply it themselves.

**Mutable node `data` fields** (the only caller-writable fields; each create/patch rejects everything else):

| Field | Type | Constraints |
|---|---|---|
| `label` | string | trimmed non-empty, at most 256 characters |
| `status` | string | one of `idle`, `running`, `done`, `error`, `skipped` |
| `source` | string | at most 256 characters |
| `content` | string | at most 65536 characters |
| `prompt` | string | at most 65536 characters |
| `url` | string | at most 2048 characters, must start with `https://` or `http://` |
| `mimeType` | string | at most 128 characters |
| `width` | integer | positive safe integer |
| `height` | integer | positive safe integer |
| `duration` | number | finite and > 0 |
| `errorMessage` | string | at most 4096 characters |

**Protected `data` fields** (`nodeType`, `assetId`, `stateId`, and node-level `id`/`type` inside `data`) are
rejected with `CANVAS_NODE_FIELD_PROTECTED`. Unknown data fields are rejected with
`CANVAS_NODE_FIELD_UNKNOWN`; wrong types/values with `CANVAS_NODE_FIELD_INVALID`.

### Edges

- Edge shape: `{ "id": "edge-1", "source": "node-a", "target": "node-b", "relation": "reference" }`.
- Edges are validated against the **node capability table**:

| Source kind | Allowed relation | Target kind |
|---|---|---|
| `image` | `reference` | `video` |
| `text` | `context` | `note` |
| all others | — | — |

- A self edge, an unknown relation, or a source/target combination not in the table is
  `CANVAS_EDGE_RELATION_INVALID`.
- Duplicate edge id or duplicate `(source, target, relation)` triple is `CANVAS_EDGE_ID_CONFLICT`.
- A missing source or target node is `CANVAS_NODE_NOT_FOUND`.
- Edge ids share the node/operation id shape; invalid ids are `CANVAS_EDGE_ID_INVALID`.

### Actions and revisions

- `canvas_commit_batch` accepts 1–100 ordered actions of exactly three kinds (`ACTION_KINDS`):
  `node.create` (`{kind, node}`), `node.patch` (`{kind, nodeId, patch}`) and `edge.connect`
  (`{kind, edge}`). Anything else is `CANVAS_ACTION_NOT_WHITELISTED`; malformed shapes are
  `CANVAS_ACTION_INVALID`.
- A batch is applied to a deep clone of the canvas state inside the lock. If any action fails validation,
  **no action is applied**, the revision is not bumped and no receipt is written.
- Any accepted operation increments the canvas `revision` by **exactly 1**, regardless of how many actions
  it contains (`CANVAS_REVISION_EXHAUSTED` if the safe-integer range is exhausted — not reachable in
  practice).
- Deleted ids are tombstoned (`tombstones.nodes` / `tombstones.edges`) and cannot be reused. v1 has no
  delete tools; tombstones exist so pre-seeded fixtures stay honest and future delete support does not
  silently allow id reuse.

## Store format

```text
<store>/
  canvases/
    <canvasId>.json        # canvas state + receipts (one file per canvas)
  .locks/
    <canvasId>.lock        # JSON lock owner record: token, pid, hostname, fence (mode 0600)
    <canvasId>.fence       # monotonic lock-generation counter (mode 0600)
    .<canvasId>.recovery   # hidden per-canvas recovery marker (serialises dead-owner recovery; 0600)
    .<canvasId>.recovery-guard # hidden recovery guard (serialises dead-marker reclaim; 0600; never auto-reclaimed)
    .claim-…json / .marker-claim-…json / .guard-claim-…json     # short-lived claim temp files
    .quarantine-…json / .marker-quarantine-…json                # short-lived temp files used when reclaiming dead records
```

`canvasId` must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` and may not contain `..`, `/` or `\`. The id is
validated **before any path join**, so the store cannot be pointed outside `<store>` by a malicious id.

A canvas state file (shown abbreviated — prettified when written):

```json
{
  "storeVersion": 1,
  "canvas": {
    "canvasId": "canvas-demo-a",
    "name": "Demo canvas A",
    "createdAt": "2026-01-01T00:00:00.000Z"
  },
  "revision": 1,
  "lockFence": 1,
  "data": {
    "nodes": [
      {
        "id": "node-welcome",
        "type": "text",
        "position": { "x": 40, "y": 80 },
        "data": {
          "nodeType": "text",
          "label": "Welcome to the demo canvas",
          "content": "This is fictional demo data generated for the example.",
          "status": "idle"
        }
      }
    ],
    "edges": []
  },
  "tombstones": { "nodes": [], "edges": [] },
  "receipts": {
    "op-demo-create-0001": {
      "operationId": "op-demo-create-0001",
      "kind": "canvas.batch",
      "payloadHash": "<sha256 hex of canonical payload>",
      "scopeHash": "<sha256 hex of canonical {principalId, canvasId}>",
      "scope": { "principalId": "agent-writer-a", "canvasId": "canvas-demo-a" },
      "expectedRevision": 0,
      "resultingRevision": 1,
      "actionKinds": ["node.create"],
      "principalId": "agent-writer-a",
      "agentId": "agent-writer-a",
      "committedAt": "2026-10-21T11:29:09.400Z",
      "durationMs": 3,
      "result": { "canvasId": "canvas-demo-a", "revision": 1, "nodes": 2, "edges": 0 }
    }
  },
  "updatedAt": "2026-10-21T11:29:09.400Z"
}
```

Read rules enforced by `src/store/store.js`:

- A missing file for an in-scope canvas is `CANVAS_CANVAS_NOT_FOUND` — the server never auto-creates a canvas.
- Unparseable JSON or a wrong shape is `CANVAS_STORE_CORRUPT`; the store never silently re-initialises.
- `canvas_list_canvases` scans `canvases/*.json` whose filename matches the id pattern, skips unreadable
  files during listing, filters by the principal's scope and sorts by `canvasId`.
- State files are written with mode `0600` (temp file opened with `0o600`, then renamed over the target).
  Note: an existing file's permissions are determined by how it was created; the store does not `chmod`
  files it did not create.
- `lockFence` is an optional additive state field; when present it must be a non-negative safe integer
  (`CANVAS_STORE_CORRUPT` otherwise).

## Locking, CAS and atomic commit

`createFileCanvasStore(...).updateCanvas(canvasId, updater)` is the only write path. Writers serialise through
a **safe per-canvas owner-file lock** (`src/store/lock.js`), and the state write itself is fenced and atomic.

### Lock protocol (owner record + monotonic fence)

```text
.locks/<canvasId>.lock    JSON owner record (mode 0600):
  {"version":1,"canvasId":"…","token":"<uuid>","pid":123,"hostname":"…","acquiredAt":"…","fence":7}
.locks/<canvasId>.fence   {"version":1,"fence":<int>}   — monotonic lock-generation counter
```

Acquire (`acquireCanvasLock`):

1. Write a complete claim record (`fence: 0`) to a unique `.claim-<canvasId>-<pid>-<random>.json` temp file
   (mode `0600`, `fsync`).
2. `fs.linkSync(claim, lockPath)` — atomic on a local filesystem: exactly one process can create the link,
   every other process gets `EEXIST`. The claim file is then unlinked, so a reader observes either no lock or
   a complete owner record, never a partial write.
3. On `EEXIST`, inspect the existing owner:
   - invalid/unknown-version record, owner record from another hostname, or liveness that cannot be
     determined → `CANVAS_LOCK_UNVERIFIABLE` — **fail closed, never take over**;
   - same-host liveness via `process.kill(pid, 0)` says **alive** (success or `EPERM`) → **never preempt**;
     sleep 5–25 ms with jitter until the deadline, then `CANVAS_STORE_BUSY`;
   - liveness says **provably dead** (`ESRCH`) → recovery additionally requires the lock file age to exceed
     `--stale-lock-ms` (a conservative gate, never proof of death by itself). Recovery is serialised by a
     hidden per-canvas **recovery marker** (`.<canvasId>.recovery`). Only the marker holder may remove a dead
     owner's lock record. Under the marker the recoverer re-reads the lock path and requires the **same**
     provably dead owner (token/pid/hostname/fence), re-checks liveness and age, then unlinks it and retries
     the claim while still holding the marker. A dead recovery marker may itself be reclaimed **only while
     holding a separate recovery guard** (next subsection), which closes the delayed-recoverer race in which a
     stale read could otherwise move a lock that had been legitimately reclaimed by a live owner.
4. The winner reads the fence file (missing = 0), atomically writes `fence + 1`, rewrites the owner record with
   that fence, and returns a frozen handle
   `{canvasId, storeDir, token, pid, hostname, acquiredAt, fence, lockPath, fencePath}`.

Verify (`verifyCanvasLock(handle)`, read-only): re-reads the owner record and the fence file and returns
`{ok: true}` only when token/pid/hostname/fence all match and the fence file equals the handle's fence.
Otherwise it returns `{ok: false, reason}` with `LOCK_MISSING`, `LOCK_OWNER_MISMATCH`,
`LOCK_FENCE_MISMATCH` or `LOCK_HANDLE_INVALID`. It never throws.

Release (`releaseCanvasLock(handle)`): reads the owner record and unlinks the lock **only** when the on-disk
token/pid/hostname match the handle. A foreign lock, an already-released lock or a lost handle returns `false`;
release is idempotent and never throws. It can never delete another owner's lock.

### Recovery guard (dead-marker reclaim)

The recovery marker is itself a JSON owner record. Reclaiming a dead marker by quarantining it is only safe
under a second, strictly weaker-use mutex: the **recovery guard** (`.<canvasId>.recovery-guard`, claimed with
the same complete-record hard-link primitive, ownership-checked release).

- A dead marker (same host, liveness `ESRCH`, age past `--stale-lock-ms`) may be quarantined **only by the
  current guard holder**. Under the guard, the marker is re-read and must still be the **same provably dead
  owner** (token/pid/hostname/fence, liveness re-checked, age re-checked); it is then quarantine-renamed, the
  quarantined record is re-validated, and only that record is unlinked. The guard is always released in
  `finally`, then the normal marker claim is retried. A live or foreign marker is never touched.
- A **live** guard holder is never preempted (wait → `CANVAS_STORE_BUSY`). A **dead / foreign-host / corrupt /
  ambiguous-liveness** guard is **never auto-reclaimed** — doing so would re-open the race the guard exists to
  close. The lock acquisition fails closed with `CANVAS_LOCK_UNVERIFIABLE`, an operator-actionable `detail`
  (`action: MANUAL_OPERATOR_CLEANUP_REQUIRED`, `recoveryGuardFile: .locks/.<canvasId>.recovery-guard`) and a
  machine-readable `detail.reason` of `GUARD_OWNER_DEAD`, `GUARD_FOREIGN_HOST`, `GUARD_RECORD_INVALID` or
  `GUARD_LIVENESS_UNKNOWN`. A documented manual-cleanup procedure applies.
- Crash semantics: a crashed **recovery-marker** holder is recovered automatically — the next process claims
  the guard and safely reclaims the dead marker, then continues dead-owner recovery. A crashed **recovery-guard**
  holder deliberately does **not** auto-recover: dead-marker recovery for that canvas fails closed until a
  trusted operator, with all canvas processes stopped, verifies state with the read-only
  `inspectCanvasLock(storeDir, canvasId)` diagnostics and removes the dangling guard file. The guard is only
  involved in the recovery path: **normal reads and writes on a healthy canvas never touch it**.
  `inspectCanvasLock` also reports the persisted write-lock `fence` and the recovery marker/guard owner,
  liveness and `unverifiable` reason; it never mutates the store.

Low-level owner-record, recovery-marker and recovery-guard primitives live in the internal module
`src/store/lock-internals.js` (named exports for `lock.js` and tests). The module is intentionally **not**
re-exported from `src/index.js`; the public lock API remains `acquireCanvasLock`, `releaseCanvasLock`,
`verifyCanvasLock`, `inspectCanvasLock`, `canvasLockPath`, `canvasFencePath`.

### Store integration and fencing

```text
updateCanvas(canvasId, updater, {lockHandle}?):
  1. assert canvasId (before any path join); acquire a handle
     (or use options.lockHandle — advanced/testing only, caller retains release ownership)
  2. verifyCanvasLock(handle)                          → failure: CANVAS_LOCK_OWNERSHIP_LOST
  3. read <canvasId>.json (authoritative state);
     (state.lockFence ?? 0) > handle.fence             → CANVAS_LOCK_OWNERSHIP_LOST (stale generation)
  4. updater(currentState) → {value, nextState}
       (the operation runtime performs the receipt-replay check and the CAS check here)
  5. nextState.lockFence = handle.fence; validate shape
  6. verifyCanvasLock(handle) again — immediately before the write
                                                       → failure: CANVAS_LOCK_OWNERSHIP_LOST
  7. write temp file `<store>/canvases/.tmp-<pid>-<rand>-<id>.json`
     (mode 0600); fsync; close; renameSync over target  # atomic on the same filesystem
  8. releaseCanvasLock(handle) in finally               # ownership-checked; never throws
```

`writeCanvas` (fixtures/administration) applies the same acquire → verify → stale-fence-check → atomic-write →
release discipline. Readers never take the lock.

Failure behavior:

| Situation | Result |
|---|---|
| A **live** owner holds the lock and `--lock-timeout-ms` (default 5000) elapses | `CANVAS_STORE_BUSY`, nothing written — the live owner is never preempted |
| Owner is provably dead (`ESRCH`) but the lock file is younger than `--stale-lock-ms` (default 10000) | Wait/retry until the age gate and the deadline |
| Owner record corrupt / unknown version / foreign hostname / liveness undeterminable | `CANVAS_LOCK_UNVERIFIABLE`, nothing written, no takeover |
| Live recovery guard or recovery marker holder keeps the path past `--lock-timeout-ms` | `CANVAS_STORE_BUSY`, nothing written — live holders are never preempted |
| Recovery guard record is dead / foreign-host / corrupt / liveness undeterminable | `CANVAS_LOCK_UNVERIFIABLE` with `detail.reason` `GUARD_OWNER_DEAD` \| `GUARD_FOREIGN_HOST` \| `GUARD_RECORD_INVALID` \| `GUARD_LIVENESS_UNKNOWN` and `action: MANUAL_OPERATOR_CLEANUP_REQUIRED`; the guard is never moved, reclaimed or deleted automatically |
| Recovery-marker holder crashed (guard still acquirable) | Next process acquires the guard, re-validates and reclaims only the dead marker, then continues recovery — normal writes on a healthy canvas are unaffected because they never touch the guard |
| Recovery-guard holder crashed | Dead-marker recovery for that canvas fails closed (`CANVAS_LOCK_UNVERIFIABLE`) until a trusted operator verifies state (`inspectCanvasLock`) with all processes stopped and removes the dangling guard file |
| Legacy empty-directory lock path (`.locks/<canvasId>.lock/`) | `CANVAS_LOCK_UNVERIFIABLE` (fail closed; the old directory lock is never taken over or removed) |
| Hard links unavailable on this filesystem (`EMLINK`, `ENOSYS`, `ENOTSUP`, `EPERM`, `EXDEV`, …) | `CANVAS_LOCK_UNVERIFIABLE`, fail closed |
| Handle token/pid/hostname/fence no longer matches the lock | `CANVAS_LOCK_OWNERSHIP_LOST`, nothing written |
| Persisted `state.lockFence` is newer than the handle's fence | `CANVAS_LOCK_OWNERSHIP_LOST` (stale generation), nothing written |
| `expectedRevision` ≠ current revision | `CANVAS_REVISION_CONFLICT` (`detail: {expectedRevision, actualRevision}`), nothing written |
| Action validation fails | error returned, nothing written, no receipt, no revision bump |
| Temp write/fsync/rename fails | `CANVAS_STORE_UNAVAILABLE`; temp file cleaned up best-effort |
| Release called after ownership loss | returns `false`, never throws, leaves the current owner's lock intact |
| State JSON unreadable/corrupt | `CANVAS_STORE_CORRUPT`; never overwritten |

Because the receipt is part of the same `nextState` object that is renamed into place, **state and receipt
commit atomically together**. Ownership is verified immediately before that rename and a stale fence is
rejected, so a writer that lost its lock generation cannot commit even through an abnormal route. Readers do
not take the lock; `rename` guarantees they see either the complete old file or the complete new file.

**Same-host only, conservative recovery.** Liveness is checked on the local machine
(`process.kill(pid, 0)`), so stores shared across hosts (network filesystems, NFS/SMB, containers with
different hostnames) are unsupported: a foreign-host owner record fails closed with
`CANVAS_LOCK_UNVERIFIABLE` and is never taken over. Recovery is deliberately conservative: age alone is never
evidence of death, a live owner is never preempted, recovery is serialised by a per-canvas recovery marker and
guard, and a PID reused by a different live process is treated as alive (wait → `CANVAS_STORE_BUSY`) rather than
guessed about. There is no PID-start-time check and no distributed consensus. Because a crashed guard holder
is never auto-reclaimed, an operator may need to perform the documented manual cleanup to restore write
availability; this is a fail-closed trade-off.

## Operation receipts and replay

Write tools build one operation envelope and pass it to the domain/runtime:

```json
{
  "operationId": "op-demo-create-0001",
  "kind": "canvas.batch",
  "payload": {
    "canvasId": "canvas-demo-a",
    "expectedRevision": 0,
    "actions": [{ "kind": "node.create", "node": { "id": "node-1", "type": "text", "position": {"x": 0, "y": 0}, "data": {"nodeType": "text", "label": "Hi"} } }]
  }
}
```

Runtime semantics (`src/operations/runtime.js`):

1. **Validate the envelope** — exactly the keys `{operationId, kind, payload}`; `kind` must be
   `canvas.batch`; payload exactly `{canvasId, expectedRevision, actions}`; `expectedRevision` a non-negative
   safe integer; 1–100 actions. Failures are `CANVAS_OPERATION_REQUEST_INVALID`,
   `CANVAS_OPERATION_ID_INVALID`, `CANVAS_CANVAS_ID_INVALID` or `CANVAS_REVISION_REQUIRED`.
2. **Authorize before any mutation or lock** — `authorize({principal, canvasId, requiredPermission:
   "canvas:write"})` must return exactly `true`, else `CANVAS_AUTH_DENIED`.
3. **Replay check** — inside the lock, look up `receipts[operationId]`:
   - scope hash differs → `CANVAS_OPERATION_SCOPE_CONFLICT`
   - kind differs → `CANVAS_OPERATION_KIND_CONFLICT`
   - payload hash differs → `CANVAS_OPERATION_PAYLOAD_CONFLICT`
   - all match → return `{ok: true, replayed: true, operationId, kind, payloadHash, revision:
     receipt.resultingRevision, result: receipt.result}` — **no mutation, no new receipt, no revision bump**.
4. **CAS check** — `current.revision` must equal `payload.expectedRevision`, else
   `CANVAS_REVISION_CONFLICT` with `{expectedRevision, actualRevision}`; nothing is written.
5. **Apply** — deep-clone the state, run the registered action handlers in order (built-ins:
   `node.create`, `node.patch`, `edge.connect`; the registry is extensible for embedders), compute the
   result `{canvasId, revision, nodes, edges}` and the receipt, set `revision = current + 1`, and write the
   next state atomically.
6. **Return** `{ok: true, replayed: false, operationId, kind, payloadHash, revision, result}` plus the
   dispatcher metadata (tool name, `permission: "WRITE"`, server name, principal id, agent id).

Receipts are a public-projection read model: `canvas_read_receipt` and `canvas_list_receipts` expose
`{operationId, kind, payloadHash, scopeHash, expectedRevision, resultingRevision, actionKinds, principalId,
agentId, committedAt, result}` — deliberately **not** `durationMs`, not raw arguments, and never token
material. `canvas_list_receipts` sorts newest first by `committedAt`, then `operationId`, and returns at most
`limit` (1–100, default 20) entries.

## Canonical JSON and hashes

Both hashes are SHA-256 over a deterministic canonical JSON form (`src/canonical-json.js`):

- object keys sorted (JavaScript default UTF-16 code-unit order);
- `undefined` object properties omitted;
- array order preserved; `undefined` array elements rejected;
- non-finite numbers rejected; `-0` normalised to `0`;
- cycles and non-JSON values (functions, symbols, bigints, class instances) rejected.

```text
payloadHash = sha256( canonicalJson(payload) )            # payload = {canvasId, expectedRevision, actions}
scopeHash   = sha256( canonicalJson(scope) )              # scope   = {principalId, canvasId}
```

Both are lowercase hex. The same canonicalisation is used for the audit log's `argsDigest`
(`sha256(canonicalJson(toolArguments))`), which is why logs can be correlated with calls without storing raw
arguments. Deterministic canonicalisation is what makes replay comparison and independent hash recomputation
possible; the acceptance check `C09_operation_receipt` independently recomputes `payloadHash` and compares it
with the stored receipt.

## Authentication and authorization

### Startup pipeline (fail closed)

```text
parse CLI flags (unknown flag / bad integer → exit 2)
  → <store> must exist and be a directory            (CANVAS_STORE_UNAVAILABLE → exit 2)
  → load + validate --auth JSON                      (CANVAS_AUTH_CONFIG_INVALID → exit 3)
  → CANVAS_MCP_TOKEN present and non-empty           (CANVAS_AUTH_REQUIRED → exit 3)
  → sha256(token) matches exactly one principal      (CANVAS_PRINCIPAL_UNKNOWN → exit 3)
  → create store, init subdirectories, audit logger, authorizer, executor, domain, dispatcher
  → log one server_start stderr line, then serve stdin
```

There is no anonymous mode, no "demo" bypass and no flag that disables authentication. A missing token or an
unreadable/invalid auth file terminates the process before it can serve a single request. `--help` and
`--version` exit 0 without touching the store or auth config. EOF on stdin, `SIGINT` and `SIGTERM` exit 0;
unexpected internal errors exit 1.

### Token matching

- The auth config stores **only** `tokenSha256` digests; raw tokens are never written to disk.
- The raw token comes **only** from the environment variable `CANVAS_MCP_TOKEN`; it is never accepted in argv,
  never logged, never returned by a tool, never stored in a receipt.
- Matching computes `sha256(utf8 token)` and compares it with each configured digest using
  `crypto.timingSafeEqual` (both buffers are validated to 64 bytes at load time). Exactly one match is
  required; zero or multiple matches fail closed.

### Principal model

| Principal field | Effect |
|---|---|
| `principalId` | Attributed in audit logs and receipts; used in `scopeHash`. |
| `mode: "READ_ONLY"` | May call read tools only; any write tool → `CANVAS_READ_ONLY` before store access. |
| `mode: "CANVAS_WRITE"` | May call read and write tools. |
| `canvasIds` | Canvas allowlist. A tool naming an out-of-scope canvas → `CANVAS_CANVAS_SCOPE_MISMATCH`; `canvas_list_canvases` silently filters to the allowlist. `["*"]` means all canvases. |
| `allowedTools` | `null`/absent = every whitelisted tool (subject to mode); otherwise a non-empty subset of whitelisted tool names. A tool outside the list → `CANVAS_TOOL_DENIED`. |

### Enforcement is layered (defense in depth)

1. **Dispatcher** — whitelist, identifier validation, schema narrowing, `allowedTools`, mode, canvas scope,
   then `authorize(...)` must return exactly `true`.
2. **Canvas domain `execute()`** — asserts the scope is trusted and matches the request canvas, and calls
   `authorize(...)` again before delegating.
3. **Operation runtime** — calls `authorize({principal, canvasId, requiredPermission: "canvas:write"})` again
   before mutating; forged operation scopes (not created by `createOperationScope`) are rejected
   (`CANVAS_AUTH_DENIED`).
4. **Reads** — even read tools are scope-authorized; `canvas_list_canvases` filters by scope and every other
   read tool named an out-of-scope canvas is rejected by the dispatcher.

The only way to change permissions or identity is restarting the server with a different token/config; there
is no runtime admin API.

## MCP method support

Transport: newline-delimited UTF-8 JSON-RPC 2.0 over stdio — one JSON object per line, one message processed
at a time, responses on stdout.

| Method | Behaviour |
|---|---|
| `initialize` | Returns `protocolVersion`, `capabilities: {tools: {listChanged: false}}`, `serverInfo: {name: "jiflow-canvas-mcp", version: "0.1.0"}`. |
| `notifications/initialized` | No response. |
| `notifications/cancelled` | No response; calls are synchronous, so it is safely ignored. |
| `ping` | Returns `{}`. |
| `tools/list` | Returns the nine `{name, title, description, inputSchema}` definitions in whitelist order. |
| `tools/call` | Dispatches `{name, arguments}`. Success returns `{content:[{type:"text",text:"<json>"}], structuredContent:{...}}`; tool failure returns `isError: true` with `{ok:false, code, error, detail?}` in the text content. |
| unknown method | JSON-RPC error `{code: -32601, message: "Method not found"}`. |
| invalid JSON line | JSON-RPC error `{code: -32700}` and the server keeps serving. |
| JSON-RPC batch array | Error `{code: -32600, id: null}` — batches are not supported. |

Protocol versions accepted in `initialize` (echoed when requested, otherwise the newest is used):

`2025-11-25` (default), `2025-06-18`, `2025-03-26`, `2024-11-05`, `2024-10-07`.

The server implements the tools-only subset shared by these revisions; it advertises no resources, prompts,
sampling, roots or logging capabilities. The protocol surface was exercised against raw JSON-RPC and against
the official `@modelcontextprotocol/sdk@1.30.0` client (`initialize`, `listTools`, `callTool`).

## Concurrency model

- **Multi-process is the concurrency model.** Several server processes (each with its own authenticated
  principal) may point at the same `<store>`. Writers serialise per canvas through the **fenced owner-file
  lock**; a stale `expectedRevision` guarantees that exactly one writer wins a race and the others get
  `CANVAS_REVISION_CONFLICT` with the actual revision. A writer whose lock generation was superseded is
  rejected with `CANVAS_LOCK_OWNERSHIP_LOST` before any state write.
- **Per-canvas granularity.** The lock, the fence file and the JSON state file are per canvas; writes to
  different canvases do not block each other.
- **No live preemption.** A live owner is never preempted, even if it holds the lock longer than the stale
  age. A crashed owner is recovered only when it is provably dead on the same host and the lock is older than
  `--stale-lock-ms`; recovery is serialised by a per-canvas recovery marker, and dead-marker reclaim is further
  serialised by the recovery guard, so exactly one recoverer can remove a dead owner's lock record.
- **Recovery guard is deliberately fail-closed.** A live guard/marker is never preempted. A dead or
  unverifiable guard is never auto-reclaimed; the server returns `CANVAS_LOCK_UNVERIFIABLE` with an
  operator-cleanup action until a trusted operator verifies state and removes the dangling guard.
- **Readers are lock-free.** Atomic rename means a reader sees a complete state file; no reader/writer lock is
  needed.
- **One message at a time per process.** The stdio loop processes lines in arrival order; it does not
  interleave tool calls within one process. A slow synchronous store operation delays later messages in that
  process only.
- **Replay is cross-process.** Because receipts are stored in the canvas file, a retry sent to a different
  server process still gets `replayed: true` for the same `operationId` and payload. The conflict demo and
  the concurrency acceptance check exercise this with real separate processes.
- **Single host, not distributed.** Lock ownership is a token plus a monotonic fence, but liveness is
  same-host only; there is no cross-machine coordination, no consensus and no support for network/shared
  filesystems. A foreign-host owner record fails closed with `CANVAS_LOCK_UNVERIFIABLE`.

## Audit logging

`src/logger.js` writes one JSON object per line to **stderr** (never stdout). The logger is allow-list based:
unknown fields passed by a caller are dropped, so tokens, raw arguments and file contents cannot leak by
accident.

Allowed fields: `ts` (ISO-8601), `event`, `principalId`, `agentId`, `tool`, `ok`, `code`, `ms`, `argsDigest`,
`operationId`, `revision`, `store`, `tools`, `version`.

Events: `server_start`, `server_error`, `tool_call`, `tool_error`, `store_conflict`, `auth_denied`.

`argsDigest` is the SHA-256 of the canonical arguments — a correlation digest, not the arguments themselves.
Logging failures are swallowed: logging never takes the server down.

## Library API

`src/index.js` is the package's public ESM surface; every module uses Node built-ins only. The package can be
used as a library instead of, or in addition to, spawning the CLI.

| Export area | Symbols |
|---|---|
| Errors | `CanvasMcpError`, `ERROR_CODES`, `isCanvasMcpError`, `canvasError`, `asCanvasMcpError` |
| Canonical JSON | `canonicalJson`, `hashCanonicalJson` |
| Logger | `createAuditLogger`, `AUDIT_EVENTS` |
| Auth | `AUTH_MODES`, `loadAuthConfig`, `matchPrincipal`, `tokenSha256`, `validateAuthConfig`, `createAuthorizer` |
| Lock | `DEFAULT_LOCK_TIMEOUT_MS`, `DEFAULT_STALE_LOCK_MS`, `canvasLockPath`, `canvasFencePath`, `acquireCanvasLock`, `releaseCanvasLock`, `verifyCanvasLock`, `inspectCanvasLock` (breaking change: the former directory-lock API `acquireLock`/`releaseLock`/`canvasLockDir` was removed). `inspectCanvasLock` additively returns read-only `recoveryMarker` / `recoveryGuard` diagnostics (owner, liveness, `unverifiable` reason) plus the persisted lock `fence`. |
| Lock internals | `src/store/lock-internals.js` — internal module for owner-record, recovery-marker and recovery-guard primitives used by `lock.js` and tests. Deliberately **not** re-exported from `src/index.js`. |
| Store | `createFileCanvasStore`, `validateCanvasState`, `STORE_VERSION` — the store also exposes `acquireCanvasLock`, `releaseCanvasLock`, `verifyCanvasLock`, and `updateCanvas(canvasId, updater, {lockHandle})` for advanced/testing use |
| Canvas primitives | id patterns (`CANVAS_ID_PATTERN`, `NODE_ID_PATTERN`, `EDGE_ID_PATTERN`, `OPERATION_ID_PATTERN`, `PRINCIPAL_ID_PATTERN`, `AGENT_ID_PATTERN`), `CANVAS_NODE_KINDS`, `NODE_STATUSES`, `NODE_CAPABILITIES`, `EDGE_RELATIONS`, `MUTABLE_NODE_DATA_FIELDS`, `PROTECTED_NODE_DATA_FIELDS`, `ACTION_KINDS`, asserters and validators (`assertCanvasId`, `assertNodeId`, `assertEdgeId`, `assertOperationId`, `assertNodeKind`, `assertEdgeRelation`, `assertAgentId`, `assertPrincipalId`, `validateMutableNodeData`, `validatePreparedNodeData`, `prepareCreateNodeData`, `validatePosition`, `validateAction`, `validateActions`) |
| Domain | `createCanvasDomain`, `projectReceipt` |
| Operations | `createOperationScope`, `assertOperationScopeTrusted`, `isTrustedScope`, `OperationRegistry`, `DEFAULT_ACTION_HANDLERS`, `createOperationExecutor` |
| MCP | `TOOL_WHITELIST`, `TOOL_NAMES`, `TOOL_PERMISSIONS`, `WHITELISTED_TOOL_NAMES`, `getTool`, `getToolByName`, `isWhitelistedTool`, `listToolDefinitions`, `assertArgumentIdentities`, `validateArguments`, `assertSchemaSubset`, `createDispatcher`, `DISPATCHER_SERVER_NAME` |
| Protocol | `PROTOCOL_VERSIONS`, `DEFAULT_PROTOCOL_VERSION`, `SERVER_NAME`, `SERVER_VERSION`, `createMcpServer`, `runStdioServer`, `negotiateProtocolVersion`, `runMcpMain` |
| Server | `parseServerConfig`, `exitCodeForError`, `USAGE`, `startServer`, `runMain` |

Typical embedding:

```js
import {
  createFileCanvasStore,
  createAuthorizer,
  createCanvasDomain,
  createOperationExecutor,
  createDispatcher,
  createMcpServer
} from 'jiflow-canvas-mcp';

const store = createFileCanvasStore({ dir: '/path/to/store' });
store.init();
const principal = { principalId: 'agent-a', mode: 'CANVAS_WRITE', canvasIds: ['canvas-a'], allowedTools: null };
const authorize = createAuthorizer({ principal });
const executor = createOperationExecutor({ store, authorize, principal });
const domain = createCanvasDomain({ store, authorize, executor, principal });
const dispatcher = createDispatcher({ domain, authorize, principal });
const server = createMcpServer({ dispatcher });
server.handleLine('{"jsonrpc":"2.0","id":1,"method":"ping"}');
```

(The example above is illustrative; the CLI wires the same objects in `src/server/main.mjs`, and callers are
responsible for validating any principal they construct themselves.)

## Verification evidence

The candidate's acceptance matrix (run by the independent test workstream) reported **overall `PASS` with
11/11 checks PASS** on Node.js v24.11.1 / npm 11.6.2 / darwin arm64. Relevant checks for this architecture:

| Check | What it verifies |
|---|---|
| `C01_standalone_start` | Server boots from an isolated temp copy of `src/` + `package.json` without `node_modules` and without repo context; handshake works. |
| `C02_mcp_handshake` | Raw newline-delimited JSON-RPC and the official SDK client (`initialize`, `listTools`, `callTool`) both work against real stdio servers. |
| `C03_read_canvas` | Fictional fixture nodes/edges are returned exactly. |
| `C04_create_node` / `C05_patch_node` / `C06_connect_nodes` | Writes persist to the isolated store file together with receipts; revision updates; capability-invalid edges rejected without writing. |
| `C07_concurrency_conflict` | Stale-revision races across 3 real server processes produce exactly one winner plus `CANVAS_REVISION_CONFLICT`; retry succeeds. |
| `C08_unauthorized_rejected` | `READ_ONLY`, scope mismatch, `allowedTools`, whitelist-bypass names and traversal ids are all rejected with stable codes. |
| `C09_operation_receipt` | A receipt matches the execution; `payloadHash` is independently recomputed; replay is idempotent. |
| `C10_isolation_security` | No proprietary/business/secret/PII/real-asset references; builtins-only runtime; no network or paid calls. |
| `C11_automated_test_suite` | `npm test` (`node --test "test/**/*.test.mjs"`): exit 0 — 179 tests / 40 suites, 179 pass, 0 fail (155 preserved regression tests + 13 lock-safety + 5 scanner + 6 recovery-marker-race tests; deterministic glob discovery). |

Additionally, the lock-safety suite (`test/concurrency/lock-safety.test.mjs`, **13/13 PASS**, real
multi-process scenarios inside `npm test`) verifies the lock properties described above: live-owner
non-preemption, ownership-checked release, fencing (`CANVAS_LOCK_OWNERSHIP_LOST`), SIGKILL/crash recovery only
after proven death plus the age gate, exact N-process CAS outcomes, **25 rounds of randomized 3–5-process
contention (94 operations, 0 overlapping critical sections; final revision 94, nodes 97, receipts 94)**, a
multi-recoverer race with exactly one winner, and fail-closed handling of corrupt/foreign-host/malformed-fence
and legacy locks.

The recovery-marker-race suite (`test/concurrency/recovery-marker-race.test.mjs`, **6/6 PASS**) verifies the
recovery-guard protocol: a deterministic pre-fix reproduction on the earlier implementation reproduces the race
(a live recovery marker moved/deleted, two recovery owners), while the same harness on this implementation is
**not reproducible** (live guard/marker never preempted, contender gets `CANVAS_STORE_BUSY`, live records stay
byte-identical, sequential writes and exact revisions). It also covers dead-marker reclaim only under the guard
with same-dead-owner revalidation, a crashed guard holder failing closed with `CANVAS_LOCK_UNVERIFIABLE` and
intact state, a crashed marker holder auto-recovering through the guard, and a stale-handle write rejected with
`CANVAS_LOCK_OWNERSHIP_LOST` leaving state unchanged.

Raw verification logs are internal records and are not part of this repository. What these checks do **not**
prove: production load capacity, security against a determined local attacker, cross-platform behavior,
durability under power loss for every filesystem, correctness of concurrent access over network filesystems,
or lock safety across hosts (same-host only).

## Design note

The design of this generic canvas MCP server was informed by prior internal prototyping of a canvas/MCP tool
gateway. That prior work was used at a **conceptual level only**: no code, prompts, presets, provider keys,
product data, business rules or private source material were copied or are redistributed here. The
implementation in this repository is standalone and generic; the patterns it applies — whitelist-only tools,
strict argument narrowing, CAS concurrency control, fenced crash-safe locking, durable operation receipts,
scoped authorization and stderr-only audit logging — are documented in this file as generic
software-engineering techniques. Details of the prior internal work are retained in private audit material
and are not part of this documentation or any public release.

See [`README.md`](README.md) for the public project overview, [`SECURITY.md`](SECURITY.md) for the security
model, and [`docs/TOOLS.md`](docs/TOOLS.md) / [`docs/RECOVERY.md`](docs/RECOVERY.md) for the tool and recovery
references.
