/**
 * Internal primitives for the safe canvas lock.
 *
 * This module is **not** part of the public package surface: `src/index.js` must never re-export
 * anything from here. It is imported by `src/store/lock.js` and by tests that need to verify the
 * ownership-checked recovery-marker / recovery-guard semantics.
 *
 * Contents:
 * - shared low-level helpers (owner records, atomic complete-record claim, fsync'ed temp writes,
 *   same-host liveness, deadline sleeping) used by the write lock and the recovery sidecars;
 * - the **two-level recovery protocol**:
 *
 *   * Recovery MARKER (`<store>/.locks/.<canvasId>.recovery`) serialises stale write-lock recovery:
 *     only its current holder may remove a provably dead owner's lock record.
 *   * A marker itself can be left behind by a crashed recoverer and must be reclaimed. Reclaiming it
 *     by quarantine-rename from an unsynchronised reader is unsafe: two recoverers that both read the
 *     same dead marker can race, the second can move a *fresh live marker* created by the first, and
 *     its restore/unlink path can then delete that live marker, so both would believe they own
 *     recovery. The recovery GUARD (`<store>/.locks/.<canvasId>.recovery-guard`) closes this: a dead
 *     marker may only be quarantined while holding the guard, and the guard is **never auto-reclaimed**
 *     (dead/foreign/corrupt/ambiguous guard => fail closed `CANVAS_LOCK_UNVERIFIABLE` with a manual
 *     operator cleanup action). Live guard holders are never preempted; waiters sleep until the
 *     deadline (`CANVAS_STORE_BUSY`).
 *
 * All records are complete JSON owner records written with the same atomic claim primitive as the
 * write lock: write a unique temp file (mode 0600, fsync), `fs.linkSync` it to the final path and
 * unlink the temp file afterwards. A reader therefore only ever sees no record or a complete record,
 * and a crashed claim leaves a valid liveness-checkable record (never a half-written one).
 *
 * Node built-ins only: `node:fs`, `node:os`, `node:path`, `node:crypto`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { ERROR_CODES, canvasError } from '../errors.js';

/** Version of the JSON owner record written for the write lock, recovery marker and recovery guard. */
export const OWNER_RECORD_VERSION = 1;

const SLEEP_MIN_MS = 5;
const SLEEP_MAX_MS = 25;
/** Mirrors `CANVAS_ID_PATTERN` from `src/canvas/capabilities.js` so record paths cannot escape `.locks/`. */
const CANVAS_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** `fs.linkSync` error codes that mean hard links are unavailable on this filesystem. */
const HARD_LINK_UNAVAILABLE_CODES = new Set([
  'EMLINK',
  'ENOSYS',
  'ENOTSUP',
  'EOPNOTSUPP',
  'EPERM',
  'EXDEV'
]);
/** Temp prefix for atomically claiming the recovery marker. */
const RECOVERY_MARKER_CLAIM_PREFIX = '.marker-claim';
/** Temp prefix for quarantining a provably dead recovery marker (only while holding the guard). */
const RECOVERY_MARKER_QUARANTINE_PREFIX = '.marker-quarantine';
/** Temp prefix for atomically claiming the recovery guard. */
const RECOVERY_GUARD_CLAIM_PREFIX = '.guard-claim';
/** Action hint for the operator when a record must not be auto-reclaimed. */
const MANUAL_CLEANUP_ACTION = 'MANUAL_OPERATOR_CLEANUP_REQUIRED';

/** Build a fail-closed `CANVAS_LOCK_UNVERIFIABLE` error. */
export function lockUnverifiable(message, detail) {
  return canvasError(ERROR_CODES.LOCK_UNVERIFIABLE, message, detail);
}

/** Structural object check (kept local so this module is independent of the canvas domain). */
export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Blocking sleep with no async dependency. `Atomics.wait` on a private buffer is the portable way to
 * sleep synchronously in Node.
 *
 * @param {number} ms milliseconds to sleep (>= 0)
 */
export function sleepSync(ms) {
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, ms);
}

/**
 * Sleep until the acquire deadline, then throw `CANVAS_STORE_BUSY`.
 *
 * @param {number} deadline absolute epoch milliseconds
 * @throws {CanvasMcpError} `CANVAS_STORE_BUSY` once the deadline has elapsed
 */
