// Unit suite: file-backed store, atomic CAS-style updates, locking, corruption,
// path traversal rejection and no writes outside the store.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  STORE_VERSION,
  createFileCanvasStore,
  validateCanvasState,
} from '../../src/store/store.js';
import {
  acquireCanvasLock,
  releaseCanvasLock,
  verifyCanvasLock,
  inspectCanvasLock,
  canvasLockPath,
  canvasFencePath,
} from '../../src/store/lock.js';
import {
  canvasRecoveryMarkerPath,
  canvasRecoveryGuardPath,
} from '../../src/store/lock-internals.js';
import {
  FIXTURE_NOW,
  createLockFile,
  createTempDir,
  fixtureCanvasState,
  findTempFiles,
  getExitedProcessPid,
  initStore,
  listLocks,
  lockFilePath,
  makeCanvasState,
  makeNode,
  readCanvasFileRaw,
  readCanvasState,
  readFence,
  rmrf,
  walkDir,
  writeRawCanvasFile,
} from '../helpers/fixture-store.mjs';

const ERROR = {
  CANVAS_NOT_FOUND: 'CANVAS_CANVAS_NOT_FOUND',
  STORE_CORRUPT: 'CANVAS_STORE_CORRUPT',
  STORE_UNAVAILABLE: 'CANVAS_STORE_UNAVAILABLE',
  STORE_BUSY: 'CANVAS_STORE_BUSY',
  LOCK_UNVERIFIABLE: 'CANVAS_LOCK_UNVERIFIABLE',
  LOCK_OWNERSHIP_LOST: 'CANVAS_LOCK_OWNERSHIP_LOST',
  CANVAS_ID_INVALID: 'CANVAS_CANVAS_ID_INVALID',
  ARGUMENTS_INVALID: 'CANVAS_ARGUMENTS_INVALID',
};

function expectCode(action, expected, label) {
  const codes = Array.isArray(expected) ? expected : [expected];
  try {
    action();
  } catch (err) {
    assert.ok(codes.includes(err.code), `${label}: expected ${codes.join(' or ')}, got ${err.code || err.name}: ${err.message}`);
    return err;
  }
  assert.fail(`${label}: expected an error with code ${codes.join(' or ')}`);
}

function makeStore(root, options = {}) {
  const dir = path.join(root, 'store');
  fs.mkdirSync(dir, { recursive: true });
  const store = createFileCanvasStore({ dir, lockTimeoutMs: 500, staleLockMs: 500, ...options });
  store.init();
  return store;
}

function snapshotOutsideStore(root) {
  return walkDir(root)
    .filter((entry) => !entry.rel.startsWith('store'))
    .map((entry) => `${entry.isDir ? 'd' : 'f'}:${entry.rel}`)
    .sort();
}

