/**
 * File-backed canvas store.
 *
 * Layout:
 *   <store>/canvases/<canvasId>.json   one JSON state file per canvas (receipts included)
 *   <store>/.locks/<canvasId>.lock     JSON lock owner record (file, mode 0600)
 *   <store>/.locks/<canvasId>.fence    monotonic lock fence counter (file, mode 0600)
 *
 * Writes are a single fenced critical section: acquire the safe owner-file lock -> verify ownership
 * -> re-read authoritative state -> reject stale lock generations -> CAS/apply -> verify ownership
 * again immediately before the write -> write a temp file in the same directory, fsync it, then
 * rename over the target atomically. `state.lockFence` records the lock generation that committed the
 * last write, so a handle from an older generation cannot commit. The operation receipt lives in the
 * same state file, so receipt and state are committed together.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { ERROR_CODES, canvasError } from '../errors.js';
import { assertCanvasId, isPlainObject } from '../canvas/capabilities.js';
import {
  DEFAULT_LOCK_TIMEOUT_MS,
  DEFAULT_STALE_LOCK_MS,
  acquireCanvasLock,
  releaseCanvasLock,
  verifyCanvasLock
} from './lock.js';

export const STORE_VERSION = 1;
const CANVAS_FILE_PATTERN = /^([A-Za-z0-9][A-Za-z0-9._-]{0,63})\.json$/;

function corrupt(canvasId, reason) {
  return canvasError(ERROR_CODES.STORE_CORRUPT, `canvas store file is corrupt: ${reason}`, {
    canvasId
  });
}

/**
 * Build the stable `CANVAS_LOCK_OWNERSHIP_LOST` error used when a write is rejected because the
 * caller's lock generation is no longer current. No state is written on this path.
 *
 * @param {string} canvasId canvas id
 * @param {string} reason short non-secret verification reason
 */
function ownershipLost(canvasId, reason) {
  return canvasError(
    ERROR_CODES.LOCK_OWNERSHIP_LOST,
    'canvas lock ownership was lost; no canvas state was written',
    { canvasId, reason }
  );
}


function isNonNegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function assertNodeShape(node) {
  if (!isPlainObject(node)) {
    return false;
  }
  if (typeof node.id !== 'string' || typeof node.type !== 'string') {
    return false;
  }
  if (!isPlainObject(node.position)) {
    return false;
  }
  if (typeof node.position.x !== 'number' || typeof node.position.y !== 'number') {
    return false;
  }
  return isPlainObject(node.data);
}

function assertEdgeShape(edge) {
  if (!isPlainObject(edge)) {
    return false;
  }
  return (
    typeof edge.id === 'string' &&
    typeof edge.source === 'string' &&
    typeof edge.target === 'string' &&
    typeof edge.relation === 'string'
  );
}

/**
 * Validate the persisted canvas state shape. Throws `CANVAS_STORE_CORRUPT` on mismatch.
 * Deliberately structural (not a full domain replay): readable fixtures are accepted but
 * obviously broken files are reported instead of silently re-initialised.
 *
 * `lockFence` is an optional additive field (lock generation that committed the last write); when
 * present it must be a non-negative safe integer.
 *
 * @param {unknown} state parsed JSON
 * @param {string} canvasId expected canvas id
 * @returns {object}
 */
