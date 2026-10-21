#!/usr/bin/env node
/**
 * Test helper: a real OS child process that exercises the real lock/store modules.
 *
 * This worker is spawned by `test/concurrency/lock-safety.test.mjs` (through
 * `lock-worker-client.mjs`). It is a genuine separate process: no in-process mocking, no
 * fake filesystem. It imports the production modules by relative path and writes its result
 * to a JSON file so callers never need to parse stdout.
 *
 * Modes (all read a JSON spec file passed with --spec):
 *   hold              acquire the canvas lock, signal ready, hold until a release marker file
 *                     appears, then call the real ownership-checked release.
 *   acquire-once      try to acquire once with the given deadline; report success or the
 *                     stable error code (e.g. CANVAS_STORE_BUSY / CANVAS_LOCK_UNVERIFIABLE).
 *   crash-hold        acquire and hold forever without releasing (parent SIGKILLs it).
 *   interrupted-write acquire a handle, then start a real updateCanvas({lockHandle}) whose
 *                     updater blocks inside the critical section before writing (parent kills).
 *   update-count      perform `count` serialized updateCanvas read-modify-write operations,
 *                     journaling a critical-section interval around each one.
 *   op-create         execute one real operation-runtime batch (CAS-retried) so a durable
 *                     receipt is persisted, journaling each critical-section interval.
 *   update-once       one real updateCanvas read-modify-write (used for crash recovery timing).
 *
 * The journal is an append-only NDJSON file shared by all worker processes:
 *   {"t": epochMs, "pid": <pid>, "mode": "...", "event": "cs-enter"|"cs-exit"|"owned"|...}
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createFileCanvasStore } from '../../src/store/store.js';
import { acquireCanvasLock, releaseCanvasLock, verifyCanvasLock } from '../../src/store/lock.js';
import { createOperationExecutor } from '../../src/operations/runtime.js';
import { createAuthorizer } from '../../src/auth/authorize.js';
import { makePrincipal } from './auth-config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sleepSync(ms) {
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, ms);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--spec') out.spec = argv[++i];
    else throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

const { spec: specPath } = parseArgs(process.argv.slice(2));
const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
const {
  mode,
  storeDir,
  canvasId,
  resultPath,
  journalPath,
  timeoutMs = 5000,
  staleMs = 10000,
  readyPath,
  ready2Path,
  releasePath,
  nodePrefix = `worker-${process.pid}`,
  count = 1,
  operationPrefix = `op-worker-${process.pid}`,
  startDelayMs = 0,
} = spec;

if (!mode) throw new Error('spec.mode is required');

function journal(event, extra = {}) {
  const t = Date.now();
  fs.appendFileSync(
    journalPath,
    `${JSON.stringify({ t, iso: new Date(t).toISOString(), pid: process.pid, mode, event, ...extra })}\n`,
  );
}

function writeResult(result) {
  fs.writeFileSync(resultPath, `${JSON.stringify({ mode, pid: process.pid, ...result })}\n`, 'utf8');
}

function markReady(filePath) {
  if (filePath) fs.writeFileSync(filePath, '1');
}

async function waitForFile(filePath, waitMs) {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) return true;
    await sleep(2);
  }
  return false;
}

function openStore() {
  const store = createFileCanvasStore({ dir: storeDir, lockTimeoutMs: timeoutMs, staleLockMs: staleMs });
  store.init();
  return store;
}

/** Build a structurally valid node for direct store updates (no operation receipt). */
function makeNode(id) {
  return { id, type: 'note', position: { x: 0, y: 0 }, data: { nodeType: 'note', label: `Worker node ${id}` } };
}

function countNodes(state) {
  return Array.isArray(state?.data?.nodes) ? state.data.nodes.length : 0;
}

