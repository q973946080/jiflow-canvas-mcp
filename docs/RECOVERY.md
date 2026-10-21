# Recovery and retry patterns — jiflow-canvas-mcp

Practical patterns for recovering from crashes, timeouts, lost responses and concurrency conflicts when
driving `jiflow-canvas-mcp` v0.1.0. The server is designed so that **the outcome of every write is knowable**
— a write either has a durable receipt or was rejected — and so that a retry can be idempotent.

> The demo tokens in the examples below are fictional public fixtures from `examples/auth.demo.json`; never
> reuse them outside the demo. See [`README.md`](../README.md) and [`SECURITY.md`](../SECURITY.md).

## 1. The two keys: `operationId` and explicit ids

- **`operationId`** is the idempotency key of an operation. Reusing it with an identical payload returns the
  stored result with `replayed: true` and no second write. Reusing it with a different payload is rejected
  with `CANVAS_OPERATION_PAYLOAD_CONFLICT`.
- **Explicit `nodeId`/`edgeId`** keep the payload stable across retries. If you omit them, the server
  generates a fresh UUID on every call, so a blind retry is a *different* payload and cannot replay.

For any write you may need to retry, pass both up front:

```json
{
  "name": "canvas_create_node",
  "arguments": {
    "canvasId": "canvas-demo-a",
    "kind": "text",
    "label": "Generated summary",
    "nodeId": "node-summary-001",
    "operationId": "op-summary-001",
    "expectedRevision": 3
  }
}
```

## 2. Classify the failure first

| Symptom | Meaning | What to do |
|---|---|---|
| Response lost / client timeout / server process killed | Unknown whether it committed | **Check receipts before retrying** (§3). |
| `CANVAS_REVISION_CONFLICT` (`detail.actualRevision`) | Another writer committed first; your operation did **not** apply | Re-read, rebuild the change on the new state, resubmit with the fresh revision and a **new** `operationId` (§4). |
| `CANVAS_STORE_BUSY` | A **live** owner holds the canvas lock, or a live recovery guard/marker is mid-recovery, and `--lock-timeout-ms` elapsed | Retry after a short delay (backoff). Live holders are never preempted; if a writer crashed, its lock is recovered only after it is provably dead **and** older than `--stale-lock-ms` (§5). |
| `CANVAS_LOCK_OWNERSHIP_LOST` | Your write's lock generation was superseded before the write; **nothing was written** | Re-read the canvas revision and retry (new attempt); do not reuse a stale revision and do not delete lock files. |
| `CANVAS_LOCK_UNVERIFIABLE` | The lock/recovery state cannot be validated safely (corrupt lock/marker/guard record, foreign host, hard links unavailable, ambiguous liveness, or a **dead recovery-guard holder**) | **Do not retry blindly and never take over/delete live state.** Fail closed: inspect the store and `.locks/` on the local host; a dead/dangling recovery guard needs the documented operator cleanup (§5); treat cross-host or network-filesystem stores as unsupported. |
| `CANVAS_OPERATION_PAYLOAD_CONFLICT` | You reused an `operationId` with a different payload | Use a new `operationId` for the changed payload, or resend the exact original payload if you intended a replay (§3). |
| `CANVAS_OPERATION_SCOPE_CONFLICT` | The `operationId` was used by a different principal/canvas scope | Generate a new `operationId`; never reuse ids across scopes. |
| `CANVAS_READ_ONLY` / `CANVAS_CANVAS_SCOPE_MISMATCH` / `CANVAS_TOOL_DENIED` | Your principal may not perform this write | Do not retry; fix the auth config/token or the requested operation. |
| `CANVAS_STORE_CORRUPT` | A state file is unreadable/wrong-shape | Stop writing; back up the store and inspect the file manually. The server will never reset it. |
| `CANVAS_STORE_UNAVAILABLE` | Store missing/unwritable/persist failed | Check the store path and permissions; the operation did not commit. |

## 3. Recover an unknown outcome: check the receipt

After a lost response or a crash, **do not blindly retry**. Ask the store what happened:

```json
{"name": "canvas_read_receipt", "arguments": {"canvasId": "canvas-demo-a", "operationId": "op-summary-001"}}
```

- **Receipt exists** → the operation committed. Use `receipt.resultingRevision` / `receipt.result` and move on
  (no retry needed). If a higher-level workflow requires a response, you already have the durable evidence.
- **`CANVAS_RECEIPT_NOT_FOUND`** → it did not commit (or never reached the store). Re-submit the **identical**
  operation (same `operationId`, same explicit ids, same `expectedRevision`), or a fresh operation with a new
  `operationId` and fresh revision if you want to recompute it.

To see recent operations on a canvas (newest first, default 20, max 100):

```json
{"name": "canvas_list_receipts", "arguments": {"canvasId": "canvas-demo-a", "limit": 10}}
```

Receipts are the source of truth: they are written in the same atomic file operation as the state change, so
"receipt exists" and "write committed" are exactly equivalent.

## 4. Handle a CAS conflict (another writer won)

`CANVAS_REVISION_CONFLICT` means your write did not apply and the canvas has moved. The correct pattern is
**read → recompute → write**:

