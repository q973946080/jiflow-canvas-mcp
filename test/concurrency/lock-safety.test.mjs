// Multi-process lock-safety suite: real OS processes, real file store, real lock module.
//
// Every safety-core scenario below runs in SEPARATE `node` child processes that import the
// production modules (`src/store/lock.js`, `src/store/store.js`, `src/operations/runtime.js`
// and the real MCP server). Nothing in the lock/fence/liveness safety core is mocked; only
// orchestration (spawn/wait/result files) lives in `test/helpers/`.
//
// Scenarios 1-11 are the lock-safety scenario list; scenario 12 is the recovery-marker
// multi-recoverer race (several processes recover the same dead-owner lock plus a later live
// claimer).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { createFileCanvasStore } from '../../src/store/store.js';
import {
  acquireCanvasLock,
  releaseCanvasLock,
  verifyCanvasLock,
  inspectCanvasLock,
  canvasLockPath,
  canvasFencePath,
} from '../../src/store/lock.js';
import {
  createFixtureStore,
  createLockFile,
  findTempFiles,
  getExitedProcessPid,
  lockFilePath,
  makeLockOwnerRecord,
  readCanvasFileRaw,
  readCanvasState,
  readFence,
  rmrf,
  writeRawLockFile,
} from '../helpers/fixture-store.mjs';
import {
  sleep,
  spawnLockWorker,
  runLockWorker,
  createWorkerDir,
  waitForFile,
  waitForJournal,
  readJournal,
  criticalSections,
  overlappingPairs,
  listDirectory,
  workerPaths,
} from '../helpers/lock-worker-client.mjs';
import { createServerFixture, attachServer } from '../helpers/server-fixture.mjs';
import { callTool, expectToolOk, parseToolContent } from '../helpers/mcp-tool.mjs';

const CANVAS = 'canvas-fixture-a';
const CANVAS_B = 'canvas-fixture-b';
const STALE_MS = 150;
const ERROR = {
  STORE_BUSY: 'CANVAS_STORE_BUSY',
  LOCK_OWNERSHIP_LOST: 'CANVAS_LOCK_OWNERSHIP_LOST',
  LOCK_UNVERIFIABLE: 'CANVAS_LOCK_UNVERIFIABLE',
  REVISION_CONFLICT: 'CANVAS_REVISION_CONFLICT',
};

/** Serialise every assertion failure with the shared journal for the report/raw test log. */
function journalText(journalPath) {
  try {
    return fs.readFileSync(journalPath, 'utf8');
  } catch {
    return '(no journal)';
  }
}

function openStore(storeDir, options = {}) {
  return createFileCanvasStore({ dir: storeDir, lockTimeoutMs: 5000, staleLockMs: STALE_MS, ...options });
}

/**
 * Run `fn` with a fresh fixture store (canvases A/B), a worker scratch dir and a shared journal.
 * Everything is removed afterwards.
 */
async function withLockFixture(fn, { canvases } = {}) {
  const fixture = createFixtureStore(canvases ? { canvases } : undefined);
  const workDir = createWorkerDir();
  const journal = path.join(workDir, 'journal.ndjson');
  try {
    return await fn({
      fixture,
      storeDir: fixture.storeDir,
      store: openStore(fixture.storeDir),
      workDir,
      journal,
    });
  } finally {
    fixture.cleanup();
    rmrf(workDir);
  }
}

/** The `.locks` directory may only contain persistent `<canvas>.fence` counter files. */
function assertNoLockArtifacts(storeDir, label = 'store') {
  const entries = listDirectory(path.join(storeDir, '.locks'));
  const unexpected = entries.filter((name) => !name.endsWith('.fence'));
  assert.deepEqual(
    unexpected,
    [],
    `${label}: only persistent .fence files may remain in .locks, found ${JSON.stringify(unexpected)}\n` +
      `journal:\n${journalText(path.join(path.dirname(storeDir), 'journal.ndjson'))}`,
  );
  assert.deepEqual(findTempFiles(storeDir), [], `${label}: no .tmp-* state temp files may remain`);
}

/** Build a worker spec with the shared fields filled in. */
function workerSpec(ctx, mode, label, overrides = {}) {
  const paths = workerPaths(ctx.workDir, label);
  return {
    mode,
    storeDir: ctx.storeDir,
    canvasId: CANVAS,
    journalPath: ctx.journal,
    timeoutMs: 5000,
    staleMs: STALE_MS,
    ...paths,
    resultPath: paths.resultPath,
    ...overrides,
  };
}