async function runHold() {
  let handle;
  try {
    handle = acquireCanvasLock({ storeDir, canvasId, timeoutMs, staleMs });
  } catch (error) {
    journal('hold-failed', { code: error?.code ?? null, message: error?.message ?? String(error) });
    writeResult({ ok: false, code: error?.code ?? null, message: error?.message ?? String(error) });
    return;
  }
  journal('owned', { fence: handle.fence, pid: process.pid });
  markReady(readyPath);
  const releasedByParent = await waitForFile(releasePath, 30_000);
  const released = releaseCanvasLock(handle);
  const verificationAfter = verifyCanvasLock(handle);
  journal('release', { released, releasedByParent });
  writeResult({ ok: true, fence: handle.fence, released, releasedByParent, verificationAfter });
}

async function runAcquireOnce() {
  if (startDelayMs > 0) await sleep(startDelayMs);
  try {
    const handle = acquireCanvasLock({ storeDir, canvasId, timeoutMs, staleMs });
    journal('owned', { fence: handle.fence, pid: process.pid });
    const verification = verifyCanvasLock(handle);
    const released = releaseCanvasLock(handle);
    writeResult({ ok: true, fence: handle.fence, verification, released });
  } catch (error) {
    journal('acquire-failed', { code: error?.code ?? null, message: error?.message ?? String(error) });
    writeResult({ ok: false, code: error?.code ?? null, message: error?.message ?? String(error) });
  }
}

async function runCrashHold() {
  const handle = acquireCanvasLock({ storeDir, canvasId, timeoutMs, staleMs });
  journal('owned', { fence: handle.fence, pid: process.pid });
  markReady(readyPath);
  sleepSync(120_000);
  // Unreachable: the parent kills this process with SIGKILL while it holds the lock.
  writeResult({ ok: false, reason: 'crash-hold unexpectedly survived' });
}

async function runInterruptedWrite() {
  const store = openStore();
  const handle = store.acquireCanvasLock(canvasId, { timeoutMs, staleMs });
  journal('owned', { fence: handle.fence, pid: process.pid });
  markReady(readyPath);
  store.updateCanvas(
    canvasId,
    (current) => {
      // Inside the critical section, before the atomic state write: signal the parent, then block.
      markReady(ready2Path);
      sleepSync(120_000);
      return { value: null, nextState: current };
    },
    { lockHandle: handle },
  );
  writeResult({ ok: false, reason: 'interrupted-write unexpectedly survived' });
}

async function runUpdateCount() {
  const store = openStore();
  let applied = 0;
  const errors = [];
  for (let i = 0; i < count; i += 1) {
    const nodeId = `${nodePrefix}-${i}`;
    // Acquire first, THEN journal cs-enter: the journaled interval is the real critical section
    // (ownership held), not the lock-waiting window. updateCanvas advances the fence/state under
    // the same handle and never re-acquires.
    const handle = store.acquireCanvasLock(canvasId, { timeoutMs, staleMs });
    journal('cs-enter', { index: i, fence: handle.fence });
    try {
      store.updateCanvas(
        canvasId,
        (current) => ({
          value: current.revision,
          nextState: {
            ...current,
            revision: current.revision + 1,
            data: { ...current.data, nodes: [...current.data.nodes, makeNode(nodeId)] },
            updatedAt: new Date().toISOString(),
          },
        }),
        { lockHandle: handle },
      );
      applied += 1;
      journal('cs-exit', { index: i, ok: true });
    } catch (error) {
      errors.push({ index: i, code: error?.code ?? null, message: error?.message ?? String(error) });
      journal('cs-exit', { index: i, ok: false, code: error?.code ?? null });
    } finally {
      releaseCanvasLock(handle);
    }
  }
  const finalState = store.readCanvas(canvasId);
  writeResult({ ok: errors.length === 0, applied, errors, revision: finalState.revision, nodes: countNodes(finalState) });
}

function buildOperationEnvelope(operationId, canvasIdToUse, expectedRevision, nodeId) {
  return {
    operationId,
    kind: 'canvas.batch',
    payload: {
      canvasId: canvasIdToUse,
      expectedRevision,
      actions: [
        {
          kind: 'node.create',
          node: { id: nodeId, type: 'text', data: { label: `Lock worker ${nodeId}` } },
        },
      ],
    },
  };
}