export function sleepUntilDeadline(deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw canvasError(ERROR_CODES.STORE_BUSY, 'store is busy: canvas lock could not be acquired');
  }
  const jitter = SLEEP_MIN_MS + Math.floor(Math.random() * (SLEEP_MAX_MS - SLEEP_MIN_MS + 1));
  sleepSync(Math.min(jitter, remaining));
}

/** Validate a non-negative integer option. */
export function assertNonNegativeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw canvasError(ERROR_CODES.ARGUMENTS_INVALID, `${name} must be a non-negative integer`);
  }
}

/** Validate the store directory argument. */
export function assertStoreDirectory(storeDir) {
  if (typeof storeDir !== 'string' || storeDir.length === 0) {
    throw canvasError(ERROR_CODES.ARGUMENTS_INVALID, 'storeDir must be a non-empty string');
  }
}

/** Validate a canvas id before it is interpolated into a record path. */
export function assertLockCanvasId(canvasId) {
  if (typeof canvasId !== 'string' || !CANVAS_ID_PATTERN.test(canvasId)) {
    throw canvasError(ERROR_CODES.ARGUMENTS_INVALID, 'canvasId is invalid for a canvas lock');
  }
}

/** Validate a hostname argument. */
export function assertHostname(hostname) {
  if (typeof hostname !== 'string' || hostname.length === 0) {
    throw canvasError(ERROR_CODES.ARGUMENTS_INVALID, 'hostname must be a non-empty string');
  }
}

/**
 * Read a UTF-8 file, returning `null` when it does not exist. Other I/O errors are rethrown so the
 * caller can fail closed.
 *
 * @param {string} filePath absolute or relative path
 * @returns {string | null} file contents or `null`
 */
export function readTextIfExists(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

/**
 * Create a file exclusively, write it, fsync it and close it. On failure the partial file is removed
 * so a crashed/failed writer never leaves a half-written record.
 *
 * @param {string} filePath path to create (must not exist)
 * @param {string} contents UTF-8 contents
 */
export function writeFileDurable(filePath, contents) {
  const descriptor = fs.openSync(filePath, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, contents, 'utf8');
    fs.fsyncSync(descriptor);
  } catch (error) {
    try {
      fs.unlinkSync(filePath);
    } catch {
      // Best effort: the file will be ignored/reported by the owner-record parser.
    }
    throw error;
  } finally {
    try {
      fs.closeSync(descriptor);
    } catch {
      // Closing a descriptor that was already reported as failed must not mask the original error.
    }
  }
}

/**
 * Build a unique temp path inside the lock directory.
 *
 * @param {string} locksDir `<store>/.locks`
 * @param {string} prefix temp-file discriminator (e.g. `.claim`, `.marker-claim`)
 * @param {string} canvasId canvas id
 * @returns {string} unique temp path
 */
export function uniqueTempPath(locksDir, prefix, canvasId) {
  return path.join(
    locksDir,
    `${prefix}-${canvasId}-${process.pid}-${randomBytes(8).toString('hex')}.json`
  );
}

/**
 * Atomically replace a JSON file: write a unique temp file (fsync), then rename over the target.
 * Rename is atomic within one directory, so readers never observe a partial record.
 *
 * @param {string} targetPath file to replace
 * @param {object} value JSON-serialisable value
 * @param {string} canvasId canvas id (used for the temp file name)
 */
export function writeJsonAtomic(targetPath, value, canvasId) {
  const tempPath = uniqueTempPath(path.dirname(targetPath), '.claim', canvasId);
  try {
    writeFileDurable(tempPath, `${JSON.stringify(value)}\n`);
    fs.renameSync(tempPath, targetPath);
  } catch (error) {
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // Best effort cleanup; a stray claim temp file is ignored by every reader.
    }
    throw error;
  }
}

/**
 * Parse and validate an owner record. Throws `CANVAS_LOCK_UNVERIFIABLE` for corrupt records,
 * unknown record versions, missing fields and canvas mismatches; callers must never take over a
 * record that fails this validation.
 *
 * @param {string} raw raw file contents
 * @param {string} [canvasId] expected canvas id (when known)
 * @returns {{version: number, canvasId: string, token: string, pid: number, hostname: string, acquiredAt: string, fence: number}}
 */
