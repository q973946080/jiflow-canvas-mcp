# Tool reference — jiflow-canvas-mcp

Reference for the nine whitelisted MCP tools of `jiflow-canvas-mcp` v0.1.0. This file mirrors the single
source of truth in `src/mcp/whitelist.js`; if they ever disagree, the code wins.

> **Status:** **MIT licensed**; final independent verification passed (179/179 automated tests and 11/11 functional
> acceptance checks). This project is staged in the private GitHub repository
> [`q973946080/jiflow-canvas-mcp`](https://github.com/q973946080/jiflow-canvas-mcp) and is **not yet publicly released**.

## Conventions

- All tools are named `canvas_*` (raw MCP names; a host may add its own namespace prefix).
- Every tool call is dispatched in a fixed order: whitelist → identifier validation → JSON-Schema-subset
  argument validation/narrowing → principal authorization (allowedTools, mode, canvas scope) → domain
  operation. Arguments are **narrowed** to the declared properties; undeclared keys cause
  `CANVAS_ARGUMENTS_INVALID` (nothing is silently accepted).
- Success results contain `ok: true`, `tool`, `permission` (`READ` or `WRITE`), `server: "jiflow-canvas-mcp"`,
  `principalId`, `agentId`.
- Tool failures are returned as MCP tool results with `isError: true` and text content
  `{"ok":false,"code":"CANVAS_…","error":"…","detail"?:{…}}`. See the error-code groups in
  [`README.md`](../README.md#error-codes).
- Read tools do not take the store lock. Write tools always take the per-canvas lock and commit atomically.
- Write tools accept optional `expectedRevision` (integer) and `operationId` (idempotency key). If
  `expectedRevision` is omitted, the server reads the current revision first (`source: "provided"` or
  `source: "read"` in the result); the CAS check still applies.

## Read tools (5)

### `canvas_list_canvases`

Lists canvases visible to the authenticated principal.

```json
{ "name": "canvas_list_canvases", "arguments": {} }
```

Result: `canvas: [{canvasId, name, revision, nodeCount, edgeCount, updatedAt}]` filtered to the principal's
canvas scope and sorted by `canvasId`. Out-of-scope canvases are silently filtered (they are not an error
here).

### `canvas_read_canvas`

Reads a canvas with all nodes and edges.

| Argument | Type | Required | Notes |
|---|---|---|---|
| `canvasId` | string | yes | Canvas to read; must be in the principal scope. |

Result: `canvasId`, `name`, `revision`, `updatedAt`, `nodes: [...]`, `edges: [...]`.

### `canvas_read_node`

Reads one node of a canvas.

| Argument | Type | Required | Notes |
|---|---|---|---|
| `canvasId` | string | yes | Canvas to read. |
| `nodeId` | string | yes | Node to read. |

Result: `canvasId`, `revision`, `node`. Missing node → `CANVAS_NODE_NOT_FOUND`.

### `canvas_read_receipt`

Reads the durable receipt of one applied operation.

| Argument | Type | Required | Notes |
|---|---|---|---|
| `canvasId` | string | yes | Canvas containing the operation. |
| `operationId` | string | yes | Operation id used for the write. |

Result: `canvasId`, `receipt` with the public projection: `operationId`, `kind`, `payloadHash`, `scopeHash`,
`expectedRevision`, `resultingRevision`, `actionKinds`, `principalId`, `agentId`, `committedAt`, `result`.
Missing receipt → `CANVAS_RECEIPT_NOT_FOUND`. No token material, no raw arguments, no `durationMs`.

### `canvas_list_receipts`

Lists recent operation receipts of a canvas, newest first (`committedAt`, then `operationId`).

| Argument | Type | Required | Notes |
|---|---|---|---|
| `canvasId` | string | yes | Canvas to list receipts for. |
| `limit` | integer | no | 1–100; default `20`. |

Result: `canvasId`, `receipts: [...]` (same public projection as above).

## Write tools (4)

All write results contain: `operationId`, `kind: "canvas.batch"`, `replayed` (boolean), `payloadHash`,
`revision` (the revision after this operation; the original revision on replay), `result: {canvasId, revision,
nodes, edges}`, `source` (`"provided"` or `"read"`), plus `actionKind`/`nodeId`/`edgeId` or `actionKinds`.

Write errors that matter for retries: `CANVAS_READ_ONLY`, `CANVAS_CANVAS_SCOPE_MISMATCH`,
`CANVAS_TOOL_DENIED`, `CANVAS_REVISION_CONFLICT` (`detail: {expectedRevision, actualRevision}`),
`CANVAS_REVISION_REQUIRED`, `CANVAS_OPERATION_PAYLOAD_CONFLICT`, `CANVAS_OPERATION_SCOPE_CONFLICT`,
`CANVAS_OPERATION_KIND_CONFLICT`, `CANVAS_STORE_BUSY` (a live lock owner or a live recovery guard/marker is
busy; retry), `CANVAS_LOCK_OWNERSHIP_LOST` (your lock generation was superseded; nothing was written — re-read
the revision and retry) and `CANVAS_LOCK_UNVERIFIABLE` (fail closed: corrupt/foreign/ambiguous lock state, or a
dead recovery-guard holder; do not retry blindly and never take over or delete live lock/recovery files — a
dangling guard needs the documented operator cleanup in [`docs/RECOVERY.md`](RECOVERY.md)).

### `canvas_create_node`

Creates one node.

| Argument | Type | Required | Notes |
|---|---|---|---|
| `canvasId` | string | yes | Target canvas. |
| `kind` | string | yes | One of `text`, `image`, `video`, `audio`, `note`. |
| `label` | string | yes | Trimmed non-empty; max 256 chars. |
| `position` | object | no | `{x, y}` two finite numbers; default `{x: 0, y: 0}`. |
| `data` | object | no | Mutable node data fields (see below). |
| `nodeId` | string | no | Explicit id; server generates `node-<uuid>` if omitted. **Pass this for retry-safe writes.** |
| `expectedRevision` | integer | no | CAS guard; current revision is read if omitted. |
| `operationId` | string | no | Idempotency key; server generates `op-<uuid>` if omitted. **Pass this for retry-safe writes.** |

Result adds `actionKind: "node.create"`, `nodeId`. The server injects `data.nodeType = kind`; supplying
`nodeType`/`assetId`/`stateId`/`id`/`type` in `data` is rejected (`CANVAS_NODE_FIELD_PROTECTED`).

### `canvas_patch_node`

Updates the data and/or position of an existing node. At least one of `data`/`position` is required.

| Argument | Type | Required | Notes |
|---|---|---|---|
| `canvasId` | string | yes | Target canvas. |
| `nodeId` | string | yes | Node to patch. |
| `data` | object | no | Shallow-merged into existing data; protected fields rejected. |
| `position` | object | no | Replaces position. |
| `expectedRevision` | integer | no | CAS guard. |
| `operationId` | string | no | Idempotency key. |

Result adds `actionKind: "node.patch"`, `nodeId`. Missing node → `CANVAS_NODE_NOT_FOUND`.

### `canvas_connect_nodes`

Connects a source node to a target node with a capability-valid relation.

| Argument | Type | Required | Notes |
|---|---|---|---|
| `canvasId` | string | yes | Target canvas. |
| `source` | string | yes | Source node id. |
| `target` | string | yes | Target node id. |
| `relation` | string | no | Default `reference`; validity is enforced at runtime (`CANVAS_EDGE_RELATION_INVALID`). |
| `edgeId` | string | no | Explicit edge id; server generates `edge-<uuid>` if omitted. **Pass this for retry-safe writes.** |
| `expectedRevision` | integer | no | CAS guard. |
| `operationId` | string | no | Idempotency key. |

Allowed relations: `image → video` with `reference`; `text → note` with `context`. Self edges are rejected.
Result adds `actionKind: "edge.connect"`, `edgeId`.

### `canvas_commit_batch`

Applies an ordered batch of 1–100 actions as **one** atomic revision.

| Argument | Type | Required | Notes |
|---|---|---|---|
| `canvasId` | string | yes | Target canvas. |
| `actions` | array | yes | 1–100 actions: `node.create`, `node.patch`, `edge.connect`. |
| `expectedRevision` | integer | no | CAS guard. |
| `operationId` | string | no | Idempotency key for the whole batch. |

Action shapes (strict — unknown keys rejected):

```json
{ "kind": "node.create", "node": { "id": "node-1", "type": "text", "position": {"x": 0, "y": 0}, "data": {"label": "Hi"} } }
{ "kind": "node.patch", "nodeId": "node-1", "patch": { "data": {"content": "updated"}, "position": {"x": 10, "y": 20} } }
{ "kind": "edge.connect", "edge": { "id": "edge-1", "source": "node-a", "target": "node-b", "relation": "reference" } }
```

Result adds `actionKinds: [...]`. If any action fails validation, **no action is applied**, the revision is
not bumped and no receipt is written. Any other action kind → `CANVAS_ACTION_NOT_WHITELISTED`; malformed
shape → `CANVAS_ACTION_INVALID`.

## Node `data` fields

Mutable (caller-writable):

| Field | Type | Constraints |
|---|---|---|
| `label` | string | trimmed non-empty, ≤ 256 chars |
| `status` | string | `idle` \| `running` \| `done` \| `error` \| `skipped` |
| `source` | string | ≤ 256 chars |
| `content` | string | ≤ 65536 chars |
| `prompt` | string | ≤ 65536 chars |
| `url` | string | ≤ 2048 chars, must start with `https://` or `http://` |
| `mimeType` | string | ≤ 128 chars |
| `width` | integer | positive safe integer |
| `height` | integer | positive safe integer |
| `duration` | number | finite, > 0 |
| `errorMessage` | string | ≤ 4096 chars |

Protected (rejected if supplied): `nodeType`, `assetId`, `stateId`, node-level `id`/`type` inside `data`.

## Ids

| Kind | Pattern | Notes |
|---|---|---|
| Canvas | `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` | must not contain `..`, `/`, `\`; used as a filename. |
| Node / edge / operation | `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$` | must not contain `..`, `/`, `\`. |
| Principal (auth config) | `^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$` | operator-configured. |
| `--agent-id` | 1–64 printable ASCII (`\x21`–`\x7E`) | operator label; never changes identity or permissions. |

## Examples (raw JSON-RPC over stdio)

The server reads one JSON object per stdin line and writes one JSON response per stdout line.

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25"}}
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"canvas_read_canvas","arguments":{"canvasId":"canvas-demo-a"}}}
{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"canvas_create_node","arguments":{"canvasId":"canvas-demo-a","kind":"text","label":"Note","nodeId":"node-note-1","operationId":"op-note-1","expectedRevision":0}}}
{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"canvas_read_receipt","arguments":{"canvasId":"canvas-demo-a","operationId":"op-note-1"}}}
```

Run the full tour instead of hand-writing frames: `npm run demo` (see [`examples/README.md`](../examples/README.md)).