export function validateCanvasState(state, canvasId) {
  if (!isPlainObject(state)) {
    throw corrupt(canvasId, 'state is not an object');
  }
  if (state.storeVersion !== STORE_VERSION) {
    throw corrupt(canvasId, 'unsupported storeVersion');
  }
  if (!isPlainObject(state.canvas) || state.canvas.canvasId !== canvasId) {
    throw corrupt(canvasId, 'canvas metadata is missing or belongs to another canvas');
  }
  if (typeof state.canvas.name !== 'string' || typeof state.canvas.createdAt !== 'string') {
    throw corrupt(canvasId, 'canvas metadata is incomplete');
  }
  if (!isNonNegativeSafeInteger(state.revision)) {
    throw corrupt(canvasId, 'revision must be a non-negative safe integer');
  }
  if (state.lockFence !== undefined && !isNonNegativeSafeInteger(state.lockFence)) {
    throw corrupt(canvasId, 'lockFence must be a non-negative safe integer when present');
  }
  if (!isPlainObject(state.data) || !Array.isArray(state.data.nodes) || !Array.isArray(state.data.edges)) {
    throw corrupt(canvasId, 'data.nodes and data.edges must be arrays');
  }
  if (!state.data.nodes.every(assertNodeShape)) {
    throw corrupt(canvasId, 'data.nodes contains an invalid node');
  }
  if (!state.data.edges.every(assertEdgeShape)) {
    throw corrupt(canvasId, 'data.edges contains an invalid edge');
  }
  if (
    !isPlainObject(state.tombstones) ||
    !Array.isArray(state.tombstones.nodes) ||
    !Array.isArray(state.tombstones.edges)
  ) {
    throw corrupt(canvasId, 'tombstones must contain nodes and edges arrays');
  }
  if (!isPlainObject(state.receipts)) {
    throw corrupt(canvasId, 'receipts must be an object');
  }
  for (const key of Object.keys(state.receipts)) {
    if (!isPlainObject(state.receipts[key])) {
      throw corrupt(canvasId, 'receipts contains an invalid receipt');
    }
  }
  if (typeof state.updatedAt !== 'string') {
    throw corrupt(canvasId, 'updatedAt must be a string');
  }
  return state;
}

function writeStateAtomic(canvasesDir, canvasId, state) {
  const targetPath = path.join(canvasesDir, `${canvasId}.json`);
  const tempPath = path.join(
    canvasesDir,
    `.tmp-${process.pid}-${randomBytes(8).toString('hex')}-${canvasId}.json`
  );
  const serialised = `${JSON.stringify(state, null, 2)}\n`;
  let fileDescriptor;
  try {
    fileDescriptor = fs.openSync(tempPath, 'wx', 0o600);
    fs.writeFileSync(fileDescriptor, serialised, 'utf8');
    fs.fsyncSync(fileDescriptor);
    fs.closeSync(fileDescriptor);
    fileDescriptor = undefined;
    fs.renameSync(tempPath, targetPath);
  } catch (error) {
    if (fileDescriptor !== undefined) {
      try {
        fs.closeSync(fileDescriptor);
      } catch {
        // ignore close errors while cleaning up
      }
    }
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // best-effort cleanup; the temp file is ignored by the store if it survives
    }
    throw canvasError(
      ERROR_CODES.STORE_UNAVAILABLE,
      `unable to persist canvas state: ${error.code ?? 'unknown error'}`
    );
  }
}

/**
 * Create a file-backed canvas store.
 *
 * @param {object} options
 * @param {string} options.dir store directory (must already exist; subdirectories are created by `init`)
 * @param {number} [options.lockTimeoutMs=5000]
 * @param {number} [options.staleLockMs=10000]
 */