export function parseOwnerRecord(raw, canvasId) {
  const detail = canvasId === undefined ? undefined : { canvasId };
  let record;
  try {
    record = JSON.parse(raw);
  } catch {
    throw lockUnverifiable('canvas owner record is not valid JSON', detail);
  }
  if (!isPlainObject(record)) {
    throw lockUnverifiable('canvas owner record is not an object', detail);
  }
  if (record.version !== OWNER_RECORD_VERSION) {
    throw lockUnverifiable('canvas owner record has an unsupported version', detail);
  }
  if (typeof record.canvasId !== 'string' || record.canvasId.length === 0) {
    throw lockUnverifiable('canvas owner record is missing canvasId', detail);
  }
  if (canvasId !== undefined && record.canvasId !== canvasId) {
    throw lockUnverifiable('canvas owner record belongs to another canvas', detail);
  }
  if (typeof record.token !== 'string' || record.token.length === 0) {
    throw lockUnverifiable('canvas owner record is missing ownership token', detail);
  }
  if (!Number.isSafeInteger(record.pid) || record.pid <= 0) {
    throw lockUnverifiable('canvas owner record has an invalid pid', detail);
  }
  if (typeof record.hostname !== 'string' || record.hostname.length === 0) {
    throw lockUnverifiable('canvas owner record is missing hostname', detail);
  }
  if (typeof record.acquiredAt !== 'string' || record.acquiredAt.length === 0) {
    throw lockUnverifiable('canvas owner record is missing acquiredAt', detail);
  }
  if (!Number.isSafeInteger(record.fence) || record.fence < 0) {
    throw lockUnverifiable('canvas owner record has an invalid fence', detail);
  }
  return record;
}

/**
 * Read and validate the owner record at a path.
 *
 * @param {string} recordPath record file path
 * @param {string} [canvasId] expected canvas id
 * @returns {object | null} validated record, or `null` when the record does not exist
 */
export function readOwnerRecord(recordPath, canvasId) {
  const raw = readTextIfExists(recordPath);
  if (raw === null) {
    return null;
  }
  return parseOwnerRecord(raw, canvasId);
}

/**
 * Same-host liveness check via `process.kill(pid, 0)`.
 *
 * @param {number} pid process id from an owner record
 * @returns {true | false | undefined} `true` alive (including `EPERM`), `false` provably dead
 *   (`ESRCH`), `undefined` when liveness cannot be determined (caller must fail closed)
 */
export function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = error && error.code;
    if (code === 'EPERM') {
      return true;
    }
    if (code === 'ESRCH') {
      return false;
    }
    return undefined;
  }
}

/**
 * Ensure `<store>/.locks` exists.
 *
 * @param {string} locksDir lock directory path
 * @throws {CanvasMcpError} `CANVAS_STORE_UNAVAILABLE` when it cannot be created
 */
function ensureLocksDirectory(locksDir) {
  try {
    fs.mkdirSync(locksDir, { recursive: true });
  } catch {
    throw canvasError(ERROR_CODES.STORE_UNAVAILABLE, 'unable to initialise the canvas lock directory');
  }
}

/**
 * Build a fresh complete owner record (`fence: 0` while claiming).
 *
 * @param {string} canvasId canvas id
 * @param {string} hostname owner hostname
 * @returns {{version: number, canvasId: string, token: string, pid: number, hostname: string, acquiredAt: string, fence: number}}
 */
function createOwnerRecord(canvasId, hostname) {
  return {
    version: OWNER_RECORD_VERSION,
    canvasId,
    token: randomUUID(),
    pid: process.pid,
    hostname,
    acquiredAt: new Date().toISOString(),
    fence: 0
  };
}

/**
 * Atomically claim a record path with a complete owner record: write the record to a unique temp file
 * (fsync), hard-link it to the record path, then unlink the temp file. `fs.linkSync` either creates
 * the record path atomically with complete contents or fails with `EEXIST`; a crash can never leave a
 * half-written record.
 *
 * @param {object} options
 * @param {string} options.recordPath final record path
 * @param {object} options.record complete owner record to claim with
 * @param {string} options.locksDir `<store>/.locks`
 * @param {string} options.tempPrefix temp-file discriminator for the claim temp file
 * @param {string} options.kind human-readable record kind for error messages (e.g. `canvas lock`)
 * @param {string} options.canvasId canvas id
 * @returns {{acquired: true} | {acquired: false}} `acquired:false` means another owner holds the path
 * @throws {CanvasMcpError} `CANVAS_LOCK_UNVERIFIABLE` on write/link failures (fail closed)
 */
