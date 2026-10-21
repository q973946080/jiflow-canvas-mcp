/**
 * Safe per-canvas single-writer lock implemented as a JSON owner file.
 *
 * Protocol (see ARCHITECTURE.md for the design rationale):
 *
 * - Claim: a complete owner record is written to a unique claim file (mode 0600, fsync'ed) and
 *   hard-linked to `<store>/.locks/<canvasId>.lock`. `fs.linkSync` is atomic: exactly one process
 *   can create the link, every other process gets `EEXIST`. The claim file is unlinked afterwards,
 *   so a reader always observes either no lock or a complete owner record (never a partial write).
 * - Fence: before the handle is returned the winner reads `<canvasId>.fence` (missing = 0), writes
 *   `fence + 1` and rewrites the owner record with that fence. Fences are strictly increasing across
 *   lock generations, so a writer that lost ownership can be rejected even if it still holds a handle.
 * - Waiting/recovery: a live owner (same host, `process.kill(pid, 0)` says alive) is never preempted;
 *   the waiter sleeps with jitter until the deadline (`CANVAS_STORE_BUSY`). An owner is recovered only
 *   when it is provably dead: same host and liveness is definitively `ESRCH`; the file age (`mtime`)
 *   must additionally exceed `staleMs`.
 * - Two-level recovery serialisation: recovery is serialised by a hidden per-canvas recovery
 *   marker (`.<canvasId>.recovery`): only its holder may remove a dead owner's lock record, and under
 *   the marker the recoverer must re-read the lock and require the SAME dead owner (token/pid/
 *   hostname/fence), re-check liveness and age. A marker can itself be left behind by a crashed
 *   recoverer, so reclaiming a provably dead marker is guarded by a second, **never auto-reclaimed**
 *   recovery guard (`.<canvasId>.recovery-guard`): only the guard holder may quarantine/reclaim the
 *   dead marker (with same-owner re-validation) and the guard is always released in `finally`. A dead,
 *   foreign, corrupt or liveness-ambiguous guard fails closed (`CANVAS_LOCK_UNVERIFIABLE`, manual
 *   operator cleanup) instead of being reclaimed, which closes the reported race where a delayed
 *   recoverer could move and delete a freshly created live marker.
 * - Fail closed: corrupt/unknown records, foreign-host owners and ambiguous liveness raise
 *   `CANVAS_LOCK_UNVERIFIABLE`; nothing is taken over and nothing is written. Age alone is never
 *   treated as proof of death.
 *
 * The low-level owner-record / recovery-marker / recovery-guard primitives live in
 * `src/store/lock-internals.js` (internal module, not re-exported from `src/index.js`).
 *
 * Only same-host stores are supported for stale recovery, because liveness is checked with
 * `process.kill(pid, 0)` on the local machine. A foreign-host owner record fails closed.
 *
 * Node built-ins only: `node:fs`, `node:os`, `node:path`, `node:crypto`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ERROR_CODES, canvasError } from '../errors.js';
import {
  OWNER_RECORD_VERSION,
  assertLockCanvasId,
  assertNonNegativeInteger,
  assertStoreDirectory,
  ensureRecoveryMarker,
  inspectRecoveryGuard,
  inspectRecoveryMarker,
  isPlainObject,
  isProcessAlive,
  lockUnverifiable as unverifiable,
  parseOwnerRecord,
  readOwnerRecord,
  releaseRecoveryMarker,
  readTextIfExists,
  removeOwnedRecord,
  sleepUntilDeadline,
  tryClaimRecord,
  writeJsonAtomic
} from './lock-internals.js';

/** Default maximum time to wait for a held lock before reporting `CANVAS_STORE_BUSY`. */
export const DEFAULT_LOCK_TIMEOUT_MS = 5000;
/** Default minimum age used as an extra recovery gate for a *provably dead* owner. */
export const DEFAULT_STALE_LOCK_MS = 10000;

const FENCE_RECORD_VERSION = 1;

/**
 * Path of the JSON owner file for a canvas.
 *
 * @param {string} storeDir store root directory
 * @param {string} canvasId canvas id
 * @returns {string} `<store>/.locks/<canvasId>.lock`
 */
export function canvasLockPath(storeDir, canvasId) {
  assertStoreDirectory(storeDir);
  assertLockCanvasId(canvasId);
  return path.join(storeDir, '.locks', `${canvasId}.lock`);
}

/**
 * Path of the fence counter file for a canvas.
 *
 * @param {string} storeDir store root directory
 * @param {string} canvasId canvas id
 * @returns {string} `<store>/.locks/<canvasId>.fence`
 */