describe('createFileCanvasStore: persistence', () => {
  let root;
  let store;

  before(() => {
    root = createTempDir('canvas-mcp-store-unit-');
    store = makeStore(root);
  });

  after(() => rmrf(root));

  test('exposes storeVersion 1 and the documented directory layout', () => {
    assert.equal(STORE_VERSION, 1);
    assert.equal(store.dir, path.resolve(store.dir));
    assert.equal(fs.existsSync(store.canvasesDir), true);
    assert.equal(fs.existsSync(store.locksDir), true);
    assert.equal(store.canvasFilePath('canvas-fixture-a'), path.join(store.canvasesDir, 'canvas-fixture-a.json'));
  });

  test('writeCanvas then readCanvas round-trips the exact state', () => {
    const state = fixtureCanvasState('canvas-fixture-a');
    store.writeCanvas('canvas-fixture-a', state);
    assert.deepEqual(store.readCanvas('canvas-fixture-a'), state);
    assert.equal(fs.existsSync(path.join(store.canvasesDir, 'canvas-fixture-a.json')), true);
    assert.deepEqual(store.listCanvasIds(), ['canvas-fixture-a']);
  });

  test('missing canvas is CANVAS_CANVAS_NOT_FOUND (never auto-created)', () => {
    expectCode(() => store.readCanvas('canvas-missing'), ERROR.CANVAS_NOT_FOUND, 'missing canvas');
    assert.equal(store.tryReadCanvas('canvas-missing'), null);
    assert.equal(fs.existsSync(path.join(store.canvasesDir, 'canvas-missing.json')), false);
  });

  test('unparseable or wrong-shape canvas files are CANVAS_STORE_CORRUPT and never reinitialized', () => {
    const corruptCases = [
      ['corrupt-json', '{ definitely not json'],
      ['corrupt-shape', '{"storeVersion": 1}'],
      ['corrupt-revision', JSON.stringify({ ...fixtureCanvasState('corrupt-revision'), revision: 'one' })],
      ['corrupt-nodes', JSON.stringify({ ...fixtureCanvasState('corrupt-nodes'), data: { nodes: 'nope', edges: [] } })],
    ];
    for (const [canvasId, raw] of corruptCases) {
      writeRawCanvasFile(store.canvasesDir.replace(/\/canvases$/, ''), canvasId, raw);
      expectCode(() => store.readCanvas(canvasId), ERROR.STORE_CORRUPT, canvasId);
      assert.equal(readCanvasFileRaw(path.dirname(store.canvasesDir), canvasId), raw, `${canvasId}: corrupt file must not be rewritten`);
    }
  });

  test('listCanvases skips corrupt files while listCanvasIds still sees the filename', () => {
    store.writeCanvas('canvas-fixture-b', fixtureCanvasState('canvas-fixture-b'));
    writeRawCanvasFile(path.dirname(store.canvasesDir), 'corrupt-listed', '{{{');
    const listed = store.listCanvases().map((state) => state.canvas.canvasId);
    assert.deepEqual(listed, ['canvas-fixture-a', 'canvas-fixture-b']);
    const ids = store.listCanvasIds();
    for (const expected of ['canvas-fixture-a', 'canvas-fixture-b', 'corrupt-listed']) {
      assert.ok(ids.includes(expected), `listCanvasIds must include ${expected}`);
    }
    assert.ok(!listed.includes('corrupt-listed'), 'listCanvases must skip corrupt files');
    assert.deepEqual(
      store.listCanvasStates().map((entry) => entry.canvasId),
      ['canvas-fixture-a', 'canvas-fixture-b'],
    );
  });

  test('validateCanvasState accepts the the documented contract fixture shape and rejects bad revisions', () => {
    const valid = makeCanvasState({
      canvasId: 'canvas-fixture-a',
      nodes: [makeNode('text', 'node-text-1', { data: { label: 'Fixture', content: 'hello' } })],
      edges: [],
    });
    assert.equal(validateCanvasState(valid, 'canvas-fixture-a'), valid);
    expectCode(() => validateCanvasState({ ...valid, revision: -1 }, 'canvas-fixture-a'), ERROR.STORE_CORRUPT, 'negative revision');
    expectCode(() => validateCanvasState({ ...valid, storeVersion: 2 }, 'canvas-fixture-a'), ERROR.STORE_CORRUPT, 'wrong storeVersion');
    expectCode(() => validateCanvasState({ ...valid, canvas: { ...valid.canvas, canvasId: 'other' } }, 'canvas-fixture-a'), ERROR.STORE_CORRUPT, 'wrong canvas id');
  });
});

