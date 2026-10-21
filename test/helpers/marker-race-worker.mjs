/**
 * Test helper: a real OS child process exercising the recovery-marker / recovery-guard protocol.
 *
 * Every mode imports the REAL production modules (`src/store/lock.js`,
 * `src/store/lock-internals.js`, `src/store/store.js`) and operates on a real file store. There is
 * no mock of the lock/guard/marker safety core. Before importing the modules, this worker wraps
 * three `node:fs` sync primitives to journal every marker/guard/lock operation into the shared
 * NDJSON journal, which lets the parent prove (for example) that a blocked delayed recoverer
 * performed zero marker renames.
 *
 * Modes (spec JSON passed with --spec):
 *   read-marker-then-ensure  read the (dead) marker record, signal ready, wait for the parent's go
 *                            barrier, then call the real ensureRecoveryMarker (delayed recoverer).
 *   ensure-hold              ensureRecoveryMarker, signal held, hold the marker until released.
 *   acquire-hold             acquireCanvasLock, signal acquired, hold until released.
 *   acquire-once             one acquireCanvasLock attempt, report success or stable error code.
 *   store-recover-write      store.acquireCanvasLock + real store.updateCanvas({lockHandle}) + release.
 *   store-recover-write-hold like store-recover-write, but waits for a write barrier while holding
 *                            the lock (deterministic contention windows).
 *   release-handle           releaseRecoveryMarker(spec.handle) / releaseRecoveryGuard(spec.handle).
 *   claim-marker-once        tryClaimRecoveryMarker; report acquired + record; release if released.
 *   claim-guard-hold         acquireRecoveryGuard, signal held, hold until released.
 *   crash-marker-holder      ensureRecoveryMarker then signal ready and sleep (parent SIGKILLs).
 *   crash-guard-holder       acquireRecoveryGuard then signal ready and sleep (parent SIGKILLs).
 *   guard-probe              acquireRecoveryGuard with a short deadline; report stable code/detail.
 *
 * Barrier protocol: files inside `barrierDir`. The worker creates `ready*` markers and waits for
 * `go*` / `release*` files; the parent only ever synchronises through files (no sleeps decide order).
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--spec') out.spec = argv[++i];
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  return out;
}

const { spec: specPath } = parseArgs(process.argv.slice(2));
const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
const { role, mode, storeDir, canvasId, journalPath, barrierDir, resultPath } = spec;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function barrier(name) {
  return path.join(barrierDir, name);
}

function sleepSync(ms) {
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, ms);
}

function journal(event, extra = {}) {
  const t = Date.now();
  fs.appendFileSync(
    journalPath,
    `${JSON.stringify({ t, iso: new Date(t).toISOString(), pid: process.pid, role, mode, event, ...extra })}\n`,
  );
}

function writeResult(result) {
  fs.writeFileSync(resultPath, `${JSON.stringify({ role, mode, pid: process.pid, ...result })}\n`, 'utf8');
}

function mark(name) {
  fs.writeFileSync(barrier(name), '1');
}

function waitForBarrier(name, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(barrier(name))) return true;
    sleepSync(2);
  }
  throw new Error(`worker ${role}/${mode}: timed out waiting for barrier ${name}`);
}

// --- fs operation journal (installed before the production modules are imported) ---------------
const lockPath = path.join(storeDir, '.locks', `${canvasId}.lock`);
const markerPath = path.join(storeDir, '.locks', `.${canvasId}.recovery`);
const guardPath = path.join(storeDir, '.locks', `.${canvasId}.recovery-guard`);

function isInterestingPath(filePath) {
  const text = String(filePath);
  return (
    text === lockPath ||
    text === markerPath ||
    text === guardPath ||
    text.includes(`.${canvasId}.recovery-quarantine`) ||
    text.includes(`.marker-quarantine`) ||
    text.includes(`.guard-claim`)
  );
}

const originalFs = {
  renameSync: fs.renameSync,
  linkSync: fs.linkSync,
  unlinkSync: fs.unlinkSync,
};

fs.renameSync = (src, dst) => {
  if (isInterestingPath(src) || isInterestingPath(dst)) {
    journal('fs-rename', { src: String(src), dst: String(dst) });
  }
  return originalFs.renameSync(src, dst);
};
fs.linkSync = (src, dst) => {
  if (isInterestingPath(src) || isInterestingPath(dst)) {
    journal('fs-link', { src: String(src), dst: String(dst) });
  }
  return originalFs.linkSync(src, dst);
};
fs.unlinkSync = (target) => {
  if (isInterestingPath(target)) {
    journal('fs-unlink', { target: String(target) });
  }
  return originalFs.unlinkSync(target);
};

const internals = await import(pathToFileURL(path.join(REPO_ROOT, 'src', 'store', 'lock-internals.js')).href);
const lock = await import(pathToFileURL(path.join(REPO_ROOT, 'src', 'store', 'lock.js')).href);
const storeModule = await import(pathToFileURL(path.join(REPO_ROOT, 'src', 'store', 'store.js')).href);

function makeNode(nodeId) {
  return { id: nodeId, type: 'note', position: { x: 0, y: 0 }, data: { nodeType: 'note', label: `note node ${nodeId}` } };
}

function openStore() {
  const store = storeModule.createFileCanvasStore({
    dir: storeDir,
    lockTimeoutMs: spec.lockTimeoutMs ?? 5000,
    staleLockMs: spec.staleLockMs ?? 150,
  });
  store.init();
  return store;
}

function appendNode(current, nodeId) {
  return {
    ...current,
    revision: current.revision + 1,
    data: { ...current.data, nodes: [...current.data.nodes, makeNode(nodeId)] },
    updatedAt: new Date().toISOString(),
  };
}

function describeError(error) {
  return {
    code: error?.code ?? null,
    message: error?.message ?? String(error),
    detail: error?.detail ?? null,
  };
}

function markerHandleFromSpec() {
  return {
    kind: 'recovery-marker',
    recordPath: markerPath,
    storeDir,
    canvasId,
    token: spec.handle.token,
    pid: spec.handle.pid,
    hostname: spec.handle.hostname,
  };
}

function guardHandleFromSpec() {
  return {
    kind: 'recovery-guard',
    recordPath: guardPath,
    storeDir,
    canvasId,
    token: spec.handle.token,
    pid: spec.handle.pid,
    hostname: spec.handle.hostname,
  };
}

async function run() {
  journal('start', { timeoutMs: spec.timeoutMs ?? null, staleMs: spec.staleMs ?? null });

  if (mode === 'read-marker-then-ensure') {
    const raw = internals.readOwnerRecord(markerPath, canvasId);
    journal('marker-read', { marker: raw ? { token: raw.token, pid: raw.pid, fence: raw.fence } : null });
    mark(spec.readyName ?? 'ready-delayed');
    waitForBarrier(spec.goName ?? 'go-delayed', 120_000);
    journal('resumed');
    try {
      const marker = internals.ensureRecoveryMarker({
        storeDir,
        canvasId,
        staleMs: spec.staleMs ?? 100,
        deadline: Date.now() + (spec.timeoutMs ?? 1000),
      });
      journal('marker-acquired', { token: marker.token, pid: marker.pid, recordPath: marker.recordPath });
      if (spec.releaseName) waitForBarrier(spec.releaseName, 120_000);
      const released = internals.releaseRecoveryMarker(marker);
      writeResult({ ok: true, marker: { token: marker.token, pid: marker.pid }, released });
    } catch (error) {
      journal('ensure-failed', describeError(error));
      writeResult({ ok: false, ...describeError(error) });
    }
    return;
  }

  if (mode === 'ensure-hold') {
    try {
      const marker = internals.ensureRecoveryMarker({
        storeDir,
        canvasId,
        staleMs: spec.staleMs ?? 100,
        deadline: Date.now() + (spec.timeoutMs ?? 5000),
      });
      journal('marker-acquired', { token: marker.token, pid: marker.pid });
      mark(spec.readyName ?? 'ready-marker-held');
      waitForBarrier(spec.releaseName ?? 'go-release-marker', 120_000);
      const released = internals.releaseRecoveryMarker(marker);
      journal('marker-released', { released });
      writeResult({ ok: true, token: marker.token, released });
    } catch (error) {
      journal('ensure-failed', describeError(error));
      writeResult({ ok: false, ...describeError(error) });
    }
    return;
  }

  if (mode === 'acquire-hold') {
    try {
      const handle = lock.acquireCanvasLock({
        storeDir,
        canvasId,
        timeoutMs: spec.timeoutMs ?? 5000,
        staleMs: spec.staleMs ?? 100,
      });
      journal('acquired', { fence: handle.fence, token: handle.token });
      const lockRaw = fs.readFileSync(lockPath, 'utf8');
      journal('lock-record-observed', { raw: lockRaw });
      mark(spec.readyName ?? 'ready-acquired');
      waitForBarrier(spec.releaseName ?? 'go-release-acquired', 120_000);
      const released = lock.releaseCanvasLock(handle);
      journal('released', { released });
      writeResult({ ok: true, fence: handle.fence, released });
    } catch (error) {
      journal('acquire-failed', describeError(error));
      writeResult({ ok: false, ...describeError(error) });
    }
    return;
  }

  if (mode === 'acquire-once') {
    try {
      const handle = lock.acquireCanvasLock({
        storeDir,
        canvasId,
        timeoutMs: spec.timeoutMs ?? 1000,
        staleMs: spec.staleMs ?? 100,
      });
      journal('acquired', { fence: handle.fence, token: handle.token });
      const released = lock.releaseCanvasLock(handle);
      writeResult({ ok: true, fence: handle.fence, released });
    } catch (error) {
      journal('acquire-failed', describeError(error));
      writeResult({ ok: false, ...describeError(error) });
    }
    return;
  }

  if (mode === 'store-recover-write' || mode === 'store-recover-write-hold') {
    const store = openStore();
    try {
      const handle = store.acquireCanvasLock(canvasId, {
        timeoutMs: spec.timeoutMs ?? 5000,
        staleMs: spec.staleMs ?? 100,
      });
      journal('acquired', { fence: handle.fence, token: handle.token });
      mark(spec.readyName ?? 'ready-writer');
      if (mode === 'store-recover-write-hold') {
        waitForBarrier(spec.writeName ?? 'go-write', 120_000);
      }
      journal('cs-enter');
      const value = store.updateCanvas(
        canvasId,
        (current) => ({ value: current.revision, nextState: appendNode(current, `${spec.nodePrefix ?? 'test-node'}-${process.pid}`) }),
        { lockHandle: handle },
      );
      journal('cs-work', { revisionOfUpdateReturn: value });
      journal('cs-exit');
      mark(spec.writtenName ?? 'written');
      if (mode === 'store-recover-write-hold') {
        waitForBarrier(spec.releaseName ?? 'go-release-writer', 120_000);
      }
      const released = store.releaseCanvasLock(handle);
      journal('released', { released });
      const committed = store.readCanvas(canvasId).revision;
      writeResult({ ok: true, fence: handle.fence, revision: committed, lockFence: store.readCanvas(canvasId).lockFence, released });
    } catch (error) {
      journal('write-failed', describeError(error));
      writeResult({ ok: false, ...describeError(error) });
    }
    return;
  }

  if (mode === 'release-handle') {
    const released =
      spec.handleKind === 'guard'
        ? internals.releaseRecoveryGuard(guardHandleFromSpec())
        : internals.releaseRecoveryMarker(markerHandleFromSpec());
    journal('handle-release', { handleKind: spec.handleKind ?? 'marker', released });
    writeResult({ ok: true, released });
    return;
  }

  if (mode === 'claim-marker-once') {
    const attempt = internals.tryClaimRecoveryMarker({ storeDir, canvasId });
    if (!attempt.acquired) {
      writeResult({ ok: true, acquired: false });
      return;
    }
    journal('marker-claimed', { token: attempt.marker.token, pid: attempt.marker.pid });
    const released = internals.releaseRecoveryMarker(attempt.marker);
    writeResult({ ok: true, acquired: true, token: attempt.marker.token, released });
    return;
  }

  if (mode === 'claim-guard-hold') {
    const guard = internals.acquireRecoveryGuard({
      storeDir,
      canvasId,
      deadline: Date.now() + (spec.timeoutMs ?? 5000),
    });
    journal('guard-claimed', { token: guard.token, pid: guard.pid });
    mark(spec.readyName ?? 'ready-guard-held');
    waitForBarrier(spec.releaseName ?? 'go-release-guard', 120_000);
    const released = internals.releaseRecoveryGuard(guard);
    journal('guard-released', { released });
    writeResult({ ok: true, token: guard.token, released });
    return;
  }

  if (mode === 'crash-marker-holder') {
    const marker = internals.ensureRecoveryMarker({
      storeDir,
      canvasId,
      staleMs: spec.staleMs ?? 100,
      deadline: Date.now() + (spec.timeoutMs ?? 5000),
    });
    journal('marker-acquired', { token: marker.token, pid: marker.pid });
    mark(spec.readyName ?? 'ready-crash-marker');
    sleepSync(120_000); // parent SIGKILLs this process; the marker record stays on disk
    writeResult({ ok: false, reason: 'crash-holder survived' });
    return;
  }

  if (mode === 'crash-guard-holder') {
    const guard = internals.acquireRecoveryGuard({
      storeDir,
      canvasId,
      deadline: Date.now() + (spec.timeoutMs ?? 5000),
    });
    journal('guard-claimed', { token: guard.token, pid: guard.pid });
    mark(spec.readyName ?? 'ready-crash-guard');
    sleepSync(120_000); // parent SIGKILLs this process; the guard record stays on disk
    writeResult({ ok: false, reason: 'crash-holder survived' });
    return;
  }

  if (mode === 'guard-probe') {
    try {
      const guard = internals.acquireRecoveryGuard({
        storeDir,
        canvasId,
        deadline: Date.now() + (spec.timeoutMs ?? 500),
      });
      const released = internals.releaseRecoveryGuard(guard);
      writeResult({ ok: true, token: guard.token, released });
    } catch (error) {
      writeResult({ ok: false, ...describeError(error) });
    }
    return;
  }

  throw new Error(`unknown worker mode: ${mode}`);
}

run()
  .catch((error) => {
    journal('fatal', { message: error?.message ?? String(error), stack: String(error?.stack ?? '') });
    try {
      writeResult({ ok: false, fatal: error?.message ?? String(error) });
    } catch {
      // The parent reports a missing result as a failure.
    }
    process.exitCode = 1;
  })
  .finally(() => {
    mark(`exited-${role}`);
  });