export function createFileCanvasStore({
  dir,
  lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
  staleLockMs = DEFAULT_STALE_LOCK_MS
} = {}) {
  if (typeof dir !== 'string' || dir.length === 0) {
    throw canvasError(ERROR_CODES.STORE_UNAVAILABLE, 'store directory is required');
  }
  if (!Number.isSafeInteger(lockTimeoutMs) || lockTimeoutMs < 0) {
    throw canvasError(ERROR_CODES.ARGUMENTS_INVALID, 'lockTimeoutMs must be a non-negative integer');
  }
  if (!Number.isSafeInteger(staleLockMs) || staleLockMs < 0) {
    throw canvasError(ERROR_CODES.ARGUMENTS_INVALID, 'staleLockMs must be a non-negative integer');
  }
  const storeDir = path.resolve(dir);
  const canvasesDir = path.join(storeDir, 'canvases');
  const locksDir = path.join(storeDir, '.locks');

  function ensureStoreDirectory() {
    let stats;
    try {
      stats = fs.statSync(storeDir);
    } catch {
      throw canvasError(ERROR_CODES.STORE_UNAVAILABLE, 'store directory is unavailable');
    }
    if (!stats.isDirectory()) {
      throw canvasError(ERROR_CODES.STORE_UNAVAILABLE, 'store path is not a directory');
    }
  }

  function init() {
    ensureStoreDirectory();
    try {
      fs.mkdirSync(canvasesDir, { recursive: true });
      fs.mkdirSync(locksDir, { recursive: true });
    } catch {
      throw canvasError(ERROR_CODES.STORE_UNAVAILABLE, 'unable to initialise store directories');
    }
  }

  function canvasFilePath(canvasId) {
    assertCanvasId(canvasId);
    return path.join(canvasesDir, `${canvasId}.json`);
  }

  function readCanvas(canvasId) {
    const filePath = canvasFilePath(canvasId);
    let text;
    try {
      text = fs.readFileSync(filePath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw canvasError(ERROR_CODES.CANVAS_NOT_FOUND, `canvas "${canvasId}" was not found`, {
          canvasId
        });
      }
      throw canvasError(ERROR_CODES.STORE_UNAVAILABLE, 'unable to read canvas state', { canvasId });
    }
    let state;
    try {
      state = JSON.parse(text);
    } catch {
      throw corrupt(canvasId, 'invalid JSON');
    }
    return validateCanvasState(state, canvasId);
  }

  function tryReadCanvas(canvasId) {
    assertCanvasId(canvasId);
    try {
      return readCanvas(canvasId);
    } catch (error) {
      if (error instanceof Error && error.code === ERROR_CODES.CANVAS_NOT_FOUND) {
        return null;
      }
      throw error;
    }
  }

  function listCanvasIds() {
    let entries;
    try {
      entries = fs.readdirSync(canvasesDir, { withFileTypes: true });
    } catch {
      return [];
    }
    const ids = [];
    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }
      const match = CANVAS_FILE_PATTERN.exec(entry.name);
      if (!match) {
        continue;
      }
      ids.push(match[1]);
    }
    ids.sort();
    return ids;
  }

  /**
   * Read every readable canvas. Malformed canvas files are skipped here; reading the
   * canvas directly still reports `CANVAS_STORE_CORRUPT`.
   *
   * @returns {object[]} canvas state objects
   */
  function listCanvases() {
    const states = [];
    for (const canvasId of listCanvasIds()) {
      try {
        states.push(readCanvas(canvasId));
      } catch {
        // Skip unreadable/corrupt files during listing.
      }
    }
    return states;
  }

  /** Alias returning both id and state, useful for diagnostics. */
  function listCanvasStates() {
    return listCanvases().map((state) => ({ canvasId: state.canvas.canvasId, state }));
  }

  /**
   * Acquire the safe owner-file lock for a canvas using the store's timeout/stale settings.
   *
   * Exposed for embedding/tests so a handle can be passed back through
   * `updateCanvas(canvasId, updater, {lockHandle})`.
   *
   * @param {string} canvasId canvas id
   * @param {object} [options]
   * @param {number} [options.timeoutMs] override the store lock timeout
   * @param {number} [options.staleMs] override the store stale-lock age gate
   * @returns {Readonly<object>} frozen lock handle
   */
  function acquireHandleForCanvas(canvasId, options = {}) {
    assertCanvasId(canvasId);
    ensureStoreDirectory();
    const timeoutMs = options?.timeoutMs ?? lockTimeoutMs;
    const staleMs = options?.staleMs ?? staleLockMs;
    return acquireCanvasLock({ storeDir, canvasId, timeoutMs, staleMs });
  }

  /**
   * Verify that a handle still owns the current lock generation, throwing
   * `CANVAS_LOCK_OWNERSHIP_LOST` when it does not. No state is written on this path.
   *
   * @param {object} handle lock handle
   * @param {string} canvasId canvas id
   */
  function assertLockOwnership(handle, canvasId) {
    const verification = verifyCanvasLock(handle);
    if (verification.ok !== true) {
      throw ownershipLost(canvasId, verification.reason ?? 'LOCK_OWNER_MISMATCH');
    }
  }

  /**
   * Reject a handle whose fence is older than the persisted `state.lockFence`.
   *
   * @param {object} state persisted (or about to be persisted) canvas state
   * @param {object} handle lock handle
   * @param {string} canvasId canvas id
   */
  function assertFenceNotStale(state, handle, canvasId) {
    const committedFence = state.lockFence ?? 0;
    if (Number.isSafeInteger(committedFence) && committedFence > handle.fence) {
      throw ownershipLost(canvasId, 'LOCK_FENCE_STALE');
    }
  }

  /**
   * Run `updater` while holding the canvas lock.
   *
   * `updater(currentState)` returns `{value, nextState}`; when `nextState` is provided it is
   * validated, stamped with the handle's fence and persisted atomically before the lock is released.
   * Lock ownership is verified before the updater, after it and immediately before the atomic write;
   * a handle from an older generation is rejected with `CANVAS_LOCK_OWNERSHIP_LOST` (no write).
   *
   * @param {string} canvasId canvas id
   * @param {(current: object) => {value?: unknown, nextState?: object} | null | undefined} updater
   * @param {object} [options]
   * @param {object} [options.lockHandle] advanced/testing only: use an existing lock handle instead
   *   of acquiring/releasing one; the caller remains responsible for releasing it.
   * @returns {unknown} the updater's `value`
   */
  function updateCanvas(canvasId, updater, options = {}) {
    assertCanvasId(canvasId);
    if (typeof updater !== 'function') {
      throw new TypeError('updateCanvas requires an updater function');
    }
    if (options === null || typeof options !== 'object') {
      throw canvasError(ERROR_CODES.ARGUMENTS_INVALID, 'updateCanvas options must be an object');
    }
    ensureStoreDirectory();
    const providedHandle = options.lockHandle;
    const ownsLock = providedHandle === undefined;
    const handle = ownsLock ? acquireHandleForCanvas(canvasId) : providedHandle;
    try {
      assertLockOwnership(handle, canvasId);
      const current = readCanvas(canvasId);
      assertFenceNotStale(current, handle, canvasId);
      const outcome = updater(current);
      if (outcome !== null && typeof outcome === 'object' && outcome.nextState !== undefined) {
        if (!isPlainObject(outcome.nextState)) {
          // Preserve the original structural error for a non-object nextState.
          validateCanvasState(outcome.nextState, canvasId);
        }
        const nextState = { ...outcome.nextState, lockFence: handle.fence };
        validateCanvasState(nextState, canvasId);
        // Final ownership check immediately before the atomic state write.
        assertLockOwnership(handle, canvasId);
        writeStateAtomic(canvasesDir, canvasId, nextState);
      }
      return outcome === null || typeof outcome !== 'object' ? undefined : outcome.value;
    } finally {
      if (ownsLock) {
        try {
          releaseCanvasLock(handle);
        } catch {
          // releasing must never mask the original outcome
        }
      }
    }
  }

  /**
   * Atomically persist a full canvas state while holding the lock (fixtures/administration).
   *
   * The caller-supplied state is persisted verbatim (no fields are added), but the write takes the
   * safe lock, verifies ownership around the write and rejects a generation older than the persisted
   * `lockFence`.
   *
   * @param {string} canvasId canvas id
   * @param {object} state complete canvas state
   */
  function writeCanvas(canvasId, state) {
    assertCanvasId(canvasId);
    ensureStoreDirectory();
    validateCanvasState(state, canvasId);
    const handle = acquireHandleForCanvas(canvasId);
    try {
      assertLockOwnership(handle, canvasId);
      const existing = tryReadCanvas(canvasId);
      if (existing !== null) {
        assertFenceNotStale(existing, handle, canvasId);
      }
      assertFenceNotStale(state, handle, canvasId);
      // Final ownership check immediately before the atomic state write.
      assertLockOwnership(handle, canvasId);
      writeStateAtomic(canvasesDir, canvasId, state);
    } finally {
      try {
        releaseCanvasLock(handle);
      } catch {
        // releasing must never mask the original outcome
      }
    }
  }

  return Object.freeze({
    dir: storeDir,
    canvasesDir,
    locksDir,
    lockTimeoutMs,
    staleLockMs,
    init,
    readCanvas,
    tryReadCanvas,
    listCanvases,
    listCanvasStates,
    listCanvasIds,
    updateCanvas,
    writeCanvas,
    acquireCanvasLock: (canvasId, options) => acquireHandleForCanvas(canvasId, options),
    releaseCanvasLock: (handle) => releaseCanvasLock(handle),
    verifyCanvasLock: (handle) => verifyCanvasLock(handle),
    canvasFilePath: (canvasId) => canvasFilePath(canvasId)
  });
}