describe('updateCanvas: atomic critical section', () => {
  let root;
  let store;

  before(() => {
    root = createTempDir('canvas-mcp-store-update-');
    store = makeStore(root);
    store.writeCanvas('canvas-fixture-a', fixtureCanvasState('canvas-fixture-a'));
  });

  after(() => rmrf(root));

  test('applies the updater, returns its value and persists nextState atomically', () => {
    const value = store.updateCanvas('canvas-fixture-a', (current) => ({
      value: current.revision,
      nextState: {
        ...current,
        revision: current.revision + 1,
        data: { ...current.data, nodes: [...current.data.nodes, makeNode('note', 'node-added', { data: { label: 'Added' } })] },
        updatedAt: FIXTURE_NOW,
      },
    }));
    assert.equal(value, 0);
    const state = store.readCanvas('canvas-fixture-a');
    assert.equal(state.revision, 1);
    assert.equal(state.data.nodes.length, 4);
    assert.deepEqual(findTempFiles(path.dirname(store.canvasesDir)), []);
    assert.deepEqual(listLocks(path.dirname(store.canvasesDir)), []);
  });

  test('persists nothing and releases the lock when the updater throws', () => {
    const before = store.readCanvas('canvas-fixture-a');
    assert.throws(
      () =>
        store.updateCanvas('canvas-fixture-a', () => {
          throw new Error('boom');
        }),
      /boom/,
    );
    const after = store.readCanvas('canvas-fixture-a');
    assert.deepEqual(after, before);
    assert.deepEqual(listLocks(path.dirname(store.canvasesDir)), []);
    assert.deepEqual(findTempFiles(path.dirname(store.canvasesDir)), []);
  });

  test('recovers a provably dead owner lock after the age gate and completes the update', async () => {
    // Safe protocol: an owner file whose pid is provably dead (ESRCH) may be recovered, but
    // only after the conservative file-age gate; age alone is never proof of death.
    const deadPid = await getExitedProcessPid();
    createLockFile(path.dirname(store.canvasesDir), 'canvas-fixture-a', {
      pid: deadPid,
      ageMs: 5000,
      writeFenceFile: false,
    });
    const storeWithStale = createFileCanvasStore({ dir: store.dir, lockTimeoutMs: 2000, staleLockMs: 200 });
    const result = storeWithStale.updateCanvas('canvas-fixture-a', (current) => ({
      value: 'updated',
      nextState: { ...current, revision: current.revision + 1 },
    }));
    assert.equal(result, 'updated');
    const state = store.readCanvas('canvas-fixture-a');
    assert.equal(state.revision, 2);
    assert.equal(state.lockFence, readFence(path.dirname(store.canvasesDir), 'canvas-fixture-a').fence);
    assert.deepEqual(listLocks(path.dirname(store.canvasesDir)), []);
  });

  test('a live owner yields CANVAS_STORE_BUSY, stays in place, and can be released', () => {
    // Fail-closed rule: a live owner is never preempted, regardless of file age.
    const busyStore = createFileCanvasStore({ dir: store.dir, lockTimeoutMs: 150, staleLockMs: 60000 });
    createLockFile(path.dirname(store.canvasesDir), 'canvas-fixture-a', {
      pid: process.pid,
      ageMs: 5000,
      writeFenceFile: false,
    });
    const revisionBefore = store.readCanvas('canvas-fixture-a').revision;
    expectCode(
      () => busyStore.updateCanvas('canvas-fixture-a', (current) => ({ value: null, nextState: current })),
      ERROR.STORE_BUSY,
      'live owner lock',
    );
    assert.equal(store.readCanvas('canvas-fixture-a').revision, revisionBefore);
    assert.equal(fs.existsSync(canvasLockPath(path.dirname(store.canvasesDir), 'canvas-fixture-a')), true);
    // A live owner's lock is only removable by a real release/takeover, never by the waiter.
    fs.unlinkSync(lockFilePath(path.dirname(store.canvasesDir), 'canvas-fixture-a'));
    assert.equal(store.updateCanvas('canvas-fixture-a', (current) => ({ value: current.revision })), revisionBefore);
  });
});