export function canvasFencePath(storeDir, canvasId) {
  assertStoreDirectory(storeDir);
  assertLockCanvasId(canvasId);
  return path.join(storeDir, '.locks', `${canvasId}.fence`);
}

/**
 * Read the monotonic fence counter. Missing file means `0`; a malformed file is fail-closed.
 *
 * @param {string} fencePath fence file path
 * @param {string} canvasId canvas id
 * @returns {number} current fence value
 */
function readFenceValue(fencePath, canvasId) {
  const raw = readTextIfExists(fencePath);
  if (raw === null) {
    return 0;
  }
  let record;
  try {
    record = JSON.parse(raw);
  } catch {
    throw unverifiable('canvas fence file is not valid JSON', { canvasId });
  }
  if (
    !isPlainObject(record) ||
    record.version !== FENCE_RECORD_VERSION ||
    !Number.isSafeInteger(record.fence) ||
    record.fence < 0
  ) {
    throw unverifiable('canvas fence file is invalid', { canvasId });
  }
  return record.fence;
}

/**
 * Claim the write lock with a complete owner record (see `tryClaimRecord` in the internals module).
 *
 * @param {object} options
 * @param {object} options.claim complete claim record (fence 0 while claiming)
 * @param {string} options.lockPath owner file path
 * @param {string} options.locksDir `<store>/.locks`
 * @param {string} options.canvasId canvas id
 * @returns {{acquired: true} | {acquired: false}}
 */
function tryClaimLock({ claim, lockPath, locksDir, canvasId }) {
  return tryClaimRecord({
    recordPath: lockPath,
    record: claim,
    locksDir,
    tempPrefix: '.claim',
    kind: 'canvas lock',
    canvasId
  });
}

/**
 * Finish a successful claim: assign the next fence, persist the fence file, rewrite the owner record
 * with the real fence and return the frozen handle. On failure the just-claimed lock is released
 * (ownership-checked) before the error is propagated.
 *
 * @param {object} options
 * @param {object} options.claim complete claim record (fence 0)
 * @param {string} options.storeDir store root directory
 * @param {string} options.lockPath owner file path
 * @param {string} options.fencePath fence file path
 * @param {string} options.canvasId canvas id
 * @returns {Readonly<object>} frozen lock handle
 */
function finaliseClaim({ claim, storeDir, lockPath, fencePath, canvasId }) {
  let fence;
  try {
    fence = readFenceValue(fencePath, canvasId) + 1;
    writeJsonAtomic(fencePath, { version: FENCE_RECORD_VERSION, fence }, canvasId);
    writeJsonAtomic(lockPath, { ...claim, fence }, canvasId);
  } catch (error) {
    removeOwnedRecord(lockPath, canvasId, claim.token, claim.pid, claim.hostname);
    if (error && error.code === ERROR_CODES.LOCK_UNVERIFIABLE) {
      throw error;
    }
    throw unverifiable(
      `canvas lock could not be finalised: ${error && error.code ? error.code : 'unknown error'}`,
      { canvasId }
    );
  }
  return Object.freeze({
    canvasId,
    storeDir,
    token: claim.token,
    pid: claim.pid,
    hostname: claim.hostname,
    acquiredAt: claim.acquiredAt,
    fence,
    lockPath,
    fencePath
  });
}

/**
 * Handle the case where the lock path is already taken: wait for a live owner, or recover a provably
 * dead owner while holding the per-canvas recovery marker. Returns `'retry'` after waiting/progress
 * for the caller to retry its claim, `'claimed'` when the lock path was claimed during recovery, or
 * throws for unverifiable locks (fail closed).
 *
 * Recovery protocol:
 *  1. read the lock owner; wait if alive, fail closed if unverifiable, otherwise require age.
 *  2. acquire the recovery marker (`ensureRecoveryMarker`): only the marker holder may remove a dead
 *     owner's lock, and dead-marker reclaim itself is protected by the never-auto-reclaimed recovery
 *     guard (two-level protocol, see `src/store/lock-internals.js`).
 *  3. under the marker, re-read the lock path and require the SAME dead owner (token/pid/hostname/
 *     fence) that triggered recovery, re-check liveness and age, then unlink it.
 *  4. try the normal hard-link claim while still holding the marker; a process that wins the tiny
 *     free window makes this recoverer retry normally.
 *  5. always release the marker in `finally` (ownership-checked).
 *
 * @param {object} options
 * @param {object} options.claim complete claim record reused for the in-recovery claim attempt
 * @param {string} options.storeDir store root directory
 * @param {string} options.lockPath owner file path
 * @param {string} options.locksDir `<store>/.locks`
 * @param {string} options.canvasId canvas id
 * @param {string} options.hostname current hostname
 * @param {number} options.staleMs minimum owner-file age before dead-owner recovery
 * @param {number} options.deadline absolute acquire deadline
 * @returns {'claimed' | 'retry'}
 */