export function tryClaimRecord({ recordPath, record, locksDir, tempPrefix, kind, canvasId }) {
  const claimPath = uniqueTempPath(locksDir, tempPrefix, canvasId);
  try {
    writeFileDurable(claimPath, `${JSON.stringify(record)}\n`);
  } catch (error) {
    throw lockUnverifiable(
      `${kind} claim file could not be written: ${error && error.code ? error.code : 'unknown error'}`,
      { canvasId }
    );
  }
  let linkError = null;
  try {
    fs.linkSync(claimPath, recordPath);
  } catch (error) {
    linkError = error;
  }
  try {
    fs.unlinkSync(claimPath);
  } catch {
    // The claim temp file is best-effort cleaned; readers only look at the record path.
  }
  if (linkError === null) {
    return { acquired: true };
  }
  const code = linkError && linkError.code;
  if (code === 'EEXIST') {
    return { acquired: false };
  }
  if (HARD_LINK_UNAVAILABLE_CODES.has(code)) {
    throw lockUnverifiable(`${kind} cannot be claimed: hard links are unavailable (${code})`, {
      canvasId
    });
  }
  throw lockUnverifiable(`${kind} cannot be claimed: ${code !== undefined ? code : 'unknown error'}`, {
    canvasId
  });
}

/**
 * Best-effort, ownership-checked removal of a record we claim to own. Unlinks only when the record
 * still matches our token/pid/hostname; never removes a foreign record and never throws.
 *
 * @param {string} recordPath record file path
 * @param {string} [canvasId] expected canvas id
 * @param {string} token ownership token
 * @param {number} pid process id
 * @param {string} hostname hostname
 * @returns {boolean} `true` when the owned record was removed
 */