1. Read the canvas (`canvas_read_canvas`) to get the new `revision` and current nodes/edges.
2. Recompute your intended action against the new state (e.g. re-derive the node content).
3. Submit a **new** operation with a **new** `operationId` (the payload/state changed) and the fresh
   `expectedRevision`.
4. If it conflicts again, repeat with bounded retries and backoff (e.g. 3–5 attempts). Conflicts under high
   contention mean you should serialise writers or retry later.

Do **not** reuse the previous `operationId` with a rewritten payload — that is rejected by design with
`CANVAS_OPERATION_PAYLOAD_CONFLICT`.

Reference implementation: `npm run demo:conflict` runs exactly this scenario with two real server processes
(one success, one conflict, loser re-reads and retries, winner's operation replayed cross-process).

## 5. Retry `CANVAS_STORE_BUSY` and handle lock errors

`CANVAS_STORE_BUSY` means a **live** process holds the per-canvas owner-record lock and the
`--lock-timeout-ms` deadline (default 5000 ms) elapsed. It is a transient, safe-to-retry condition: your write
never started, so it cannot have applied.

```text
retry with exponential backoff (e.g. 50 ms, 150 ms, 450 ms, … up to a few seconds)
```

Lock recovery rules (safe lock + recovery guard):

- A **live owner is never preempted**. Age alone is never treated as death. If the owner process is alive (or
  its liveness cannot be determined), the lock is not touched.
- If a process crashed **while holding the lock**, its owner record is recovered only when it is
  **provably dead on the same host** (`process.kill(pid, 0)` → `ESRCH`) **and** the lock file is older than
  `--stale-lock-ms` (default 10000 ms). Recovery is serialised by a hidden per-canvas recovery marker: only
  the marker holder may remove a dead owner's lock record, and it re-reads the same dead owner and re-checks
  liveness/age first.
- A **dead recovery marker** is reclaimed only while holding the hidden per-canvas **recovery guard**: only
  the guard holder may quarantine the dead marker, after re-reading the **same** provably dead marker
  (token/PID/hostname/fence, liveness=false, age gate), then re-validate and unlink only that record. Live
  guards/markers are never preempted. A **crashed marker holder auto-recovers** through the guard; a
  **crashed guard holder deliberately does not** (auto-reclaiming it would re-open the race). A dead/foreign/
  corrupt/ambiguous guard fails closed with `CANVAS_LOCK_UNVERIFIABLE`, `action:
  MANUAL_OPERATOR_CLEANUP_REQUIRED` and `detail.reason` one of `GUARD_OWNER_DEAD`, `GUARD_FOREIGN_HOST`,
  `GUARD_RECORD_INVALID`, `GUARD_LIVENESS_UNKNOWN`. The guard is only used by the recovery path, so normal
  reads/writes on a healthy canvas never touch it.
- If the lock/recovery state is corrupt/unverifiable, belongs to another hostname, hard links are unavailable
  on the filesystem, or the recovery guard's holder is dead, acquisition fails closed with
  `CANVAS_LOCK_UNVERIFIABLE`. This is **not** retryable without operator action: stop, inspect the store and
  `.locks/` on the local host, and treat cross-host or network-filesystem stores as unsupported.
- If your write loses its lock generation (for example another process recovered a dead owner, or a stale
  handle is reused), the store rejects it with `CANVAS_LOCK_OWNERSHIP_LOST` and writes nothing: re-read the
  revision and retry.

### Operator cleanup for a dead/dangling recovery guard

Only needed when writes keep failing with `CANVAS_LOCK_UNVERIFIABLE` and the diagnostics show a dead
`recoveryGuard` (a guard holder crashed mid-recovery). Do this **only with every canvas server process
stopped**:

1. Stop all server processes that use this store.
2. Run the read-only library diagnostic and confirm the reported `recoveryGuard` owner is dead and no live
   writer/marker/guard exists:
   ```js
   import { inspectCanvasLock } from 'jiflow-canvas-mcp';
   console.log(inspectCanvasLock('/path/to/store', 'canvas-demo-a'));
   // look at .recoveryGuard { exists, owner, alive, unverifiable } and .recoveryMarker
   ```
3. Only if the guard is dead/absent and no live holder exists, remove the dangling file
   `<store>/.locks/.<canvasId>.recovery-guard` with a trusted local tool. Never remove a live or foreign
   guard; never remove the write-lock `.lock` record or a live `.recovery` marker.
4. Restart and retry. The next process can acquire the guard and safely reclaim any dead marker, then recover
   the dead write lock.

Leftover legacy lock paths from an earlier candidate (an **empty directory** at
`<store>/.locks/<canvasId>.lock/`) are not valid owner records: the server fails closed with
`CANVAS_LOCK_UNVERIFIABLE` on them and never takes them over. A pre-release/demo store upgrading across the
The owner-file lock fix must stop all server processes and remove only such leftover empty legacy directories manually; never do
this while a server may be running, and never remove a current `.lock` owner file.

**Do not delete lock files manually** to "fix" a busy or unverifiable lock — the lock is internal state with an
owner token and fence; manually removing it can create two owners and break the safety guarantees. The one
documented exception is the crashed-guard cleanup above, after read-only diagnostics and with all processes
stopped. Otherwise stop all server processes and inspect (read-only) with
`inspectCanvasLock(storeDir, canvasId)`. Do not edit or delete `.locks/.<canvasId>.recovery-guard` unless you
are following that procedure.

## 6. Restart after `kill -9`

The store is crash-safe by construction:

- a write either completed its atomic rename (state + receipt committed) or it did not;
- a leftover `.locks/<canvasId>.lock` owner record is recovered automatically only if its owner is provably
  dead (same host) and the lock is older than `--stale-lock-ms`; the recovery is fenced, so a superseded
  writer cannot commit;
- `.locks/<canvasId>.fence` preserves the monotonic lock generation across restarts;
- `.locks/.<canvasId>.recovery` is a hidden recovery marker; a marker left by a dead recoverer is reclaimed
  only under the hidden `.locks/.<canvasId>.recovery-guard`, by re-validating the same dead marker, so a
  crashed marker does not block forever and cannot be moved by a delayed recoverer;
- a **crashed recovery-marker holder auto-recovers** on the next attempt; a **crashed recovery-guard holder**
  does not auto-recover — dead-marker recovery for that canvas fails closed with
  `CANVAS_LOCK_UNVERIFIABLE` and needs the documented operator cleanup (§5). Normal writes on a healthy canvas
  never touch the guard;
- temp files are cleaned best-effort; leftover `.claim-*` / `.quarantine-*` / `.marker-claim-*` /
  `.marker-quarantine-*` / `.guard-claim-*` files are ignored by readers and can be deleted manually only when
  all server processes are stopped. Never delete a live `.lock` owner record, a live `.recovery` marker or a
  live `.recovery-guard`.

After a restart:

1. Reconnect and re-authenticate (the token and principal are the same).
2. Check `canvas_read_receipt` / `canvas_list_receipts` for the `operationId` that was in flight.
3. Replay it if it is absent; do nothing if it is present.

## 7. A minimal retry loop (pseudo-code)

```js
async function recoverableWrite(client, { operationId, expectedRevision, buildActions, readRevision }) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    // 1) did a previous attempt already land?
    const receipt = await client.callTool('canvas_read_receipt', { canvasId, operationId });
    if (!receipt.isError) return receipt; // committed earlier — done

    // 2) build the payload from the latest state and explicit ids
    const revision = expectedRevision ?? (await readRevision());
    const actions = await buildActions(revision); // must be deterministic for identical retries
    const result = await client.callTool('canvas_commit_batch', {
      canvasId,
      actions,
      expectedRevision: revision,
      operationId
    });

    if (!result.isError) return result;

    const code = result.payload?.code;
    if (code === 'CANVAS_OPERATION_PAYLOAD_CONFLICT') {
      // operationId was used with a different payload: generate a new one for a new decision
      operationId = `op-${crypto.randomUUID()}`;
      continue;
    }
    if (code === 'CANVAS_REVISION_CONFLICT' || code === 'CANVAS_LOCK_OWNERSHIP_LOST') {
      expectedRevision = undefined; // re-read before rebuilding; nothing was written
      continue;
    }
    if (code === 'CANVAS_STORE_BUSY') {
      await sleep(50 * 3 ** attempt);
      continue;
    }
    if (code === 'CANVAS_LOCK_UNVERIFIABLE') {
      // fail closed: operator action required; do not retry, do not delete the lock
      throw new Error(`lock unverifiable: operator must inspect the store (${code})`);
    }
    throw new Error(`non-retryable: ${code}`);
  }
  throw new Error('retry budget exhausted');
}
```

Caveat: the pseudo-code above is illustrative. Idempotent replay requires the retried payload to be
**byte-identical after canonical-JSON normalisation** (same `operationId`, same `canvasId`, same
`expectedRevision`, same actions, same explicit ids). If `buildActions` produces generated ids or timestamps,
reuse the same values on retry rather than regenerating them.

## 8. What not to do

- Do not delete or edit `<store>/canvases/*.json` while a server may be running. Writers take the fenced lock
  per canvas, but external edits are not coordinated; use the API or stop all servers first.
- **Do not delete, rename or edit `<store>/.locks/*.lock` / `*.fence` / `.*.recovery` / `.*.recovery-guard`
  to "fix" a lock.** These files carry owner tokens and monotonic fences; manually removing them can create
  two owners. Live holders are never preempted, dead-owner recovery is automatic (same-host liveness + age
  gate + guard), and unverifiable state fails closed on purpose. The only documented exception is the
  crashed-guard cleanup in §5, after read-only diagnostics and with all canvas processes stopped.
- Do not reuse demo tokens or the demo store for real data.
- Do not retry non-retryable authorization/validation errors (`CANVAS_READ_ONLY`,
  `CANVAS_CANVAS_SCOPE_MISMATCH`, `CANVAS_TOOL_DENIED`, `CANVAS_ARGUMENTS_INVALID`, …) without changing
  the request.
- Do not treat `replayed: true` as a new commit; it means the operation was already applied at
  `revision = resultingRevision`.