function handleHeldLock({
  claim,
  storeDir,
  lockPath,
  locksDir,
  canvasId,
  hostname,
  staleMs,
  deadline
}) {
  const detail = { canvasId };
  let owner;
  try {
    owner = readOwnerRecord(lockPath, canvasId);
  } catch {
    throw unverifiable('canvas lock is held by an unverifiable owner record', detail);
  }
  if (owner === null) {
    // The lock was released between our failed link and this read: retry the claim immediately.
    return 'retry';
  }
  if (owner.hostname !== hostname) {
    throw unverifiable('canvas lock owner is on another host; cross-host stores are unsupported', detail);
  }
  const alive = isProcessAlive(owner.pid);
  if (alive === undefined) {
    throw unverifiable('canvas lock owner liveness cannot be determined', detail);
  }
  if (alive) {
    // Never preempt a live owner; age is not evidence of death.
    sleepUntilDeadline(deadline);
    return 'retry';
  }
  let stats;
  try {
    stats = fs.statSync(lockPath);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return 'retry';
    }
    throw unverifiable('canvas lock cannot be inspected', detail);
  }
  if (Date.now() - stats.mtimeMs < staleMs) {
    // Dead owner, but the conservative age gate has not elapsed yet.
    sleepUntilDeadline(deadline);
    return 'retry';
  }
  // Serialise recovery: only the holder of the per-canvas recovery marker may remove the dead
  // owner's lock record, so a delayed recoverer can never move a lock that was legitimately
  // reclaimed in the meantime.
  const marker = ensureRecoveryMarker({ storeDir, canvasId, hostname, staleMs, deadline });
  try {
    let currentOwner;
    try {
      currentOwner = readOwnerRecord(lockPath, canvasId);
    } catch {
      throw unverifiable('canvas lock is held by an unverifiable owner record', detail);
    }
    if (currentOwner === null) {
      return 'retry';
    }
    const sameDeadOwner =
      currentOwner.token === owner.token &&
      currentOwner.pid === owner.pid &&
      currentOwner.hostname === owner.hostname &&
      currentOwner.fence === owner.fence;
    if (!sameDeadOwner) {
      // Another process made progress between our read and the marker acquisition; do not touch it.
      return 'retry';
    }
    const currentAlive = isProcessAlive(currentOwner.pid);
    if (currentAlive === undefined) {
      throw unverifiable('canvas lock owner liveness cannot be determined', detail);
    }
    if (currentAlive) {
      // The pid was reused by a live process: never preempt a live owner.
      return 'retry';
    }
    let currentStats;
    try {
      currentStats = fs.statSync(lockPath);
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        return 'retry';
      }
      throw unverifiable('canvas lock cannot be inspected', detail);
    }
    if (Date.now() - currentStats.mtimeMs < staleMs) {
      // Release the marker before sleeping: the normal wait path re-checks the age gate without it.
      return 'retry';
    }
    // Holding the recovery marker: exactly one recoverer can be here for this canvas, so the lock
    // record of a provably dead owner may be removed safely.
    try {
      fs.unlinkSync(lockPath);
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        return 'retry';
      }
      throw unverifiable('canvas lock could not be removed during recovery', detail);
    }
    // Try to claim the freed path while still holding the marker; if another process wins the tiny
    // free window, fall back to the normal wait/retry loop.
    const outcome = tryClaimLock({ claim, lockPath, locksDir, canvasId });
    return outcome.acquired ? 'claimed' : 'retry';
  } finally {
    // Ownership-checked, never throws: releasing must never mask the original outcome.
    releaseRecoveryMarker(marker);
  }
}

/**
 * Acquire the per-canvas lock.
 *
 * Success returns a frozen handle. The owner record is rewritten with the assigned fence before the
 * handle is returned, so a returned handle always carries a real (non-zero) fence.
 *
 * @param {object} options
 * @param {string} options.storeDir store root directory
 * @param {string} options.canvasId canvas id
 * @param {number} [options.timeoutMs=DEFAULT_LOCK_TIMEOUT_MS] maximum wait for a held lock
 * @param {number} [options.staleMs=DEFAULT_STALE_LOCK_MS] minimum age gate before dead-owner recovery
 * @param {string} [options.hostname=os.hostname()] hostname written to the owner record
 * @returns {Readonly<object>} frozen lock handle
 * @throws {CanvasMcpError} `CANVAS_STORE_BUSY` when a live owner holds the lock past the deadline,
 *   `CANVAS_LOCK_UNVERIFIABLE` when the lock cannot be validated safely,
 *   `CANVAS_STORE_UNAVAILABLE` when the lock directory cannot be created,
 *   `CANVAS_ARGUMENTS_INVALID` for invalid options
 */