export function removeOwnedRecord(recordPath, canvasId, token, pid, hostname) {
  try {
    const owner = readOwnerRecord(recordPath, canvasId);
    if (owner === null || owner.token !== token || owner.pid !== pid || owner.hostname !== hostname) {
      return false;
    }
    fs.unlinkSync(recordPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Build a sidecar record handle (recovery marker / recovery guard). Handles are frozen and carry the
 * full identity so release can be ownership-checked.
 *
 * @param {string} kind `recovery-marker` or `recovery-guard`
 * @param {string} recordPath record file path
 * @param {string} storeDir store root directory
 * @param {string} canvasId canvas id
 * @param {object} record claimed owner record
 * @returns {Readonly<object>} frozen record handle
 */
function createRecordHandle(kind, recordPath, storeDir, canvasId, record) {
  return Object.freeze({
    kind,
    recordPath,
    storeDir,
    canvasId,
    token: record.token,
    pid: record.pid,
    hostname: record.hostname,
    acquiredAt: record.acquiredAt
  });
}

/**
 * Path of the hidden per-canvas recovery marker. The marker is NOT the write lock: it serialises
 * stale-owner recovery for one canvas.
 *
 * @param {string} storeDir store root directory
 * @param {string} canvasId canvas id
 * @returns {string} `<store>/.locks/.<canvasId>.recovery`
 */
export function canvasRecoveryMarkerPath(storeDir, canvasId) {
  assertStoreDirectory(storeDir);
  assertLockCanvasId(canvasId);
  return path.join(storeDir, '.locks', `.${canvasId}.recovery`);
}

/**
 * Path of the hidden per-canvas recovery guard. The guard only serialises reclamation of a dead
 * recovery marker; it is never the write lock and is never auto-reclaimed.
 *
 * @param {string} storeDir store root directory
 * @param {string} canvasId canvas id
 * @returns {string} `<store>/.locks/.<canvasId>.recovery-guard`
 */
export function canvasRecoveryGuardPath(storeDir, canvasId) {
  assertStoreDirectory(storeDir);
  assertLockCanvasId(canvasId);
  return path.join(storeDir, '.locks', `.${canvasId}.recovery-guard`);
}

/**
 * Try to atomically claim the recovery marker. Never reclaims anything and never waits.
 *
 * @param {object} options
 * @param {string} options.storeDir store root directory
 * @param {string} options.canvasId canvas id
 * @param {string} [options.hostname=os.hostname()] hostname written to the marker record
 * @returns {{acquired: true, marker: Readonly<object>} | {acquired: false}}
 */
export function tryClaimRecoveryMarker({ storeDir, canvasId, hostname = os.hostname() }) {
  assertStoreDirectory(storeDir);
  assertLockCanvasId(canvasId);
  assertHostname(hostname);
  const recordPath = canvasRecoveryMarkerPath(storeDir, canvasId);
  const locksDir = path.dirname(recordPath);
  ensureLocksDirectory(locksDir);
  const record = createOwnerRecord(canvasId, hostname);
  const outcome = tryClaimRecord({
    recordPath,
    record,
    locksDir,
    tempPrefix: RECOVERY_MARKER_CLAIM_PREFIX,
    kind: 'canvas recovery marker',
    canvasId
  });
  if (!outcome.acquired) {
    return { acquired: false };
  }
  return { acquired: true, marker: createRecordHandle('recovery-marker', recordPath, storeDir, canvasId, record) };
}

/**
 * Ownership-checked release of a recovery-marker handle. Only unlinks when the marker record still
 * matches the handle's token/pid/hostname; never removes a foreign marker and never throws.
 *
 * @param {object | null} marker marker handle returned by `tryClaimRecoveryMarker`/`ensureRecoveryMarker`
 * @returns {boolean} `true` when this holder's marker was removed
 */
export function releaseRecoveryMarker(marker) {
  try {
    if (!isPlainObject(marker) || typeof marker.recordPath !== 'string') {
      return false;
    }
    const expectedCanvasId = typeof marker.canvasId === 'string' ? marker.canvasId : undefined;
    return removeOwnedRecord(marker.recordPath, expectedCanvasId, marker.token, marker.pid, marker.hostname);
  } catch {
    return false;
  }
}

/**
 * Try to atomically claim the recovery guard. Never reclaims anything and never waits.
 *
 * @param {object} options
 * @param {string} options.storeDir store root directory
 * @param {string} options.canvasId canvas id
 * @param {string} [options.hostname=os.hostname()] hostname written to the guard record
 * @returns {{acquired: true, guard: Readonly<object>} | {acquired: false}}
 */
export function tryClaimRecoveryGuard({ storeDir, canvasId, hostname = os.hostname() }) {
  assertStoreDirectory(storeDir);
  assertLockCanvasId(canvasId);
  assertHostname(hostname);
  const recordPath = canvasRecoveryGuardPath(storeDir, canvasId);
  const locksDir = path.dirname(recordPath);
  ensureLocksDirectory(locksDir);
  const record = createOwnerRecord(canvasId, hostname);
  const outcome = tryClaimRecord({
    recordPath,
    record,
    locksDir,
    tempPrefix: RECOVERY_GUARD_CLAIM_PREFIX,
    kind: 'canvas recovery guard',
    canvasId
  });
  if (!outcome.acquired) {
    return { acquired: false };
  }
  return { acquired: true, guard: createRecordHandle('recovery-guard', recordPath, storeDir, canvasId, record) };
}

/**
 * Ownership-checked release of a recovery-guard handle. Only unlinks when the guard record still
 * matches the handle's token/pid/hostname; never removes a foreign guard and never throws.
 *
 * @param {object | null} guard guard handle returned by `tryClaimRecoveryGuard`/`acquireRecoveryGuard`
 * @returns {boolean} `true` when this holder's guard was removed
 */
export function releaseRecoveryGuard(guard) {
  try {
    if (!isPlainObject(guard) || typeof guard.recordPath !== 'string') {
      return false;
    }
    const expectedCanvasId = typeof guard.canvasId === 'string' ? guard.canvasId : undefined;
    return removeOwnedRecord(guard.recordPath, expectedCanvasId, guard.token, guard.pid, guard.hostname);
  } catch {
    return false;
  }
}

/**
 * Build the fail-closed error for a recovery guard that must not be touched. The detail is
 * operator-actionable and does not leak absolute host paths: it names the sidecar file relative to
 * the store root and asks for manual cleanup.
 *
 * @param {string} canvasId canvas id
 * @param {string} reason short machine-readable reason
 * @param {string} message human readable explanation
 * @returns {CanvasMcpError} `CANVAS_LOCK_UNVERIFIABLE`
 */
function guardUnverifiable(canvasId, reason, message) {
  return lockUnverifiable(
    `${message} Automatic recovery-guard cleanup is disabled; manual operator cleanup of the file ` +
      `".locks/.${canvasId}.recovery-guard" is required (only when no canvas process is running).`,
    {
      canvasId,
      reason,
      action: MANUAL_CLEANUP_ACTION,
      recoveryGuardFile: `.locks/.${canvasId}.recovery-guard`
    }
  );
}

/**
 * Acquire the per-canvas recovery guard.
 *
 * A live guard holder is never preempted (wait until `deadline` => `CANVAS_STORE_BUSY`). A guard
 * record that is dead, on another host, corrupt or of ambiguous liveness is **never** moved or
 * removed: it fails closed with `CANVAS_LOCK_UNVERIFIABLE` and a manual-cleanup action, because
 * auto-reclaiming a guard would re-open the very reclaim race it exists to close.
 *
 * @param {object} options
 * @param {string} options.storeDir store root directory
 * @param {string} options.canvasId canvas id
 * @param {string} [options.hostname=os.hostname()] current hostname
 * @param {number} options.deadline absolute acquire deadline (epoch ms)
 * @returns {Readonly<object>} owned guard handle
 * @throws {CanvasMcpError} `CANVAS_STORE_BUSY` while a live guard holder keeps it past the deadline,
 *   `CANVAS_LOCK_UNVERIFIABLE` when the guard cannot be safely acquired (fail closed)
 */
export function acquireRecoveryGuard({ storeDir, canvasId, hostname = os.hostname(), deadline }) {
  assertStoreDirectory(storeDir);
  assertLockCanvasId(canvasId);
  assertHostname(hostname);
  assertNonNegativeInteger(deadline, 'deadline');
  const guardPath = canvasRecoveryGuardPath(storeDir, canvasId);
  for (;;) {
    const attempt = tryClaimRecoveryGuard({ storeDir, canvasId, hostname });
    if (attempt.acquired) {
      return attempt.guard;
    }
    let owner;
    try {
      owner = readOwnerRecord(guardPath, canvasId);
    } catch {
      throw guardUnverifiable(
        canvasId,
        'GUARD_RECORD_INVALID',
        'canvas recovery guard record is unverifiable.'
      );
    }
    if (owner === null) {
      // Released between the failed claim and this read: retry immediately.
      continue;
    }
    if (owner.hostname !== hostname) {
      throw guardUnverifiable(
        canvasId,
        'GUARD_FOREIGN_HOST',
        'canvas recovery guard is owned by another host; cross-host stores are unsupported.'
      );
    }
    const alive = isProcessAlive(owner.pid);
    if (alive === true) {
      // A live guard holder is never preempted; it only holds the guard briefly during recovery.
      sleepUntilDeadline(deadline);
      continue;
    }
    if (alive === undefined) {
      throw guardUnverifiable(
        canvasId,
        'GUARD_LIVENESS_UNKNOWN',
        'canvas recovery guard owner liveness cannot be determined.'
      );
    }
    throw guardUnverifiable(
      canvasId,
      'GUARD_OWNER_DEAD',
      'canvas recovery guard owner is dead (a recoverer crashed); refusing automatic cleanup.'
    );
  }
}

/**
 * Acquire the per-canvas recovery marker, reclaiming a provably dead marker safely.
 *
 * Fast path: atomically claim the marker. If the marker is held:
 * - a live/foreign/unverifiable marker is never touched (live => wait, others => fail closed);
 * - a provably dead marker past the age gate may only be reclaimed while holding the recovery guard.
 *   Under the guard the marker is re-read and must still be the SAME dead owner (token/pid/hostname/
 *   fence, `liveness === false`, age re-checked); it is then quarantine-renamed, the quarantined
 *   record is re-validated, and only that record is unlinked. The guard is always released in
 *   `finally`, after which the normal marker claim is retried.
 *
 * @param {object} options
 * @param {string} options.storeDir store root directory
 * @param {string} options.canvasId canvas id
 * @param {string} [options.hostname=os.hostname()] current hostname
 * @param {number} options.staleMs minimum marker-file age before a dead marker holder is reclaimed
 * @param {number} options.deadline absolute acquire deadline (epoch ms)
 * @returns {Readonly<object>} owned marker handle
 * @throws {CanvasMcpError} `CANVAS_STORE_BUSY` while a live marker holder keeps it past the deadline,
 *   `CANVAS_LOCK_UNVERIFIABLE` when the marker or guard cannot be validated safely (fail closed)
 */
export function ensureRecoveryMarker({
  storeDir,
  canvasId,
  hostname = os.hostname(),
  staleMs,
  deadline
}) {
  assertStoreDirectory(storeDir);
  assertLockCanvasId(canvasId);
  assertHostname(hostname);
  assertNonNegativeInteger(staleMs, 'staleMs');
  assertNonNegativeInteger(deadline, 'deadline');
  const markerPath = canvasRecoveryMarkerPath(storeDir, canvasId);
  const locksDir = path.dirname(markerPath);
  const detail = { canvasId };
  for (;;) {
    const attempt = tryClaimRecoveryMarker({ storeDir, canvasId, hostname });
    if (attempt.acquired) {
      return attempt.marker;
    }
    let markerOwner;
    try {
      markerOwner = readOwnerRecord(markerPath, canvasId);
    } catch {
      throw lockUnverifiable('canvas recovery marker is unverifiable', detail);
    }
    if (markerOwner === null) {
      // Released between the failed claim and this read: retry immediately.
      continue;
    }
    if (markerOwner.hostname !== hostname) {
      throw lockUnverifiable(
        'canvas recovery marker is owned by another host; cross-host stores are unsupported',
        detail
      );
    }
    const alive = isProcessAlive(markerOwner.pid);
    if (alive === undefined) {
      throw lockUnverifiable('canvas recovery marker liveness cannot be determined', detail);
    }
    if (alive) {
      // Live marker holder: it only holds the marker briefly during recovery; never preempt it.
      sleepUntilDeadline(deadline);
      continue;
    }
    let markerStats;
    try {
      markerStats = fs.statSync(markerPath);
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        continue;
      }
      throw lockUnverifiable('canvas recovery marker cannot be inspected', detail);
    }
    if (Date.now() - markerStats.mtimeMs < staleMs) {
      // Provably dead, but the conservative age gate has not elapsed yet.
      sleepUntilDeadline(deadline);
      continue;
    }
    // A dead marker may only be reclaimed by the recovery-guard holder. The guard is never
    // auto-reclaimed (see acquireRecoveryGuard), so at most one recoverer can touch this marker.
    const guard = acquireRecoveryGuard({ storeDir, canvasId, hostname, deadline });
    try {
      let currentOwner;
      try {
        currentOwner = readOwnerRecord(markerPath, canvasId);
      } catch {
        throw lockUnverifiable('canvas recovery marker is unverifiable', detail);
      }
      if (currentOwner === null) {
        // Another recoverer already removed it; release the guard and retry the normal claim.
        continue;
      }
      const sameDeadOwner =
        currentOwner.token === markerOwner.token &&
        currentOwner.pid === markerOwner.pid &&
        currentOwner.hostname === markerOwner.hostname &&
        currentOwner.fence === markerOwner.fence;
      if (!sameDeadOwner) {
        // The marker changed while we waited for the guard; never touch a replacement marker.
        continue;
      }
      const currentAlive = isProcessAlive(currentOwner.pid);
      if (currentAlive === undefined) {
        throw lockUnverifiable('canvas recovery marker liveness cannot be determined', detail);
      }
      if (currentAlive) {
        // The pid was reused by a live process: never preempt a live owner.
        continue;
      }
      let currentStats;
      try {
        currentStats = fs.statSync(markerPath);
      } catch (error) {
        if (error && error.code === 'ENOENT') {
          continue;
        }
        throw lockUnverifiable('canvas recovery marker cannot be inspected', detail);
      }
      if (Date.now() - currentStats.mtimeMs < staleMs) {
        // Do not sleep while holding the guard: release it and let the normal wait path re-check.
        continue;
      }
      // Holding the guard: quarantine the SAME dead record, re-validate the quarantined content and
      // unlink only that record. A fresh live marker created by a fast-path claimer after the rename
      // is never touched (we hold an inode we moved, not the path).
      const quarantinePath = uniqueTempPath(
        locksDir,
        RECOVERY_MARKER_QUARANTINE_PREFIX,
        canvasId
      );
      try {
        fs.renameSync(markerPath, quarantinePath);
      } catch (error) {
        if (error && error.code === 'ENOENT') {
          continue;
        }
        throw lockUnverifiable('canvas recovery marker could not be quarantined', detail);
      }
      let quarantinedRaw = null;
      try {
        quarantinedRaw = readTextIfExists(quarantinePath);
      } catch {
        quarantinedRaw = null;
      }
      let expectedDeadMarker = false;
      if (typeof quarantinedRaw === 'string') {
        try {
          const quarantined = parseOwnerRecord(quarantinedRaw, canvasId);
          expectedDeadMarker =
            quarantined.token === markerOwner.token &&
            quarantined.pid === markerOwner.pid &&
            quarantined.hostname === markerOwner.hostname &&
            quarantined.fence === markerOwner.fence &&
            isProcessAlive(quarantined.pid) === false;
        } catch {
          expectedDeadMarker = false;
        }
      }
      try {
        if (!expectedDeadMarker) {
          // Defence in depth for external tampering: restore the quarantined record when the marker
          // path is free instead of unlinking a record that may belong to a live process.
          try {
            fs.linkSync(quarantinePath, markerPath);
          } catch {
            // Marker path occupied again; the quarantined record is stale.
          }
        }
        fs.unlinkSync(quarantinePath);
      } catch {
        // Best-effort cleanup; no ownership decision depends on this unlink.
      }
      // Loop: release the guard in finally, then retry the normal atomic marker claim.
    } finally {
      releaseRecoveryGuard(guard);
    }
  }
}

/**
 * Read-only diagnostics for one recovery sidecar record (marker or guard). Never mutates, recovers or
 * removes anything.
 *
 * @param {string} recordPath sidecar record path
 * @param {string} canvasId canvas id
 * @param {string} hostname current hostname
 * @returns {{exists: boolean, path: string, owner?: object, alive?: boolean, unverifiable?: string}}
 */
function inspectRecoveryRecord(recordPath, canvasId, hostname) {
  const result = { exists: false, path: recordPath };
  let raw;
  try {
    raw = readTextIfExists(recordPath);
  } catch {
    return { exists: true, path: recordPath, unverifiable: 'RECORD_UNREADABLE' };
  }
  if (raw === null) {
    return result;
  }
  result.exists = true;
  let owner = null;
  try {
    owner = parseOwnerRecord(raw, canvasId);
  } catch {
    result.unverifiable = 'RECORD_INVALID';
  }
  if (owner !== null) {
    result.owner = Object.freeze({ ...owner });
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
  return result;
}

/**
 * Read-only diagnostics for the recovery marker.
 *
 * @param {string} storeDir store root directory
 * @param {string} canvasId canvas id
 * @param {string} [hostname=os.hostname()] current hostname
 * @returns {{exists: boolean, path: string, owner?: object, alive?: boolean, unverifiable?: string}}
 */
export function inspectRecoveryMarker(storeDir, canvasId, hostname = os.hostname()) {
  return inspectRecoveryRecord(canvasRecoveryMarkerPath(storeDir, canvasId), canvasId, hostname);
}

/**
 * Read-only diagnostics for the recovery guard.
 *
 * @param {string} storeDir store root directory
 * @param {string} canvasId canvas id
 * @param {string} [hostname=os.hostname()] current hostname
 * @returns {{exists: boolean, path: string, owner?: object, alive?: boolean, unverifiable?: string}}
 */
export function inspectRecoveryGuard(storeDir, canvasId, hostname = os.hostname()) {
  return inspectRecoveryRecord(canvasRecoveryGuardPath(storeDir, canvasId), canvasId, hostname);
}