describe('lock safety: real multi-process critical sections', () => {
  test('1. a live owner past the old stale threshold is not preempted; contender is BUSY; next acquirer succeeds after release', { timeout: 60_000 }, async () => {
    await withLockFixture(async (ctx) => {
      const holder = spawnLockWorker(workerSpec(ctx, 'hold', 'holder', { staleMs: STALE_MS, timeoutMs: 5000 }));
      let released = false;
      try {
        assert.equal(await waitForFile(holder.spec.readyPath, 20_000), true, 'holder child must acquire the lock');
        const owned = readJournal(ctx.journal).find((r) => r.pid === holder.pid && r.event === 'owned');
        assert.ok(owned, 'holder must journal its ownership');
        const inspected = inspectCanvasLock(ctx.storeDir, CANVAS);
        assert.equal(inspected.exists, true);
        assert.equal(inspected.alive, true);
        assert.equal(inspected.owner.pid, holder.pid, 'the live child process must be the recorded owner');

        // Hold well past the old staleMs threshold before a second real process tries to acquire.
        await sleep(STALE_MS + 150);
        const contender = await runLockWorker(
          workerSpec(ctx, 'acquire-once', 'contender', { staleMs: STALE_MS, timeoutMs: 450 }),
        );
        assert.equal(contender.result.ok, false, 'a live owner must never be preempted');
        assert.equal(contender.result.code, ERROR.STORE_BUSY);
        const failed = readJournal(ctx.journal).find((r) => r.pid === contender.handle.pid && r.event === 'acquire-failed');
        assert.ok(failed && failed.t - owned.t > STALE_MS, 'the contender tried after the old stale threshold had elapsed');

        // The holder still owns everything and can release cleanly.
        const stillOwner = readJournal(ctx.journal).find((r) => r.pid === holder.pid && r.event === 'owned');
        assert.equal(stillOwner.fence, owned.fence, 'ownership must not change while the owner is alive');
        assert.equal(fs.existsSync(lockFilePath(ctx.storeDir, CANVAS)), true);

        fs.writeFileSync(holder.spec.releasePath, '1');
        released = true;
        const exit = await holder.waitExit(15_000);
        assert.equal(exit.code, 0, `holder must exit 0, got code=${exit.code} signal=${exit.signal}\n${journalText(ctx.journal)}`);
        const holderResult = await holder.result();
        assert.equal(holderResult.released, true, 'holder release must remove its own lock');
        assert.deepEqual(holderResult.verificationAfter, { ok: false, reason: 'LOCK_MISSING' });
        assert.equal(fs.existsSync(lockFilePath(ctx.storeDir, CANVAS)), false);

        // After release a fresh real process acquires cleanly (fence strictly increases).
        const next = await runLockWorker(workerSpec(ctx, 'acquire-once', 'next', { staleMs: STALE_MS, timeoutMs: 1000 }));
        assert.equal(next.result.ok, true, `next acquirer must succeed, got ${JSON.stringify(next.result)}`);
        assert.equal(next.result.fence, owned.fence + 1, 'fence must increment by exactly one per acquisition');
        assert.equal(next.result.released, true);
        assert.equal(fs.existsSync(lockFilePath(ctx.storeDir, CANVAS)), false);
        assertNoLockArtifacts(ctx.storeDir);
      } finally {
        if (!released) holder.kill();
      }
    });
  });

  test('2. release of a handle whose lock was taken over returns false and leaves the new owner lock intact', { timeout: 60_000 }, async () => {
    await withLockFixture(async (ctx) => {
      const store = openStore(ctx.storeDir);
      const staleHandle = store.acquireCanvasLock(CANVAS);
      assert.deepEqual(verifyCanvasLock(staleHandle), { ok: true });
      // Forced takeover through the file protocol: the old owner's lock record is removed
      // externally and a new real process claims the lock (new token, new fence generation).
      fs.unlinkSync(staleHandle.lockPath);
      const newOwner = spawnLockWorker(workerSpec(ctx, 'hold', 'new-owner', { timeoutMs: 5000 }));
      let released = false;
      try {
        assert.equal(await waitForFile(newOwner.spec.readyPath, 20_000), true);
        const owned = readJournal(ctx.journal).find((r) => r.pid === newOwner.pid && r.event === 'owned');
        assert.ok(owned);
        assert.equal(owned.fence, staleHandle.fence + 1, 'forced takeover must advance the fence generation');

        assert.equal(releaseCanvasLock(staleHandle), false, 'a stale handle must never release a foreign lock');
        assert.equal(fs.existsSync(lockFilePath(ctx.storeDir, CANVAS)), true, 'new owner lock must survive the stale release');
        const inspected = inspectCanvasLock(ctx.storeDir, CANVAS);
        assert.equal(inspected.owner.pid, newOwner.pid);
        assert.equal(inspected.alive, true);
        assert.equal(inspected.owner.token === staleHandle.token, false);
        const staleVerify = verifyCanvasLock(staleHandle);
        assert.equal(staleVerify.ok, false);
        assert.ok(['LOCK_MISSING', 'LOCK_OWNER_MISMATCH'].includes(staleVerify.reason), `unexpected reason ${staleVerify.reason}`);

        fs.writeFileSync(newOwner.spec.releasePath, '1');
        released = true;
        await newOwner.waitExit(15_000);
        const result = await newOwner.result();
        assert.equal(result.released, true);
        assert.equal(fs.existsSync(lockFilePath(ctx.storeDir, CANVAS)), false);
        assertNoLockArtifacts(ctx.storeDir);
      } finally {
        if (!released) newOwner.kill();
      }
    });
  });

  test('3. A/B/C real processes contending: strictly non-overlapping critical sections, no double owner, exact state/fence', { timeout: 90_000 }, async () => {
    await withLockFixture(async (ctx) => {
      const roles = ['A', 'B', 'C'];
      const updatesPerProcess = 5;
      const workers = roles.map((role, index) =>
        spawnLockWorker(
          workerSpec(ctx, 'update-count', `proc-${role}`, {
            count: updatesPerProcess,
            nodePrefix: `node-contend-${role}`,
            startDelayMs: index * 7,
          }),
        ),
      );
      const results = await Promise.all(
        workers.map(async (worker) => {
          await worker.waitExit(60_000);
          return worker.result();
        }),
      );
      for (const [index, result] of results.entries()) {
        assert.equal(result.ok, true, `${roles[index]} must complete all updates: ${JSON.stringify(result)}`);
        assert.equal(result.applied, updatesPerProcess);
        assert.deepEqual(result.errors, []);
      }
      const records = readJournal(ctx.journal);
      const sections = criticalSections(records);
      assert.equal(sections.length, roles.length * updatesPerProcess, 'every update must journal exactly one critical section');
      assert.deepEqual(overlappingPairs(sections), [], 'critical sections must never overlap across processes');
      // "No double owner": at most one process may hold the lock at any instant. The journal's
      // cs intervals prove that; the final fence proves one acquisition per update.
      const ownedEvents = records.filter((record) => record.event === 'owned');
      assert.equal(ownedEvents.length, 0, 'direct store updates must not leave un-released ownership events');

      const total = roles.length * updatesPerProcess;
      const state = readCanvasState(ctx.storeDir, CANVAS);
      assert.equal(state.revision, total, 'exactly one revision increment per update');
      assert.equal(state.data.nodes.length, 3 + total, 'exactly one node per update, no lost updates');
      for (const role of roles) {
        for (let i = 0; i < updatesPerProcess; i += 1) {
          assert.equal(
            state.data.nodes.some((node) => node.id === `node-contend-${role}-${i}`),
            true,
            `node node-contend-${role}-${i} must be persisted`,
          );
        }
      }
      assert.equal(readFence(ctx.storeDir, CANVAS).fence, total, 'one lock generation per serialized update');
      assert.deepEqual(listDirectory(path.join(ctx.storeDir, '.locks')).filter((name) => name.endsWith('.lock')), []);
      assertNoLockArtifacts(ctx.storeDir);
    });
  });

  test('4. a stale handle write is rejected with CANVAS_LOCK_OWNERSHIP_LOST and leaves state byte-identical', { timeout: 60_000 }, async () => {
    await withLockFixture(async (ctx) => {
      const store = openStore(ctx.storeDir);
      const staleHandle = store.acquireCanvasLock(CANVAS);
      const rawBefore = readCanvasFileRaw(ctx.storeDir, CANVAS);
      // Forced external ownership loss, then a new real process takes over.
      fs.unlinkSync(staleHandle.lockPath);
      const newOwner = spawnLockWorker(workerSpec(ctx, 'hold', 'new-owner', { timeoutMs: 5000 }));
      let released = false;
      try {
        assert.equal(await waitForFile(newOwner.spec.readyPath, 20_000), true);
        const owned = readJournal(ctx.journal).find((r) => r.pid === newOwner.pid && r.event === 'owned');
        assert.ok(owned);
        let caught = null;
        try {
          store.updateCanvas(
            CANVAS,
            (current) => ({
              value: 'must-not-be-written',
              nextState: { ...current, revision: current.revision + 1 },
            }),
            { lockHandle: staleHandle },
          );
        } catch (error) {
          caught = error;
        }
        assert.ok(caught, 'a stale handle write must be rejected');
        assert.equal(caught.code, ERROR.LOCK_OWNERSHIP_LOST);
        assert.ok(
          ['LOCK_OWNER_MISMATCH', 'LOCK_MISSING', 'LOCK_FENCE_STALE'].includes(caught.detail?.reason),
          `unexpected ownership-lost reason ${caught.detail?.reason}`,
        );
        assert.equal(readCanvasFileRaw(ctx.storeDir, CANVAS), rawBefore, 'rejected write must not change the state file at all');
        const state = readCanvasState(ctx.storeDir, CANVAS);
        assert.equal(state.revision, 0);
        assert.equal(state.data.nodes.length, 3);
        assert.deepEqual(state.receipts, {});
        assert.equal(releaseCanvasLock(staleHandle), false);
        assert.equal(fs.existsSync(lockFilePath(ctx.storeDir, CANVAS)), true, 'new owner lock must remain intact');

        fs.writeFileSync(newOwner.spec.releasePath, '1');
        released = true;
        await newOwner.waitExit(15_000);
        assert.equal((await newOwner.result()).released, true);

        // A fresh handle (the real current generation) can write normally afterwards.
        const value = store.updateCanvas(CANVAS, (current) => ({
          value: current.revision,
          nextState: { ...current, revision: current.revision + 1 },
        }));
        assert.equal(value, 0);
        const finalState = readCanvasState(ctx.storeDir, CANVAS);
        assert.equal(finalState.revision, 1);
        assert.equal(finalState.lockFence, readFence(ctx.storeDir, CANVAS).fence);
        assertNoLockArtifacts(ctx.storeDir);
      } finally {
        if (!released) newOwner.kill();
      }
    });
  });

  test('5. normal release after a write: no lock file remains and the next acquirer succeeds', { timeout: 60_000 }, async () => {
    await withLockFixture(async (ctx) => {
      const writer = await runLockWorker(workerSpec(ctx, 'update-once', 'writer', { timeoutMs: 5000 }));
      assert.equal(writer.result.ok, true);
      assert.equal(writer.result.revision, 1);
      assert.equal(fs.existsSync(lockFilePath(ctx.storeDir, CANVAS)), false, 'release must remove the lock file');
      assert.equal(readFence(ctx.storeDir, CANVAS).fence, 1);

      const next = await runLockWorker(workerSpec(ctx, 'acquire-once', 'next', { timeoutMs: 1000 }));
      assert.equal(next.result.ok, true);
      assert.equal(next.result.fence, 2);
      assert.equal(next.result.released, true);
      assert.equal(fs.existsSync(lockFilePath(ctx.storeDir, CANVAS)), false);
      const state = readCanvasState(ctx.storeDir, CANVAS);
      assert.equal(state.revision, 1, 'a lock-only acquisition must not change canvas state');
      assertNoLockArtifacts(ctx.storeDir);
    });
  });

  test('6. SIGKILLed holder: recovery waits for liveness+age, completes a write; no double owner, no corruption', { timeout: 90_000 }, async () => {
    await withLockFixture(async (ctx) => {
      const crashStore = openStore(ctx.storeDir, { staleLockMs: 400 });
      const crashHolder = spawnLockWorker(workerSpec(ctx, 'crash-hold', 'crash', { staleMs: 400, timeoutMs: 5000 }));
      try {
        assert.equal(await waitForFile(crashHolder.spec.readyPath, 20_000), true);
        const owned = readJournal(ctx.journal).find((r) => r.pid === crashHolder.pid && r.event === 'owned');
        assert.ok(owned);
        crashHolder.kill('SIGKILL');
        const exit = await crashHolder.waitExit(15_000);
        assert.equal(exit.signal, 'SIGKILL');

        const orphaned = inspectCanvasLock(ctx.storeDir, CANVAS);
        assert.equal(orphaned.exists, true, 'the crash must leave the owner record behind');
        assert.equal(orphaned.alive, false, 'the recorded owner pid must be provably dead');
        assert.equal(orphaned.owner.pid, crashHolder.pid);

        // Before the owner file passes the conservative age gate, a waiter must time out (BUSY),
        // it must not steal the lock just because it looks old/dead.
        const early = await runLockWorker(
          workerSpec(ctx, 'acquire-once', 'early', { staleMs: 400, timeoutMs: 120 }),
        );
        assert.equal(early.result.ok, false, 'recovery must not happen before the age gate');
        assert.equal(early.result.code, ERROR.STORE_BUSY);
        const ownerFileMtime = fs.statSync(lockFilePath(ctx.storeDir, CANVAS)).mtimeMs;

        // A later process recovers only after liveness + age and completes a real write.
        const recovery = await runLockWorker(
          workerSpec(ctx, 'update-once', 'recovery-writer', { staleMs: 400, timeoutMs: 3000 }),
        );
        assert.equal(recovery.result.ok, true, `recovery writer failed: ${JSON.stringify(recovery.result)}`);
        assert.ok(
          Date.now() - ownerFileMtime >= 400,
          `recovery must only happen after the 400ms age gate; owner file age was ${Date.now() - ownerFileMtime}ms`,
        );
        assert.equal(recovery.result.revision, 1);

        const state = crashStore.readCanvas(CANVAS);
        assert.equal(state.revision, 1, 'exactly one recovery write, no double apply');
        assert.equal(state.data.nodes.length, 4);
        assert.equal(state.lockFence, readFence(ctx.storeDir, CANVAS).fence);
        assert.equal(fs.existsSync(lockFilePath(ctx.storeDir, CANVAS)), false);
        assertNoLockArtifacts(ctx.storeDir);
      } finally {
        crashHolder.kill();
      }
    });
  });

  test('7. N real MCP server processes create nodes with CAS retry: final revision/nodes/receipts exact', { timeout: 120_000 }, async () => {
    const fixture = await createServerFixture();
    const extras = await Promise.all([attachServer(fixture), attachServer(fixture), attachServer(fixture)]);
    const servers = [fixture.handle, ...extras];
    const perServer = 3;
    const total = servers.length * perServer;
    try {
      await Promise.all(
        servers.map(async (server, serverIndex) => {
          for (let i = 0; i < perServer; i += 1) {
            const nodeId = `node-lock-race-${serverIndex}-${i}`;
            const operationId = `op-lock-race-${serverIndex}-${i}`;
            let applied = false;
            for (let attempt = 0; attempt < 30 && !applied; attempt += 1) {
              const read = expectToolOk(await callTool(server.client, 'canvas_read_canvas', { canvasId: CANVAS }));
              const expectedRevision = read.revision;
              const raw = await callTool(server.client, 'canvas_create_node', {
                canvasId: CANVAS,
                kind: 'text',
                label: `Lock race ${serverIndex}-${i}`,
                nodeId,
                operationId,
                expectedRevision,
              });
              const payload = parseToolContent(raw);
              if (payload.ok === true) {
                assert.equal(payload.replayed, false);
                applied = true;
              } else {
                assert.equal(payload.code, ERROR.REVISION_CONFLICT, `unexpected error ${JSON.stringify(payload)}`);
              }
            }
            assert.equal(applied, true, `${operationId} must eventually apply`);
          }
        }),
      );
      const state = readCanvasState(fixture.store.storeDir, CANVAS);
      assert.equal(state.revision, total, 'one revision increment per applied operation');
      assert.equal(state.data.nodes.length, 3 + total, 'no lost updates');
      assert.equal(Object.keys(state.receipts).length, total, 'exactly one durable receipt per operation');
      for (let serverIndex = 0; serverIndex < servers.length; serverIndex += 1) {
        for (let i = 0; i < perServer; i += 1) {
          assert.ok(state.receipts[`op-lock-race-${serverIndex}-${i}`], 'receipt must be persisted');
          assert.equal(
            state.data.nodes.some((node) => node.id === `node-lock-race-${serverIndex}-${i}`),
            true,
          );
        }
      }
      assertNoLockArtifacts(fixture.store.storeDir);
    } finally {
      await Promise.allSettled(extras.map((handle) => handle.cleanup()));
      await fixture.close();
    }
  });

  test('8. the same operationId concurrently from two real server processes: exactly one applied, one replayed', { timeout: 90_000 }, async () => {
    const fixture = await createServerFixture();
    const extra = await attachServer(fixture);
    const servers = [fixture.handle, extra];
    const operationId = 'op-lock-idem-race-1';
    const request = {
      canvasId: CANVAS,
      kind: 'note',
      label: 'Concurrent idempotent node',
      nodeId: 'node-lock-idem-1',
      operationId,
      expectedRevision: 0,
    };
    try {
      const payloads = (await Promise.all(servers.map((server) => callTool(server.client, 'canvas_create_node', request)))).map(
        (raw) => parseToolContent(raw),
      );
      assert.equal(payloads.every((payload) => payload.ok === true), true, JSON.stringify(payloads));
      assert.equal(payloads.filter((payload) => payload.replayed === false).length, 1);
      assert.equal(payloads.filter((payload) => payload.replayed === true).length, 1);
      const [applied] = payloads.filter((payload) => payload.replayed === false);
      const [replayed] = payloads.filter((payload) => payload.replayed === true);
      assert.equal(applied.revision, 1);
      assert.equal(replayed.revision, 1);
      assert.equal(applied.payloadHash, replayed.payloadHash);
      assert.deepEqual(applied.result, replayed.result);
      const state = readCanvasState(fixture.store.storeDir, CANVAS);
      assert.equal(state.revision, 1);
      assert.equal(state.data.nodes.length, 4);
      assert.equal(Object.keys(state.receipts).length, 1);
      assertNoLockArtifacts(fixture.store.storeDir);
    } finally {
      await extra.cleanup();
      await fixture.close();
    }
  });

  test('9. SIGKILL during the critical section: store parses, no fake receipt, retry is safe', { timeout: 90_000 }, async () => {
    await withLockFixture(async (ctx) => {
      const interrupted = spawnLockWorker(
        workerSpec(ctx, 'interrupted-write', 'interrupted', { staleMs: 250, timeoutMs: 5000 }),
      );
      try {
        assert.equal(await waitForFile(interrupted.spec.readyPath, 20_000), true, 'worker must own the lock');
        assert.equal(await waitForFile(interrupted.spec.ready2Path, 20_000), true, 'worker must be inside the updater');
        interrupted.kill('SIGKILL');
        const exit = await interrupted.waitExit(15_000);
        assert.equal(exit.signal, 'SIGKILL');

        // The killed critical section never reached the atomic state write: the store is parseable,
        // unchanged, and contains no fake receipt.
        const rawAfterKill = readCanvasFileRaw(ctx.storeDir, CANVAS);
        const parsed = JSON.parse(rawAfterKill);
        assert.equal(parsed.revision, 0);
        assert.equal(parsed.data.nodes.length, 3);
        assert.deepEqual(parsed.receipts, {});
        assert.deepEqual(findTempFiles(ctx.storeDir), [], 'no half-written state temp file may remain');

        // A retry after recovery is safe and produces exactly one committed operation.
        const retry = await runLockWorker(workerSpec(ctx, 'update-once', 'retry-writer', { staleMs: 250, timeoutMs: 3000 }));
        assert.equal(retry.result.ok, true, `retry after interrupted write failed: ${JSON.stringify(retry.result)}`);
        const state = readCanvasState(ctx.storeDir, CANVAS);
        assert.equal(state.revision, 1);
        assert.equal(state.data.nodes.length, 4);
        assert.deepEqual(state.receipts, {}, 'direct store retry must not fabricate a receipt');
        assertNoLockArtifacts(ctx.storeDir);
      } finally {
        interrupted.kill();
      }
    });
  });

  test('10. different canvases in parallel: no unnecessary blocking (CANVAS_STORE_BUSY is never raised)', { timeout: 60_000 }, async () => {
    await withLockFixture(async (ctx) => {
      // Two live owners hold locks on different canvases at the same time.
      const holderA = spawnLockWorker(workerSpec(ctx, 'hold', 'hold-a', { canvasId: CANVAS, timeoutMs: 5000 }));
      const holderB = spawnLockWorker(workerSpec(ctx, 'hold', 'hold-b', { canvasId: CANVAS_B, timeoutMs: 5000 }));
      let released = false;
      try {
        assert.equal(await waitForFile(holderA.spec.readyPath, 20_000), true);
        assert.equal(await waitForFile(holderB.spec.readyPath, 20_000), true, 'canvas B must be acquirable while canvas A is locked');
        assert.equal(inspectCanvasLock(ctx.storeDir, CANVAS).alive, true);
        assert.equal(inspectCanvasLock(ctx.storeDir, CANVAS_B).alive, true);
        const ownedA = readJournal(ctx.journal).find((r) => r.pid === holderA.pid && r.event === 'owned');
        const ownedB = readJournal(ctx.journal).find((r) => r.pid === holderB.pid && r.event === 'owned');
        assert.ok(ownedA && ownedB, 'both per-canvas locks must be owned simultaneously');

        fs.writeFileSync(holderA.spec.releasePath, '1');
        fs.writeFileSync(holderB.spec.releasePath, '1');
        released = true;
        await holderA.waitExit(15_000);
        await holderB.waitExit(15_000);

        // Parallel writers on different canvases both succeed with a short deadline.
        const [a, b] = await Promise.all([
          runLockWorker(workerSpec(ctx, 'update-once', 'parallel-a', { canvasId: CANVAS, timeoutMs: 900 })),
          runLockWorker(workerSpec(ctx, 'update-once', 'parallel-b', { canvasId: CANVAS_B, timeoutMs: 900 })),
        ]);
        assert.equal(a.result.ok, true, `canvas A writer failed: ${JSON.stringify(a.result)}`);
        assert.equal(b.result.ok, true, `canvas B writer failed: ${JSON.stringify(b.result)}`);
        assert.equal(a.result.revision, 1);
        assert.equal(b.result.revision, 1);
        assert.equal(readCanvasState(ctx.storeDir, CANVAS).revision, 1);
        assert.equal(readCanvasState(ctx.storeDir, CANVAS_B).revision, 1);
        assert.equal(readFence(ctx.storeDir, CANVAS).fence, 2);
        assert.equal(readFence(ctx.storeDir, CANVAS_B).fence, 2);
        assertNoLockArtifacts(ctx.storeDir);
      } finally {
        if (!released) {
          try {
            fs.writeFileSync(holderA.spec.releasePath, '1');
            fs.writeFileSync(holderB.spec.releasePath, '1');
          } catch {
            /* ignore */
          }
        }
        holderA.kill();
        holderB.kill();
      }
    });
  });

  test('11. randomized repeated contention: 25 rounds, 3-5 real processes, random delays; no overlap; exact receipts', { timeout: 180_000 }, async () => {
    await withLockFixture(async (ctx) => {
      const rounds = 25;
      let totalOperations = 0;
      for (let round = 0; round < rounds; round += 1) {
        const processCount = 3 + Math.floor(Math.random() * 3); // 3..5
        const workers = [];
        for (let index = 0; index < processCount; index += 1) {
          const label = `r${round}-w${index}`;
          workers.push({
            label,
            worker: spawnLockWorker(
              workerSpec(ctx, 'op-create', label, {
                nodePrefix: `node-rand-${label}`,
                operationPrefix: `op-rand-${label}`,
                startDelayMs: Math.floor(Math.random() * 25),
                timeoutMs: 15_000,
              }),
            ),
          });
        }
        const results = await Promise.all(
          workers.map(async ({ label, worker }) => {
            await worker.waitExit(120_000);
            return { label, result: await worker.result() };
          }),
        );
        for (const { label, result } of results) {
          assert.equal(result.ok, true, `round ${round} worker ${label} failed: ${JSON.stringify(result)}`);
          assert.equal(result.replayed, false, `round ${round} worker ${label} must apply (unique operationId)`);
          totalOperations += 1;
        }
      }

      const records = readJournal(ctx.journal);
      const sections = criticalSections(records);
      assert.deepEqual(
        overlappingPairs(sections),
        [],
        `randomized contention produced overlapping critical sections\n${journalText(ctx.journal)}`,
      );
      const state = readCanvasState(ctx.storeDir, CANVAS);
      assert.equal(state.revision, totalOperations, 'exactly one revision increment per applied operation');
      assert.equal(state.data.nodes.length, 3 + totalOperations, 'exactly one node per applied operation');
      assert.equal(Object.keys(state.receipts).length, totalOperations, 'exactly one durable receipt per applied operation');
      assert.equal(readFence(ctx.storeDir, CANVAS).fence >= totalOperations, true, 'at least one fence increment per applied operation');
      for (const key of Object.keys(state.receipts)) {
        assert.match(key, /^op-rand-r\d+-w\d+-0$/);
      }
      assertNoLockArtifacts(ctx.storeDir);
    });
  });

  test('12. multi-recoverer race on the same dead-owner lock: exactly one winner, live claimer later, no strays', { timeout: 90_000 }, async () => {
    await withLockFixture(async (ctx) => {
      // A provably dead owner (real exited pid) with an aged owner file and a matching fence file.
      const deadPid = await getExitedProcessPid();
      createLockFile(ctx.storeDir, CANVAS, { pid: deadPid, ageMs: 5000, fence: 4 });
      const racers = 5;
      const workers = [];
      for (let index = 0; index < racers; index += 1) {
        workers.push(
          spawnLockWorker(
            workerSpec(ctx, 'hold', `recoverer-${index}`, {
              staleMs: 150,
              timeoutMs: 2500,
              startDelayMs: Math.floor(Math.random() * 12),
            }),
          ),
        );
      }
      const byPid = new Map(workers.map((worker) => [worker.pid, worker]));
      try {
        // Exactly one recoverer must win the dead-owner lock and hold it.
        await waitForJournal(
          ctx.journal,
          (record) => record.event === 'owned' && byPid.has(record.pid),
          20_000,
          'one recoverer to acquire the dead owner lock',
        );
        const winner = readJournal(ctx.journal).find((record) => record.event === 'owned' && byPid.has(record.pid));
        assert.ok(winner, 'a recoverer must win');
        assert.equal(winner.fence, 5, 'recovery must increment the dead generation fence exactly once');
        // The losers must fail closed with CANVAS_STORE_BUSY while a live recoverer holds the lock.
        const failures = () =>
          readJournal(ctx.journal).filter((record) => record.event === 'hold-failed' && byPid.has(record.pid));
        const deadline = Date.now() + 20_000;
        while (failures().length < racers - 1 && Date.now() < deadline) await sleep(20);
        const losers = failures();
        assert.equal(losers.length, racers - 1, `expected ${racers - 1} losers, got ${JSON.stringify(losers)}`);
        for (const loser of losers) {
          assert.equal(loser.code, ERROR.STORE_BUSY, `loser must fail closed with CANVAS_STORE_BUSY, got ${loser.code}`);
        }
        const heldWorker = byPid.get(winner.pid);
        assert.ok(heldWorker, 'winner worker handle must exist');
        assert.equal(fs.existsSync(lockFilePath(ctx.storeDir, CANVAS)), true);
        assert.equal(inspectCanvasLock(ctx.storeDir, CANVAS).alive, true);

        // Release the winner, then a fresh live claimer succeeds on the recovered generation.
        fs.writeFileSync(heldWorker.spec.releasePath, '1');
        await heldWorker.waitExit(20_000);
        const winnerResult = await heldWorker.result();
        assert.equal(winnerResult.released, true);
        assert.equal(fs.existsSync(lockFilePath(ctx.storeDir, CANVAS)), false);

        const claimer = await runLockWorker(workerSpec(ctx, 'acquire-once', 'live-claimer', { staleMs: 150, timeoutMs: 2000 }));
        assert.equal(claimer.result.ok, true, `live claimer after recovery failed: ${JSON.stringify(claimer.result)}`);
        assert.equal(claimer.result.fence, 6, 'live claimer must use the next monotonic fence');
        assert.equal(claimer.result.released, true);
        assertNoLockArtifacts(ctx.storeDir);
      } finally {
        for (const worker of workers) {
          worker.kill();
          try {
            fs.writeFileSync(worker.spec.releasePath, '1');
          } catch {
            /* ignore */
          }
        }
      }
    });
  });
  test('13. fail-closed: corrupt / foreign-host / malformed-fence locks are never taken over and inspect is read-only', { timeout: 30_000 }, async () => {
    await withLockFixture(async (ctx) => {
      const store = openStore(ctx.storeDir);
      const failClosedCases = [
        ['corrupt JSON owner record', '{ definitely not json'],
        ['unknown owner record version', JSON.stringify({ ...makeLockOwnerRecord({ canvasId: CANVAS }), version: 99 })],
        ['foreign-host owner record', JSON.stringify(makeLockOwnerRecord({ canvasId: CANVAS, hostname: 'other-host.invalid' }))],
        ['invalid owner pid', JSON.stringify({ ...makeLockOwnerRecord({ canvasId: CANVAS }), pid: -1 })],
      ];
      for (const [label, raw] of failClosedCases) {
        writeRawLockFile(ctx.storeDir, CANVAS, raw);
        const bytesBefore = fs.readFileSync(lockFilePath(ctx.storeDir, CANVAS), 'utf8');
        const inspected = inspectCanvasLock(ctx.storeDir, CANVAS);
        assert.equal(inspected.exists, true, `${label}: lock must still exist`);
        assert.ok(typeof inspected.unverifiable === 'string', `${label}: inspect must report unverifiable`);
        assert.equal(fs.readFileSync(lockFilePath(ctx.storeDir, CANVAS), 'utf8'), bytesBefore, `${label}: inspect must never mutate`);
        let caught = null;
        try {
          store.acquireCanvasLock(CANVAS, { timeoutMs: 150, staleMs: 50 });
        } catch (error) {
          caught = error;
        }
        assert.ok(caught, `${label}: acquisition must fail closed`);
        assert.equal(caught.code, ERROR.LOCK_UNVERIFIABLE, `${label}: expected CANVAS_LOCK_UNVERIFIABLE, got ${caught.code}`);
        assert.equal(fs.readFileSync(lockFilePath(ctx.storeDir, CANVAS), 'utf8'), bytesBefore, `${label}: fail-closed acquire must not touch the record`);
      }

      // A malformed fence file is also fail-closed even with a valid owner record.
      fs.unlinkSync(lockFilePath(ctx.storeDir, CANVAS));
      const fencePath = path.join(ctx.storeDir, '.locks', `${CANVAS}.fence`);
      fs.writeFileSync(fencePath, '{"version":1,"fence":"many"}\n', 'utf8');
      let fenceError = null;
      try {
        store.acquireCanvasLock(CANVAS, { timeoutMs: 150, staleMs: 50 });
      } catch (error) {
        fenceError = error;
      }
      assert.ok(fenceError, 'malformed fence must fail closed');
      assert.equal(fenceError.code, ERROR.LOCK_UNVERIFIABLE);
      assert.equal(fs.existsSync(lockFilePath(ctx.storeDir, CANVAS)), false, 'fail-closed fence path must not leave a lock behind');

      // A legacy empty-directory lock is unverifiable and is never removed or taken over.
      fs.rmSync(fencePath, { force: true });
      fs.mkdirSync(lockFilePath(ctx.storeDir, CANVAS));
      let legacyError = null;
      try {
        store.acquireCanvasLock(CANVAS, { timeoutMs: 150, staleMs: 50 });
      } catch (error) {
        legacyError = error;
      }
      assert.ok(legacyError, 'legacy empty-directory lock must fail closed');
      assert.equal(legacyError.code, ERROR.LOCK_UNVERIFIABLE);
      assert.equal(fs.statSync(lockFilePath(ctx.storeDir, CANVAS)).isDirectory(), true, 'legacy lock must not be removed');
      fs.rmSync(lockFilePath(ctx.storeDir, CANVAS), { recursive: true, force: true });
      assertNoLockArtifacts(ctx.storeDir);
    });
  });
});