export function acquireCanvasLock({
  storeDir,
  canvasId,
  timeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
  staleMs = DEFAULT_STALE_LOCK_MS,
  hostname = os.hostname()
} = {}) {
  assertStoreDirectory(storeDir);
  assertLockCanvasId(canvasId);
  assertNonNegativeInteger(timeoutMs, 'timeoutMs');
  assertNonNegativeInteger(staleMs, 'staleMs');
  if (typeof hostname !== 'string' || hostname.length === 0) {
    throw canvasError(ERROR_CODES.ARGUMENTS_INVALID, 'hostname must be a non-empty string');
  }
  const lockPath = canvasLockPath(storeDir, canvasId);
  const fencePath = canvasFencePath(storeDir, canvasId);
  const locksDir = path.dirname(lockPath);
  try {
    fs.mkdirSync(locksDir, { recursive: true });
  } catch {
    throw canvasError(ERROR_CODES.STORE_UNAVAILABLE, 'unable to initialise the canvas lock directory');
  }
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const claim = {
      version: OWNER_RECORD_VERSION,
      canvasId,
      token: randomUUID(),
      pid: process.pid,
      hostname,
      acquiredAt: new Date().toISOString(),
      fence: 0
    };
    // Fast path: atomically claim the lock path with a complete owner record.
    const outcome = tryClaimLock({ claim, lockPath, locksDir, canvasId });
    if (outcome.acquired) {
      return finaliseClaim({ claim, storeDir, lockPath, fencePath, canvasId });
    }
    // The lock is held: wait for a live owner, recover a provably dead one behind the recovery
    // marker, or fail closed.
    const recovery = handleHeldLock({
      claim,
      storeDir,
      lockPath,
      locksDir,
      canvasId,
      hostname,
      staleMs,
      deadline
    });
    if (recovery === 'claimed') {
      return finaliseClaim({ claim, storeDir, lockPath, fencePath, canvasId });
    }
  }
}

/**
 * Release a canvas lock, but only if the handle still owns it.
 *
 * Reads the current owner record and unlinks it only when token, pid and hostname all match the
 * handle. A release after ownership loss returns `false` and leaves the current owner's lock intact.
 * Idempotent and never throws.
 *
 * @param {object} handle handle returned by `acquireCanvasLock`
 * @returns {boolean} `true` when this call removed its own lock
 */