describe('path traversal and store isolation', () => {
  let root;
  let store;

  before(() => {
    root = createTempDir('canvas-mcp-store-traversal-');
    store = makeStore(root);
  });

  after(() => rmrf(root));

  test('rejects traversal-shaped canvas ids before any path join', () => {
    const outsideBefore = snapshotOutsideStore(root);
    for (const bad of ['../escape', '..', 'a/b', 'a\\b', '/etc/passwd', '.hidden', 'a..b', '']) {
      expectCode(() => store.readCanvas(bad), ERROR.CANVAS_ID_INVALID, `read ${bad}`);
      expectCode(() => store.writeCanvas(bad, fixtureCanvasState('x')), ERROR.CANVAS_ID_INVALID, `write ${bad}`);
      expectCode(() => store.updateCanvas(bad, () => null), ERROR.CANVAS_ID_INVALID, `update ${bad}`);
    }
    assert.deepEqual(snapshotOutsideStore(root), outsideBefore, 'no files may be created outside the store');
  });

  test('non-canvas files inside canvases/ are ignored by listing', () => {
    fs.writeFileSync(path.join(store.canvasesDir, 'notes.txt'), 'x', 'utf8');
    fs.writeFileSync(path.join(store.canvasesDir, '.hidden.json'), '{}', 'utf8');
    assert.deepEqual(store.listCanvasIds(), []);
  });
});