async function runOpCreate() {
  const store = openStore();
  const principal = makePrincipal({
    principalId: 'agent-lock-worker',
    token: 'demo-lock-worker-token',
    mode: 'CANVAS_WRITE',
    canvasIds: [canvasId],
  });
  const authorize = createAuthorizer({ principal });
  const operationId = `${operationPrefix}-0`;
  const nodeId = `${nodePrefix}-0`;
  let currentHandle = null;
  // The production executor acquires the lock itself; for a journaled critical section we acquire
  // one ownership-checked handle, journal cs-enter, and hand it to updateCanvas through the
  // documented advanced `{lockHandle}` path. Everything else (validation, CAS, receipt) is the
  // real operation-runtime code.
  const lockedStore = {
    ...store,
    updateCanvas: (targetCanvasId, updater) =>
      store.updateCanvas(targetCanvasId, updater, { lockHandle: currentHandle }),
  };
  const executor = createOperationExecutor({
    store: lockedStore,
    authorize,
    principal,
    agentId: 'agent-lock-worker',
  });
  let attempt = 0;
  while (attempt < 12) {
    attempt += 1;
    currentHandle = store.acquireCanvasLock(canvasId, { timeoutMs, staleMs });
    journal('cs-enter', { attempt, fence: currentHandle.fence });
    try {
      const revision = store.readCanvas(canvasId).revision;
      const result = executor.execute(buildOperationEnvelope(operationId, canvasId, revision, nodeId));
      journal('cs-exit', { attempt, ok: true });
      writeResult({
        ok: true,
        operationId,
        nodeId,
        replayed: result.replayed,
        revision: result.revision,
        attempts: attempt,
      });
      return;
    } catch (error) {
      journal('cs-exit', { attempt, ok: false, code: error?.code ?? null });
      if (error?.code !== 'CANVAS_REVISION_CONFLICT') {
        writeResult({ ok: false, operationId, nodeId, attempts: attempt, code: error?.code ?? null, message: error?.message });
        return;
      }
      await sleep(2 + Math.floor(Math.random() * 8));
    } finally {
      if (currentHandle !== null) releaseCanvasLock(currentHandle);
      currentHandle = null;
    }
  }
  writeResult({
    ok: false,
    operationId,
    nodeId,
    attempts: attempt,
    code: 'CANVAS_REVISION_CONFLICT',
    message: 'retry budget exhausted',
  });
}

async function runUpdateOnce() {
  const store = openStore();
  journal('start');
  const nodeId = `${nodePrefix}-0`;
  const startedAt = Date.now();
  store.updateCanvas(canvasId, (current) => ({
    value: current.revision,
    nextState: {
      ...current,
      revision: current.revision + 1,
      data: { ...current.data, nodes: [...current.data.nodes, makeNode(nodeId)] },
      updatedAt: new Date().toISOString(),
    },
  }));
  journal('done', { elapsedMs: Date.now() - startedAt });
  const finalState = store.readCanvas(canvasId);
  writeResult({ ok: true, revision: finalState.revision, nodes: countNodes(finalState), elapsedMs: Date.now() - startedAt });
}

async function main() {
  if (startDelayMs > 0) await sleep(startDelayMs);
  switch (mode) {
    case 'hold':
      return runHold();
    case 'acquire-once':
      return runAcquireOnce();
    case 'crash-hold':
      return runCrashHold();
    case 'interrupted-write':
      return runInterruptedWrite();
    case 'update-count':
      return runUpdateCount();
    case 'op-create':
      return runOpCreate();
    case 'update-once':
      return runUpdateOnce();
    default:
      throw new Error(`unknown mode: ${mode}`);
  }
}

main().catch((error) => {
  journal('fatal', { message: error?.message ?? String(error), stack: String(error?.stack ?? '') });
  try {
    writeResult({ ok: false, fatal: error?.message ?? String(error) });
  } catch {
    // Ignore: the parent will report a missing result file as a failure.
  }
  process.exitCode = 1;
});

export { REPO_ROOT };