export function releaseCanvasLock(handle) {
  try {
    if (!isPlainObject(handle) || typeof handle.lockPath !== 'string' || handle.lockPath.length === 0) {
      return false;
    }
    const expectedCanvasId = typeof handle.canvasId === 'string' ? handle.canvasId : undefined;
    const owner = readOwnerRecord(handle.lockPath, expectedCanvasId);
    if (owner === null) {
      return false;
    }
    if (owner.token !== handle.token || owner.pid !== handle.pid || owner.hostname !== handle.hostname) {
      // Never unlink a lock that belongs to another owner.
      return false;
    }
    fs.unlinkSync(handle.lockPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Verify that a handle still describes the current owner and fence. Read-only.
 *
 * Used by the store immediately before and after the updater and immediately before the atomic
 * state write. A mismatch means the handle's lock generation is no longer current.
 *
 * @param {object} handle handle returned by `acquireCanvasLock`
 * @returns {{ok: true} | {ok: false, reason: string}} verification result; never throws
 */
export function verifyCanvasLock(handle) {
  try {
    if (
      !isPlainObject(handle) ||
      typeof handle.lockPath !== 'string' ||
      typeof handle.fencePath !== 'string' ||
      typeof handle.token !== 'string' ||
      !Number.isSafeInteger(handle.pid) ||
      typeof handle.hostname !== 'string' ||
      !Number.isSafeInteger(handle.fence) ||
      handle.fence < 0
    ) {
      return { ok: false, reason: 'LOCK_HANDLE_INVALID' };
    }
    const expectedCanvasId = typeof handle.canvasId === 'string' ? handle.canvasId : undefined;
    let owner;
    try {
      owner = readOwnerRecord(handle.lockPath, expectedCanvasId);
    } catch {
      return { ok: false, reason: 'LOCK_OWNER_MISMATCH' };
    }
    if (owner === null) {
      return { ok: false, reason: 'LOCK_MISSING' };
    }
    if (
      owner.token !== handle.token ||
      owner.pid !== handle.pid ||
      owner.hostname !== handle.hostname ||
      owner.fence !== handle.fence
    ) {
      return { ok: false, reason: 'LOCK_OWNER_MISMATCH' };
    }
    let fenceRecord;
    let fenceRaw;
    try {
      fenceRaw = readTextIfExists(handle.fencePath);
    } catch {
      return { ok: false, reason: 'LOCK_FENCE_MISMATCH' };
    }
    if (fenceRaw === null) {
      return { ok: false, reason: 'LOCK_MISSING' };
    }
    try {
      fenceRecord = JSON.parse(fenceRaw);
    } catch {
      return { ok: false, reason: 'LOCK_FENCE_MISMATCH' };
    }
    if (
      !isPlainObject(fenceRecord) ||
      fenceRecord.version !== FENCE_RECORD_VERSION ||
      !Number.isSafeInteger(fenceRecord.fence) ||
      fenceRecord.fence < 0
    ) {
      return { ok: false, reason: 'LOCK_FENCE_MISMATCH' };
    }
    if (fenceRecord.fence !== handle.fence) {
      return { ok: false, reason: 'LOCK_FENCE_MISMATCH' };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: 'LOCK_HANDLE_INVALID' };
  }
}

/**
 * Read-only diagnostics for the canvas lock and its recovery sidecars. Never mutates, recovers or
 * removes anything.
 *
 * @param {string} storeDir store root directory
 * @param {string} canvasId canvas id
 * @returns {{
 *   exists: boolean,
 *   owner?: object,
 *   alive?: boolean,
 *   fence?: number,
 *   unverifiable?: string,
 *   recoveryMarker: {exists: boolean, path: string, owner?: object, alive?: boolean, unverifiable?: string},
 *   recoveryGuard: {exists: boolean, path: string, owner?: object, alive?: boolean, unverifiable?: string}
 * }}
 *   `exists` is `false` when no lock file is present; `owner` is the validated owner record; `alive`
 *   is the same-host liveness result when it can be determined; `fence` is the current fence value;
 *   `unverifiable` explains fail-closed states (corrupt record, foreign host, unknown liveness).
 *   `recoveryMarker` / `recoveryGuard` are the read-only diagnostics of the two recovery sidecars
 *   (used by operators to decide on a manual cleanup when a recovery guard fails closed).
 */
export function inspectCanvasLock(storeDir, canvasId) {
  const hostname = os.hostname();
  const lockPath = canvasLockPath(storeDir, canvasId);
  const fencePath = canvasFencePath(storeDir, canvasId);
  const result = { exists: false };
  let raw = null;
  try {
    raw = readTextIfExists(lockPath);
  } catch {
    result.exists = true;
    result.unverifiable = 'LOCK_UNREADABLE';
  }
  if (raw !== null) {
    result.exists = true;
    let owner = null;
    try {
      owner = parseOwnerRecord(raw, canvasId);
    } catch {
      result.unverifiable = 'LOCK_OWNER_INVALID';
    }
    if (owner !== null) {
      result.owner = Object.freeze({ ...owner });
      result.fence = owner.fence;
      if (owner.hostname !== hostname) {
        result.unverifiable = 'FOREIGN_HOST';
      } else {
        const alive = isProcessAlive(owner.pid);
        if (alive === undefined) {
          result.unverifiable = 'LIVENESS_UNKNOWN';
        } else {
          result.alive = alive;
        }
      }
    }
  }
  try {
    const fenceRaw = readTextIfExists(fencePath);
    if (fenceRaw !== null) {
      const fenceRecord = JSON.parse(fenceRaw);
      if (
        isPlainObject(fenceRecord) &&
        fenceRecord.version === FENCE_RECORD_VERSION &&
        Number.isSafeInteger(fenceRecord.fence) &&
        fenceRecord.fence >= 0
      ) {
        result.fence = fenceRecord.fence;
      } else if (result.unverifiable === undefined) {
        result.unverifiable = 'LOCK_FENCE_INVALID';
      }
    }
  } catch {
    if (result.unverifiable === undefined) {
      result.unverifiable = 'LOCK_FENCE_UNREADABLE';
    }
  }
  result.recoveryMarker = inspectRecoveryMarker(storeDir, canvasId, hostname);
  result.recoveryGuard = inspectRecoveryGuard(storeDir, canvasId, hostname);
  return result;
}