describe('store availability and lock primitives', () => {
  let root;

  before(() => {
    root = createTempDir('canvas-mcp-store-availability-');
  });

  after(() => rmrf(root));

  test('createFileCanvasStore rejects invalid configuration with stable codes', () => {
    expectCode(() => createFileCanvasStore({ dir: '' }), ERROR.STORE_UNAVAILABLE, 'empty dir');
    expectCode(() => createFileCanvasStore({ dir: root, lockTimeoutMs: -1 }), 'CANVAS_ARGUMENTS_INVALID', 'negative lock timeout');
    expectCode(() => createFileCanvasStore({ dir: root, staleLockMs: 1.5 }), 'CANVAS_ARGUMENTS_INVALID', 'fractional stale lock');
  });

  test('init() reports CANVAS_STORE_UNAVAILABLE for a missing or non-directory store', () => {
    const missing = createFileCanvasStore({ dir: path.join(root, 'missing-store') });
    expectCode(() => missing.init(), ERROR.STORE_UNAVAILABLE, 'missing store');
    const filePath = path.join(root, 'file-store');
    fs.writeFileSync(filePath, 'x', 'utf8');
    const notDir = createFileCanvasStore({ dir: filePath });
    expectCode(() => notDir.init(), ERROR.STORE_UNAVAILABLE, 'file store');
  });

  test('acquireCanvasLock/releaseCanvasLock are ownership-checked, idempotent and detect live owners', () => {
    const storeDir = path.join(root, 'lock-store');
    fs.mkdirSync(path.join(storeDir, '.locks'), { recursive: true });
    const handle = acquireCanvasLock({ storeDir, canvasId: 'canvas-fixture-a', timeoutMs: 0, staleMs: 60000 });
    assert.equal(fs.existsSync(canvasLockPath(storeDir, 'canvas-fixture-a')), true);
    assert.equal(Number.isSafeInteger(handle.fence) && handle.fence >= 1, true, 'handle must carry a real fence');
    assert.deepEqual(verifyCanvasLock(handle), { ok: true });
    const inspected = inspectCanvasLock(storeDir, 'canvas-fixture-a');
    assert.equal(inspected.exists, true);
    assert.equal(inspected.alive, true);
    assert.equal(inspected.owner.token, handle.token);
    expectCode(
      () => acquireCanvasLock({ storeDir, canvasId: 'canvas-fixture-a', timeoutMs: 50, staleMs: 60000 }),
      ERROR.STORE_BUSY,
      'second acquire while a live owner holds the lock',
    );
    assert.equal(releaseCanvasLock(handle), true);
    assert.equal(releaseCanvasLock(handle), false, 'release must be idempotent');
    assert.equal(fs.existsSync(canvasLockPath(storeDir, 'canvas-fixture-a')), false);
    assert.equal(fs.existsSync(canvasFencePath(storeDir, 'canvas-fixture-a')), true, 'fence counter must persist');
    // inspectCanvasLock additively reports the recovery sidecars and the persisted fence counter.
    const inspectedAfterRelease = inspectCanvasLock(storeDir, 'canvas-fixture-a');
    assert.equal(inspectedAfterRelease.exists, false, 'no lock owner file may exist after release');
    assert.equal(inspectedAfterRelease.owner, undefined);
    assert.equal(inspectedAfterRelease.fence, handle.fence, 'persisted fence counter stays visible for diagnostics');
    assert.deepEqual(inspectedAfterRelease.recoveryMarker, {
      exists: false,
      path: canvasRecoveryMarkerPath(storeDir, 'canvas-fixture-a'),
    });
    assert.deepEqual(inspectedAfterRelease.recoveryGuard, {
      exists: false,
      path: canvasRecoveryGuardPath(storeDir, 'canvas-fixture-a'),
    });
    assert.equal(releaseCanvasLock({ ...handle, token: 'forged-token' }), false, 'foreign handle must not release anything');
  });

  test('acquireCanvasLock recovers only provably dead owners past the age gate, fails closed on legacy locks, and validates options', async () => {
    // Negative/invalid options keep the frozen CANVAS_ARGUMENTS_INVALID contract.
    expectCode(
      () => acquireCanvasLock({ storeDir: path.join(root, 'lock-store-2'), canvasId: 'canvas-fixture-a', timeoutMs: -1 }),
      ERROR.ARGUMENTS_INVALID,
      'negative timeout',
    );
    expectCode(
      () => acquireCanvasLock({ storeDir: path.join(root, 'lock-store-2'), canvasId: 'canvas-fixture-a', timeoutMs: 10, staleMs: -1 }),
      ERROR.ARGUMENTS_INVALID,
      'negative staleMs',
    );

    // A legacy empty-directory lock (old unsafe format) is unverifiable and must never be taken over.
    const legacyStore = path.join(root, 'lock-store-3');
    fs.mkdirSync(path.join(legacyStore, '.locks'), { recursive: true });
    fs.mkdirSync(lockFilePath(legacyStore, 'canvas-fixture-a'));
    expectCode(
      () => acquireCanvasLock({ storeDir: legacyStore, canvasId: 'canvas-fixture-a', timeoutMs: 200, staleMs: 100 }),
      ERROR.LOCK_UNVERIFIABLE,
      'legacy empty-directory lock',
    );
    assert.equal(fs.statSync(lockFilePath(legacyStore, 'canvas-fixture-a')).isDirectory(), true, 'unverifiable lock must not be removed');
    rmrf(lockFilePath(legacyStore, 'canvas-fixture-a'));

    // A provably dead owner is recovered only once its owner file is older than staleMs.
    const deadStore = path.join(root, 'lock-store-4');
    fs.mkdirSync(path.join(deadStore, '.locks'), { recursive: true });
    const deadPid = await getExitedProcessPid();
    createLockFile(deadStore, 'canvas-fixture-a', { pid: deadPid, ageMs: 5000, fence: 1 });
    const handle = acquireCanvasLock({ storeDir: deadStore, canvasId: 'canvas-fixture-a', timeoutMs: 1000, staleMs: 100 });
    const record = JSON.parse(fs.readFileSync(lockFilePath(deadStore, 'canvas-fixture-a'), 'utf8'));
    assert.equal(record.pid, process.pid, 'recovered lock must be owned by the live acquirer');
    assert.equal(record.token, handle.token);
    assert.equal(record.fence, 2, 'recovery increments the monotonic fence exactly once');
    assert.equal(releaseCanvasLock(handle), true);
    assert.deepEqual(listLocks(deadStore), []);
  });
});
