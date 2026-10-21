# Security — jiflow-canvas-mcp

This document describes the security model of `jiflow-canvas-mcp` v0.1.0: the trust boundary, threat model,
what an AI agent can and cannot reach, token handling, fail-closed startup, path containment, store
permissions and atomicity, audit logging, CAS as a safety property, and the known risks and limitations.

> **Status:** **MIT licensed**; final independent verification passed with 179/179 automated tests and 11/11 functional
> acceptance checks. The project is staged in the private GitHub repository
> [`q973946080/jiflow-canvas-mcp`](https://github.com/q973946080/jiflow-canvas-mcp) and is **not yet publicly released**.
> **No external security audit, fuzzing or penetration test has been performed.** The statements below describe
> the implemented design and the verification that exists; they are not a certification. The full candidate
> directory must never be published (only the explicit-whitelist public package is eligible for release).
>
> **This is not a production-hardened multi-tenant service.** It is a local, single-user, stdio-only server.

## Contents

- [Trust boundary](#trust-boundary)
- [Threat model](#threat-model)
- [What an AI agent can and cannot reach](#what-an-ai-agent-can-and-cannot-reach)
- [Token handling](#token-handling)
- [Fail-closed startup and exit codes](#fail-closed-startup-and-exit-codes)
- [Path containment](#path-containment)
- [Store permissions, locking and atomicity](#store-permissions-locking-and-atomicity)
- [Audit logging](#audit-logging)
- [CAS conflict as a safety property](#cas-conflict-as-a-safety-property)
- [Known risks and limitations](#known-risks-and-limitations)
- [What the verification does and does not prove](#what-the-verification-does-and-does-not-prove)
- [Reporting](#reporting)

## Trust boundary

The trust boundary is the **server process** and the `<store>` directory it was started with.

```text
  trusted: the operator who starts the process and controls the token, auth config, store dir and flags
  ──────────────────────────────────────────────────────────────────────────────────────────────
  │  node src/server/main.mjs --store <dir> --auth <file>   (one MCP client per process)
  │  env: CANVAS_MCP_TOKEN
  ▼
  untrusted (but authenticated and scoped): the MCP client / AI agent and everything it sends
  — tool names, arguments, control data arriving on stdin
  ▼
  trusted: the local filesystem under <store> (single-writer canvas JSON files + locks)
```

Assumptions:

1. The server runs on a **local machine** controlled by the operator; the store directory is on a local
   filesystem with atomic **hard-link** and `rename` semantics. Cross-host/network-filesystem stores are
   unsupported (lock liveness is same-host only).
2. The operator starts the server and supplies the token and auth config out of band. The MCP client is not
   trusted to enforce anything by itself.
3. **One MCP client per server process.** The server authenticates exactly one principal at startup and
   serves exactly one client over its stdio pipes. It is not a shared server.
4. The client's process environment is the boundary for token secrecy: if the local machine or the client
   process is compromised, the token and store are compromised too. The server does not defend against a
   local attacker who already has the operator's filesystem access.

## Threat model

In scope — attacks from an untrusted/compromised **agent or MCP client** that has been given a token:

| Threat | Mitigation |
|---|---|
| Agent calls tools outside the intended surface (shell, file, HTTP, delete) | Only nine `canvas_*` tools exist; anything else is rejected by the whitelist before any store access (`CANVAS_TOOL_NOT_WHITELISTED`). There is no shell/file/network/delete tool and no bypass flag. |
| Agent over-reaches across canvases | Principal `canvasIds` allowlist; every tool naming an out-of-scope canvas is rejected (`CANVAS_CANVAS_SCOPE_MISMATCH`); listing silently filters. |
| Read-only agent attempts writes | `mode: READ_ONLY` + write tool → `CANVAS_READ_ONLY` before store access. |
| Agent passes protected/unknown node fields to corrupt invariants | Protected fields rejected (`CANVAS_NODE_FIELD_PROTECTED`); unknown fields rejected (`CANVAS_NODE_FIELD_UNKNOWN`); strict JSON schemas with `additionalProperties: false`. |
| Agent uses malicious ids for path traversal or file overwrite | Ids are validated against anchored patterns and stripped of `..`, `/`, `\` **before any path join**; the store never opens a path derived from an unvalidated id. |
| Agent injects a forged operation scope to change receipt attribution | Operation scopes are minted by the server and tracked in a `WeakSet`; forged scopes are rejected (`CANVAS_AUTH_DENIED`). |
| Concurrent agents silently overwrite each other | CAS on `expectedRevision` + a per-canvas **fenced owner-file lock**: stale writers get `CANVAS_REVISION_CONFLICT` with the actual revision; exactly one writer wins. |
| A concurrent writer **preempts a live lock holder** | The lock has a unique owner token, PID and hostname; a same-host live owner (`process.kill(pid, 0)` → alive/`EPERM`) is **never preempted**. Age alone is never treated as death; a waiter that cannot get the lock before its deadline gets `CANVAS_STORE_BUSY`. |
| A process that lost its lock generation still commits | Ownership is verified before the updater **and again immediately before the atomic write**; the handle fence must match the lock/fence files and be ≥ the persisted `state.lockFence`. Otherwise `CANVAS_LOCK_OWNERSHIP_LOST` and **nothing is written**. |
| A late release deletes another process's lock | Release is **ownership-checked**: it unlinks the lock only when token/PID/hostname match the handle; a foreign/already-released lock returns `false` and never throws, leaving the current owner's lock intact. |
| A crashed writer's lock blocks the store forever or is stolen unsafely | Recovery only for a **provably dead same-host owner** (`ESRCH`) whose lock file is older than the `--stale-lock-ms` age gate. Recovery is serialised by a hidden per-canvas **recovery marker**: only the marker holder may remove a dead owner's lock record, and it must re-read the same dead owner (token/PID/hostname/fence) and re-check liveness/age first. A corrupt record, foreign host or undeterminable liveness fails closed with `CANVAS_LOCK_UNVERIFIABLE` — no takeover. |
| Two recoverers race a **dead recovery marker**, or a delayed recoverer moves/deletes a **live** marker | Dead-marker reclaim requires the separate hidden **recovery guard**: only the guard holder may quarantine a dead marker, and under the guard the marker must still be the same provably dead owner record (token/PID/hostname/fence, liveness=false, age gate); it is quarantine-renamed, re-validated and only that record is unlinked. A live marker/guard is never preempted. The guard is **never auto-reclaimed**: dead/foreign/corrupt/ambiguous guard state fails closed with `CANVAS_LOCK_UNVERIFIABLE` + `MANUAL_OPERATOR_CLEANUP_REQUIRED`. A crashed marker holder auto-recovers through the guard; a crashed guard holder deliberately does not. |
| Duplicate/double-applied writes after a crash or retry | Durable receipts keyed by `operationId`; identical replay returns `replayed: true` without a second write; mismatched reuse is rejected. |
| Secret leakage through logs, receipts or tool results | Tokens never logged or persisted; receipts contain hashes/ids only; audit logs contain `argsDigest` (SHA-256 of canonical args), never raw args or tokens. |
| Corrupt/partial state files after a crash | Writes use temp file + `fsync` + atomic `rename`; corrupt state is reported (`CANVAS_STORE_CORRUPT`), never silently reset. |

Out of scope — explicitly **not** defended:

- A local attacker with the operator's account, filesystem or process access (they can read the token env,
  auth file and store directly).
- A malicious store directory content crafted by someone with write access to the store (e.g. a pre-seeded
  canvas file with hostile data). The store validates structure but the directory is trusted operator input.
- Multi-tenant isolation: the server is single-principal per process; there is no tenant boundary, no
  per-request identity, and no resource quotas.
- Denial of service by a client that floods stdin or holds a lock; the server processes messages
  sequentially and has a fixed lock timeout, but has no rate limiting or quotas.
- Supply-chain attacks on the devDependency; the server has zero runtime dependencies and does not load the
  devDependency at runtime.

## What an AI agent can and cannot reach

**Can reach:** exactly the nine whitelisted canvas tools, subject to the principal's mode, canvas allowlist
and tool allowlist:

- reads: `canvas_list_canvases`, `canvas_read_canvas`, `canvas_read_node`, `canvas_read_receipt`,
  `canvas_list_receipts`;
- writes: `canvas_create_node`, `canvas_patch_node`, `canvas_connect_nodes`, `canvas_commit_batch`.

**Cannot reach:**

- no shell/exec/process tool (`child_process` is not imported anywhere in `src/`);
- no filesystem tool — the only file access is the configured `<store>` (plus the read-only auth config at
  startup);
- no network tool — `node:http`, `node:https`, `node:net`, `node:dns`, `fetch`, WebSockets are not imported
  or used in `src/`; there is no listener and no outbound call;
- no delete/group/move tool — v1 has no node/edge delete actions, so data cannot be removed through MCP;
- no way to change identity, permissions, the store path or the token at runtime;
- no way to read the auth config file or the token through a tool (both are outside the tool surface).

The server's stdout carries only JSON-RPC responses; stderr carries audit lines. No other output channel is
exposed to the client.

## Token handling

- **Raw tokens are supplied only through the `CANVAS_MCP_TOKEN` environment variable.** The server never
  accepts a token as a CLI flag, a tool argument, a file inside the store or a JSON-RPC field.
- **The auth config stores only `tokenSha256`** (lowercase hex SHA-256 of the UTF-8 token). No raw token is
  ever written to the auth file, the store, a receipt, a log line or a tool result.
- **Matching is constant-time** (`crypto.timingSafeEqual`) against every configured digest; exactly one
  match is required. Duplicate digests across principals make the config invalid.
- **Tokens are never logged.** The audit logger is allow-list based and has no token field; the startup line
  records `principalId`/`agentId`, never the token.
- **Tokens are never returned by tools.** Receipt projections and read results contain no token material.
- **Demo tokens are public by design.** `examples/auth.demo.json` is generated by `npm run seed:demo` with
  the deliberately weak tokens `demo-writer-a-token`, `demo-writer-b-token`, `demo-reader-token`. These are
  documented fictional fixtures; **never reuse them outside the demo**, and never point a real store at the
  demo auth file.
- **Generation guidance:** use a high-entropy random token per principal, store only its SHA-256 digest in
  the auth config, and inject the raw token into the server process through a secret mechanism supported by
  your MCP client (not a committed file). Example:

  ```bash
  node -e "console.log(require('node:crypto').createHash('sha256').update(process.argv[1],'utf8').digest('hex'))" "$(openssl rand -hex 32)"
  ```

- **No rotation or expiry.** A token is valid until the auth config changes and the server restarts; see
  [Known risks](#known-risks-and-limitations).

## Fail-closed startup and exit codes

Startup checks run in a fixed order and any failure terminates the process before it serves a request:

| Step | Failure | Wire code | Exit |
|---|---|---|---|
| Parse CLI flags | unknown flag, non-integer lock/stale value | `CANVAS_ARGUMENTS_INVALID` | `2` |
| Store directory | missing, not a directory, or store cannot be initialised | `CANVAS_STORE_UNAVAILABLE` | `2` |
| Auth config | unreadable, invalid JSON, schema violation (bad mode, bad digest, duplicate digest, unknown tool, bad canvas id) | `CANVAS_AUTH_CONFIG_INVALID` | `3` |
| Token | `CANVAS_MCP_TOKEN` missing or empty | `CANVAS_AUTH_REQUIRED` | `3` |
| Token match | no principal digest matches, or ambiguous match | `CANVAS_PRINCIPAL_UNKNOWN` | `3` |
| Unexpected internal error | any non-`CanvasMcpError` at startup | `CANVAS_INTERNAL_ERROR` | `1` |
| Normal | `--help`, `--version`, EOF on stdin, graceful `SIGINT`/`SIGTERM` | — | `0` |

Fail-closed details:

- There is **no anonymous mode, no demo bypass and no flag to disable authentication**. A missing token is
  fatal.
- The raw token is checked before the store is opened for serving, so an unauthenticated process never
  accepts JSON-RPC.
- Startup failures are reported as a single stderr JSON line with `{ts,event:"server_error",ok:false,code,
  error}`; no stack traces, tokens or file contents are printed.
- Tool-level failures are MCP tool results (`isError: true` with a stable code), not process crashes; the
  server keeps serving.

## Path containment

The store is the only filesystem reach of the server, and it is reached only through validated identifiers:

- **Canvas ids** must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` and may not contain `..`, `/` or `\`. They
  are validated **before** the path `<store>/canvases/<canvasId>.json` is constructed, so an id such as
  `../../etc/passwd` or `a/b` is rejected as `CANVAS_CANVAS_ID_INVALID` and never touches the filesystem.
- **Node, edge and operation ids** must match `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$` and may not contain
  `..`, `/` or `\`. They are stored inside JSON values, never used as path components.
- **Canvas listing** only considers regular files whose filename matches
  `^(<canvas-id>)\.json$` inside `<store>/canvases/`; other files are ignored.
- Temp files for atomic writes are created **inside** `<store>/canvases/` with a generated name; writes never
  target a path outside the store.
- The auth config is opened **read-only** at startup only.
- The server does not follow symlinks in any way that could redirect a store operation outside the store;
  the operator is responsible for not configuring `<store>` as a symlink to an untrusted location.

## Store permissions, locking and atomicity

- Canvas state files and temp files are created with mode **`0600`** (owner read/write only) and written via
  a same-directory temp file → `fsync` → atomic `rename`. A reader sees the complete old or complete new
  file, never a partial write.
- State files include the operation receipt, so a committed write and its receipt are atomic: there is no
  "applied but unrecorded" or "recorded but not applied" state after a crash.
- **Lock files are JSON owner records, not directories.** `<store>/.locks/<canvasId>.lock` (mode `0600`)
  contains `{version, canvasId, token, pid, hostname, acquiredAt, fence}`; it is claimed atomically by
  hard-linking a fully written, `fsync`ed claim file (`fs.linkSync`), so a reader never sees a partial record.
  `<store>/.locks/<canvasId>.fence` is a monotonic counter (`{version, fence}`), also `0600`.
- A live owner is **never** preempted: same-host liveness is checked with `process.kill(pid, 0)` and the waiter
  sleeps with 5–25 ms jitter until `--lock-timeout-ms`, then fails with `CANVAS_STORE_BUSY`.
- Recovery is allowed only for a **provably dead** same-host owner (`ESRCH`), and only after the lock file age
  exceeds `--stale-lock-ms` (default 10000) as an extra conservative gate. Recovery is serialised by a hidden
  per-canvas recovery marker (`.<canvasId>.recovery`): only the marker holder may remove a dead owner's lock
  record, after re-reading the **same** dead owner (token/PID/hostname/fence) and re-checking liveness and age.
- Reclaiming a **dead recovery marker** is itself serialised by the hidden **recovery guard**
  (`.<canvasId>.recovery-guard`, mode `0600`): only the guard holder may quarantine a dead marker, it must
  re-read the same provably dead marker (token/PID/hostname/fence, liveness=false, age gate), quarantine
  rename + revalidate + unlink only that record, and release the guard in `finally`. A live marker/guard is
  never preempted. The guard is **never auto-reclaimed**: dead/foreign/corrupt/ambiguous guard state fails
  closed with `CANVAS_LOCK_UNVERIFIABLE` and `action: MANUAL_OPERATOR_CLEANUP_REQUIRED`. A crashed marker
  holder auto-recovers via the guard; a crashed guard holder requires trusted operator cleanup (all canvas
  processes stopped, state inspected read-only with `inspectCanvasLock` before removing only the dangling
  guard file).
- If the lock cannot be validated safely (corrupt/unknown record, foreign hostname, undeterminable liveness,
  hard links unavailable on the filesystem), acquisition fails closed with `CANVAS_LOCK_UNVERIFIABLE`; no
  takeover and no write occur.
- Store writes are fenced: `updateCanvas` verifies ownership before and after the updater and immediately
  before the atomic write, and rejects a handle older than the persisted `lockFence` with
  `CANVAS_LOCK_OWNERSHIP_LOST`. Release is ownership-checked and never deletes a foreign lock.
- Corrupt or wrong-shape state is reported as `CANVAS_STORE_CORRUPT` and is never re-initialised or
  overwritten. The server never "repairs" data silently.
- The store directory itself is created by the operator; the server creates `canvases/` and `.locks/` on
  startup. Restrict the store directory's permissions to the account that runs the server.

## Audit logging

The audit logger (`src/logger.js`) writes one JSON object per line to **stderr only**. stdout is a pure
protocol channel, so tool results can never be mixed with logs.

Fields (allow-list; unknown fields passed by callers are dropped):
`ts`, `event`, `principalId`, `agentId`, `tool`, `ok`, `code`, `ms`, `argsDigest`, `operationId`, `revision`,
`store`, `tools`, `version`.

- `argsDigest` is `sha256(canonicalJson(arguments))` — a correlation digest. **Raw arguments are never
  logged**, and neither are tokens, token digests, file contents or node data.
- Events: `server_start`, `server_error`, `tool_call`, `tool_error`, `store_conflict`, `auth_denied`.
- Values must not contain secrets; the logger's allow-list means a future caller cannot accidentally add a
  token field without changing the logger.
- Logging failures are swallowed (`try/catch` around the sink): a broken stderr must not take the server
  down or change a tool result.
- Logs are written to the process stderr, so their retention and access control are the operator's/MCP
  client's responsibility.

## CAS conflict as a safety property

CAS is not only a concurrency feature; it is a **safety property**. Every write declares the revision it
believes is current (`expectedRevision`). If the canvas has moved on, the write is rejected with
`CANVAS_REVISION_CONFLICT` and `{expectedRevision, actualRevision}`, and **nothing is written**: no state
change, no revision bump, no receipt. This prevents a stale agent from overwriting changes it never saw — the
failure mode is a clear, recoverable error rather than silent data loss.

The check runs **inside** the per-canvas fenced lock against a freshly re-read state, so it is a real
compare-and-swap rather than a read-then-write race. Optimistic concurrency is also why a retry after a
conflict must re-read the canvas and submit a fresh `expectedRevision` (with a new operation id, because the
payload changed). Reads do not take the lock and cannot observe a torn write because writes are atomic renames.
If the writer's lock generation is superseded, the write is rejected earlier with
`CANVAS_LOCK_OWNERSHIP_LOST` — also with nothing written.

## Known risks and limitations

1. **Static tokens, no rotation or expiry.** Tokens are configured in a JSON file; changing one requires
   editing the file and restarting the server. There is no revocation API, no per-session identity, no token
   expiry and no OAuth/identity-provider integration. Treat the auth file as a secret-configuration file.
2. **Local, same-host filesystem trust.** The store, locks and auth config are trusted operator input. The
   server does not protect against a local attacker with the operator's account or against a hostile
   pre-seeded store. Lock safety relies on local filesystem semantics (atomic hard link + `rename`) and
   same-host process liveness. Network/shared filesystems (NFS/SMB), cross-host stores and containers with
   different hostnames are **unsupported**: a foreign-host owner record fails closed with
   `CANVAS_LOCK_UNVERIFIABLE` instead of being taken over. Recovery is conservative: age alone is never proof
   of death and a live owner is never preempted.
3. **No TLS.** The transport is a local stdio pipe between the MCP client and the server; there is no
   network listener and therefore no transport encryption. "No TLS" is a design consequence of stdio-only,
   not a missing feature — but if you wrap or expose this server remotely (e.g. via a socket bridge), you own
   transport security, authentication at that boundary, and the new threat model.
4. **No multi-tenant auth server.** One process serves one principal. There is no tenant isolation, no
   request-level identity, no fine-grained per-node ACLs, and no resource limits.
5. **PID reuse is ambiguous by design; recovery is fail-closed.** Same-host liveness uses
   `process.kill(pid, 0)` and there is no PID-start-time check. If a crashed owner's PID is immediately reused
   by a live process, the lock is treated as held (wait → `CANVAS_STORE_BUSY`), not preempted. Recovery only
   happens on a definitive `ESRCH` death **plus** the `--stale-lock-ms` age gate; a lock that cannot be
   validated (`CANVAS_LOCK_UNVERIFIABLE`) is never taken over. `--lock-timeout-ms` only bounds the waiter; it
   never grants ownership. There is no distributed consensus, lock service or cross-host fencing.
6. **No delete tools.** Data cannot be removed through MCP in v1; tombstones exist only for id-reuse
   validation. Removing data requires direct filesystem access.
7. **No external security audit yet.** No independent penetration test and no fuzzing evidence exists for
   this candidate; the security posture is based on design review and the black-box acceptance checks
   (unauthorized calls, traversal ids, isolation scan).
8. **Audit logs are local stderr and not tamper-evident.** A user with filesystem/process access can alter
   or delete them; there is no remote log sink, no append-only storage and no log signing.
9. **The candidate's devDependency is not a runtime risk.** `@modelcontextprotocol/sdk@1.30.0` (MIT) is
   used only by the protocol test suite and the acceptance runner; `src/` has zero bare imports and never
   loads `node_modules`.
10. **A compromised MCP client holds a valid token for its principal.** It cannot escape its mode/scope, but
    it can perform every action that scope allows until the operator rotates the token and restarts.
11. **A crashed recovery-guard holder is a fail-closed availability trade-off.** The guard is deliberately
    never auto-reclaimed (auto-reclaim would re-open the recovery race it exists to close). After a guard
    holder crashes mid-recovery, dead-marker recovery for that canvas fails closed with
    `CANVAS_LOCK_UNVERIFIABLE` (`action: MANUAL_OPERATOR_CLEANUP_REQUIRED`; `detail.reason` one of
    `GUARD_OWNER_DEAD`, `GUARD_FOREIGN_HOST`, `GUARD_RECORD_INVALID`, `GUARD_LIVENESS_UNKNOWN`) until a trusted
    operator, with all canvas processes stopped, verifies state read-only (`inspectCanvasLock`) and removes only
    the dangling `.locks/.<canvasId>.recovery-guard` file. Normal reads/writes on a healthy canvas never touch
    the guard. Never remove a live or foreign guard, and never delete the write lock record this way.

## What the verification does and does not prove

The black-box security acceptance check (`C08_unauthorized_rejected` in the acceptance matrix) exercised:
a server refusing to start without a token (exit 3), unknown token (exit 3), invalid auth file (exit 3),
`READ_ONLY` write rejection, cross-canvas access rejection, `allowedTools` denial, whitelist-bypass tool
names (`bash`, `read_file`, `web_fetch`, `exec`, …), traversal-shaped ids, and the absence of files created
outside the store after malicious calls. `C10_isolation_security` scanned the publishable tree for secrets,
PII, absolute developer paths, real asset references and product terms (clean, with documented fictional
demo fixtures allowlisted), and confirmed the runtime imports no network/exec modules.

The candidate includes a **13-test real multi-process lock-safety suite** to `npm test`
(`test/concurrency/lock-safety.test.mjs`): live-owner non-preemption past the old stale threshold,
ownership-checked release that cannot delete a foreign lock, strictly non-overlapping critical sections,
fencing (`CANVAS_LOCK_OWNERSHIP_LOST` with byte-identical state on rejection), SIGKILL/crash recovery only
after proven death plus the age gate, same-`operationId` single-apply, parallel canvases without unnecessary
blocking, 25 rounds of randomized 3–5-process contention (94 operations, 0 overlapping critical sections),
a multi-recoverer race with exactly one winner, and fail-closed handling of corrupt/foreign-host/
malformed-fence/legacy locks (`CANVAS_LOCK_UNVERIFIABLE`). A deterministic pre-fix reproduction run against
the earlier private implementation shows the old race; it does **not** reproduce against this implementation.

The recovery-guard revision added a **6-test deterministic recovery-marker-race suite** to `npm test`
(`test/concurrency/recovery-marker-race.test.mjs`) covering the recovery guard: a deterministic pre-fix
reproduction on the earlier implementation reproduces the race (a live recovery marker moved/deleted, two
recovery owners) while the same harness on this implementation is **not reproducible**; two recoverers of a
dead marker cannot both pass the guard; dead-marker reclaim occurs only under the guard after same-dead-owner
revalidation; a crashed guard holder fails closed with `CANVAS_LOCK_UNVERIFIABLE` and intact state; a crashed
marker holder auto-recovers through the guard; and a stale-handle write is rejected with
`CANVAS_LOCK_OWNERSHIP_LOST` leaving state unchanged.

This **does not** prove resistance to a determined local attacker, memory-safety (JavaScript), filesystem
failure modes, fuzzing coverage, lock safety across hosts (same-host only), or fitness for multi-tenant
deployment. It is design verification, not a security audit.

## Reporting

Please report suspected security vulnerabilities privately by emailing **[chen01220992 (at) gmail (dot) com](mailto:chen01220992%40gmail.com)**.
Do not post an unpatched vulnerability in a public issue or discussion. Include the affected version or commit,
impact, reproduction steps, and any relevant logs that do not contain secrets or personal data. Do not attach
credentials, access tokens, or unrelated personal information. There is no PGP key published at this time.

The maintainer aims to acknowledge a report within **7 calendar days**. Investigation, fixes, and disclosure timing
depend on severity, reproducibility, and maintainer availability; an acknowledgement target is not a guarantee
of a remediation deadline. If you do not receive an acknowledgement after 7 days, follow up using the same email.

This project has passed its current independent technical verification, but that is not a substitute for an
external security audit, fuzzing, or penetration testing. The repository remains private during release staging;
public release requires a separate explicit maintainer decision. Do not deploy this candidate in an untrusted or
public environment without your own security review.

See [`README.md`](README.md) for project status and [`ARCHITECTURE.md`](ARCHITECTURE.md) for the design.
