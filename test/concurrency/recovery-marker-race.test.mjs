// Recovery-marker / recovery-guard multi-process safety suite.
//
// Every scenario uses REAL OS child processes that import the production modules
// (`src/store/lock.js`, `src/store/lock-internals.js`, `src/store/store.js`) and operate on a real
// file-backed store. Ordering is controlled exclusively by barrier files (no random sleeps decide
// the interleaving), so the reported recovery-marker reclaim race is exercised deterministically.
//
// Scenarios:
//   A. two recoverers race a dead recovery marker with a controlled pause: only the guarded
//      recoverer proceeds; the delayed recoverer (which read the dead marker before the pause)
//      performs zero marker renames, leaves the live marker/lock bytes intact and ends BUSY.
//   B. delayed release of a stale marker/guard handle after a legitimate recovery returns false,
//      never removes the new owner's record, and is idempotent.
//   C. repeated deterministic interleavings of two recoverer processes: exactly one recovery right
//      per round, no double owners, no lost marker, no wrongful write; exact store revisions.
//   D. crash recovery: a crashed recovery-marker holder is auto-recovered safely through the guard;
//      a crashed recovery-guard holder fails closed with CANVAS_LOCK_UNVERIFIABLE (manual cleanup),
//      no write, and byte-identical lock/marker/guard records.
//   E. a stale/lost-ownership executor write is rejected with CANVAS_LOCK_OWNERSHIP_LOST and leaves
//      the state file byte-identical.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createFileCanvasStore } from '../../src/store/store.js';
import { inspectCanvasLock } from '../../src/store/lock.js';
import {
  findTempFiles,
  getExitedProcessPid,
  createFixtureStore,
  readCanvasFileRaw,
  readCanvasState,
  readFence,
  rmrf,
  writeFence,
} from '../helpers/fixture-store.mjs';
import {
  barrierPath,
  createRaceDir,
  internals,
  listLockArtifacts,
  listFilesRecursive,
  makeOwnerRecord,
  readJournal,
  readJsonIfExists,
  readRawIfExists,
  runMarkerWorker,
  signalBarrier,
  spawnMarkerWorker,
  tokenStillPresent,
  waitForFile,
  waitForJournal,
  writeOwnerRecord,
  ageFile,
  randomSuffix,
} from '../helpers/marker-race-client.mjs';

const CANVAS = 'canvas-fixture-a';
const ERROR = {
  STORE_BUSY: 'CANVAS_STORE_BUSY',
  LOCK_UNVERIFIABLE: 'CANVAS_LOCK_UNVERIFIABLE',
  LOCK_OWNERSHIP_LOST: 'CANVAS_LOCK_OWNERSHIP_LOST',
};

/** Path bundle for one canvas. */
function lockPaths(storeDir) {
  return {
    locksDir: path.join(storeDir, '.locks'),
    lockPath: path.join(storeDir, '.locks', `${CANVAS}.lock`),
    fencePath: path.join(storeDir, '.locks', `${CANVAS}.fence`),
    markerPath: internals.canvasRecoveryMarkerPath(storeDir, CANVAS),
    guardPath: internals.canvasRecoveryGuardPath(storeDir, CANVAS),
    statePath: path.join(storeDir, 'canvases', `${CANVAS}.json`),
  };
}

/** Fresh fixture store + scratch dir for one test; cleaned up afterwards. */
async function withRaceFixture(fn) {
  const fixture = createFixtureStore();
  const workDir = createRaceDir();
  const barrierDir = path.join(workDir, 'barriers');
  fs.mkdirSync(barrierDir, { recursive: true });
  const journalPath = path.join(workDir, 'journal.ndjson');
  try {
    return await fn({ fixture, storeDir: fixture.storeDir, workDir, barrierDir, journalPath, paths: lockPaths(fixture.storeDir) });
  } finally {
    fixture.cleanup();
    rmrf(workDir);
  }
}

/** Base worker spec for the shared journal/barrier dir of one test. */
function specFor(ctx, role, mode, overrides = {}) {
  return {
    role,
    mode,
    storeDir: ctx.storeDir,
    canvasId: CANVAS,
    journalPath: ctx.journalPath,
    barrierDir: ctx.barrierDir,
    resultPath: path.join(ctx.barrierDir, `result-${role}-${randomSuffix()}.json`),
    timeoutMs: 5000,
    lockTimeoutMs: 5000,
    staleLockMs: 150,
    staleMs: 150,
    ...overrides,
  };
}

/** Write an aged, provably-dead write-lock owner record + matching fence counter. */
async function setupDeadLock(ctx, { fence = 1, ageMs = 5000 } = {}) {
  const record = makeOwnerRecord({
    canvasId: CANVAS,
    pid: await getExitedProcessPid(),
    token: `dead-write-lock-token-${randomSuffix()}`,
    fence,
  });
  writeOwnerRecord(ctx.paths.lockPath, record);
  ageFile(ctx.paths.lockPath, ageMs);
  writeFence(ctx.storeDir, CANVAS, fence);
  return record;
}

/** Write an aged, provably-dead recovery-marker record. */
async function setupDeadMarker(ctx, { ageMs = 5000 } = {}) {
  const record = makeOwnerRecord({
    canvasId: CANVAS,
    pid: await getExitedProcessPid(),
    token: `dead-marker-token-${randomSuffix()}`,
    fence: 0,
  });
  writeOwnerRecord(ctx.paths.markerPath, record);
  ageFile(ctx.paths.markerPath, ageMs);
  return record;
}

/** `.locks` must contain only the persistent `<canvas>.fence` counter at rest. */
function assertOnlyFenceAtRest(storeDir, label = 'store') {
  const entries = listLockArtifacts(storeDir);
  const unexpected = entries.filter((name) => !name.endsWith('.fence'));
  assert.deepEqual(unexpected, [], `${label}: only persistent .fence files may remain, found ${JSON.stringify(unexpected)}`);
  assert.deepEqual(findTempFiles(storeDir), [], `${label}: no state temp files may remain`);
}

/** All worker critical-section intervals from the shared journal. */
function criticalSections(journalPath) {
  const records = readJournal(journalPath);
  const sections = [];
  const open = new Map();
  for (const record of [...records].sort((a, b) => a.t - b.t)) {
    if (record.event === 'cs-enter') open.set(record.pid, record);
    else if (record.event === 'cs-exit') {
      const enter = open.get(record.pid);
      if (!enter) continue;
      sections.push({ pid: record.pid, enterT: enter.t, exitT: record.t });
      open.delete(record.pid);
    }
  }
  return sections;
}

function overlappingSections(journalPath) {
  const sections = criticalSections(journalPath);
  const overlaps = [];
  for (let i = 0; i < sections.length; i += 1) {
    for (let j = i + 1; j < sections.length; j += 1) {
      if (sections[i].enterT < sections[j].exitT && sections[j].enterT < sections[i].exitT) {
        overlaps.push([sections[i].pid, sections[j].pid]);
      }
    }
  }
  return overlaps;
}

describe('Recovery-marker / recovery-guard multi-process safety', () => {
  test('A. controlled two-recoverer dead-marker race: one guarded recovery right; delayed recoverer does 0 marker renames and ends BUSY', { timeout: 90_000 }, async () => {
    await withRaceFixture(async (ctx) => {
      const deadLock = await setupDeadLock(ctx, { fence: 4 });
      await setupDeadMarker(ctx);

      // Delayed recoverer: reads the DEAD marker record, then pauses before any guard/marker claim.
      const delayed = spawnMarkerWorker(
        specFor(ctx, 'delayed', 'read-marker-then-ensure', {
          readyName: 'ready-delayed',
          goName: 'go-delayed',
          timeoutMs: 900,
          staleMs: 50,
        }),
      );
      await waitForFile(barrierPath(ctx.barrierDir, 'ready-delayed'));
      const lockRawBefore = readRawIfExists(ctx.paths.lockPath);

      // Legitimate recoverer under the new protocol: reclaims the dead marker while holding the
      // guard, then holds the new LIVE marker M1 (guard released).
      const recoverer = spawnMarkerWorker(
        specFor(ctx, 'recoverer', 'ensure-hold', {
          readyName: 'ready-marker-held',
          releaseName: 'go-release-marker',
          timeoutMs: 8000,
          staleMs: 50,
        }),
      );
      await waitForFile(barrierPath(ctx.barrierDir, 'ready-marker-held'), 20_000);
      const liveMarkerRaw = readRawIfExists(ctx.paths.markerPath);
      const liveMarker = readJsonIfExists(ctx.paths.markerPath);
      assert.equal(liveMarker?.pid, recoverer.pid, 'the guarded recoverer must own the reclaimed live marker');
      assert.equal(internals.inspectRecoveryMarker(ctx.storeDir, CANVAS).alive, true);
      assert.equal(internals.inspectRecoveryGuard(ctx.storeDir, CANVAS).exists, false, 'guard is released after dead-marker reclaim');
      assert.equal(readRawIfExists(ctx.paths.lockPath), lockRawBefore, 'dead write-lock record untouched so far');

      // Release the delayed recoverer: it must observe the LIVE marker, wait, and fail closed.
      signalBarrier(ctx.barrierDir, 'go-delayed');
      const delayedExit = await delayed.waitExit(30_000);
      const delayedResult = await delayed.result();
      assert.equal(delayedExit.code, 0, `delayed recoverer must exit 0 (BUSY is a normal result), got ${delayedExit.code}`);
      assert.equal(delayedResult.ok, false, `delayed recoverer must not acquire a recovery right: ${JSON.stringify(delayedResult)}`);
      assert.equal(delayedResult.code, ERROR.STORE_BUSY);
      assert.equal(readRawIfExists(ctx.paths.markerPath), liveMarkerRaw, 'live marker bytes must be unchanged by the delayed recoverer');
      assert.equal(readRawIfExists(ctx.paths.lockPath), lockRawBefore, 'live/dead write-lock bytes must be unchanged by the delayed recoverer');
      const delayedJournal = readJournal(ctx.journalPath).filter((record) => record.pid === delayed.pid);
      assert.equal(
        delayedJournal.some((record) => record.event === 'fs-rename' || record.event === 'marker-claimed'),
        false,
        'delayed recoverer performed a marker rename/claim while a live marker was present (the old race!)',
      );
      assert.equal(readJsonIfExists(ctx.paths.markerPath)?.pid, recoverer.pid, 'live marker owner intact');

      // Release the live marker, then a fresh recoverer completes the dead write-lock recovery.
      signalBarrier(ctx.barrierDir, 'go-release-marker');
      await recoverer.waitExit(20_000);
      assert.equal((await recoverer.result()).released, true);
      assert.equal(fs.existsSync(ctx.paths.markerPath), false);

      const writer = spawnMarkerWorker(
        specFor(ctx, 'writer', 'acquire-hold', {
          readyName: 'ready-acquired',
          releaseName: 'go-release-acquired',
          timeoutMs: 8000,
          staleMs: 50,
        }),
      );
      await waitForFile(barrierPath(ctx.barrierDir, 'ready-acquired'), 20_000);
      const acquiredRecord = readJsonIfExists(ctx.paths.lockPath);
      assert.equal(acquiredRecord?.pid, writer.pid, 'recoverer must own the live write-lock record');
      assert.equal(acquiredRecord?.fence, 5, 'recovery must advance the dead generation fence exactly once (4 → 5)');
      signalBarrier(ctx.barrierDir, 'go-release-acquired');
      await writer.waitExit(20_000);
      const writerResult = await writer.result();
      assert.equal(writerResult.ok, true);
      assert.equal(writerResult.fence, 5);
      assert.equal(writerResult.released, true);
      assert.equal(readCanvasState(ctx.storeDir, CANVAS).revision, 0, 'lock-only recovery must not modify canvas state');
      assertOnlyFenceAtRest(ctx.storeDir);
    });
  });

  test('B. delayed old marker/guard handle releases are ownership-checked: new owner records stay intact and release is idempotent', { timeout: 60_000 }, async () => {
    await withRaceFixture(async (ctx) => {
      const deadMarker = await setupDeadMarker(ctx);

      // Legitimate recovery of the dead marker under the guard; the new owner holds the live marker.
      const newOwner = spawnMarkerWorker(
        specFor(ctx, 'new-owner', 'ensure-hold', {
          readyName: 'ready-marker-held',
          releaseName: 'go-release-marker',
          timeoutMs: 8000,
          staleMs: 50,
        }),
      );
      await waitForFile(barrierPath(ctx.barrierDir, 'ready-marker-held'), 20_000);
      const newMarkerRaw = readRawIfExists(ctx.paths.markerPath);
      const newMarker = readJsonIfExists(ctx.paths.markerPath);
      assert.equal(newMarker?.pid, newOwner.pid);
      assert.equal(internals.inspectRecoveryMarker(ctx.storeDir, CANVAS).alive, true);

      // A delayed handle to the OLD (dead) marker record: release must be a no-op.
      const staleMarkerHandle = {
        handleKind: 'marker',
        handle: { token: deadMarker.token, pid: deadMarker.pid, hostname: deadMarker.hostname },
      };
      const staleRelease = await runMarkerWorker(specFor(ctx, 'stale-holder', 'release-handle', staleMarkerHandle));
      assert.equal(staleRelease.result.released, false, 'stale marker handle must never release the new marker');
      assert.equal(readRawIfExists(ctx.paths.markerPath), newMarkerRaw, 'new live marker bytes must stay intact');
      const staleReleaseAgain = await runMarkerWorker(specFor(ctx, 'stale-holder', 'release-handle', staleMarkerHandle));
      assert.equal(staleReleaseAgain.result.released, false, 'stale marker release must stay false (idempotent)');

      signalBarrier(ctx.barrierDir, 'go-release-marker');
      await newOwner.waitExit(20_000);
      assert.equal((await newOwner.result()).released, true, 'the real owner can release its own marker');
      assert.equal(fs.existsSync(ctx.paths.markerPath), false);

      // Same ownership-checked release discipline for the recovery guard itself.
      const guardOwner = spawnMarkerWorker(
        specFor(ctx, 'guard-owner', 'claim-guard-hold', {
          readyName: 'ready-guard-held',
          releaseName: 'go-release-guard',
          timeoutMs: 8000,
        }),
      );
      await waitForFile(barrierPath(ctx.barrierDir, 'ready-guard-held'), 20_000);
      const guardRaw = readRawIfExists(ctx.paths.guardPath);
      const guardRecord = readJsonIfExists(ctx.paths.guardPath);
      assert.equal(guardRecord?.pid, guardOwner.pid, 'live guard owner must be recorded');
      const forgedGuardRelease = await runMarkerWorker(
        specFor(ctx, 'stale-holder', 'release-handle', {
          handleKind: 'guard',
          handle: { token: 'forged-guard-token', pid: process.pid, hostname: os.hostname() },
        }),
      );
      assert.equal(forgedGuardRelease.result.released, false, 'foreign guard handle must never remove the live guard');
      assert.equal(readRawIfExists(ctx.paths.guardPath), guardRaw, 'live guard bytes must stay intact');
      signalBarrier(ctx.barrierDir, 'go-release-guard');
      await guardOwner.waitExit(20_000);
      assert.equal((await guardOwner.result()).released, true);
      assert.equal(fs.existsSync(ctx.paths.guardPath), false);
      assertOnlyFenceAtRest(ctx.storeDir);
    });
  });

  test('C. repeated deterministic interleavings: exactly one recovery right per round, no double owner/lost marker/wrongful write', { timeout: 120_000 }, async () => {
    await withRaceFixture(async (ctx) => {
      const rounds = 6;
      const store = createFileCanvasStore({ dir: ctx.storeDir, lockTimeoutMs: 5000, staleLockMs: 150 });
      let applied = 0;
      for (let round = 0; round < rounds; round += 1) {
        const currentFence = readFence(ctx.storeDir, CANVAS)?.fence ?? 0;
        await setupDeadLock(ctx, { fence: currentFence, ageMs: 5000 });
        await setupDeadMarker(ctx, { ageMs: 5000 });
        const rawBefore = readRawIfExists(ctx.paths.statePath);

        const contenders = ['a', 'b'].map((label) => ({
          label,
          worker: spawnMarkerWorker(
            specFor(ctx, `round-${round}-${label}`, 'store-recover-write-hold', {
              readyName: `ready-writer-${round}-${label}`,
              writeName: `go-write-${round}-${label}`,
              writtenName: `written-${round}-${label}`,
              releaseName: `go-release-${round}-${label}`,
              timeoutMs: 900,
              staleMs: 50,
              nodePrefix: `node-round-${round}-${label}`,
            }),
          ),
        }));
        // Deterministic per-round interleaving: reverse the spawn order on odd rounds.
        const ordered = round % 2 === 0 ? contenders : [...contenders].reverse();

        let winner = null;
        const deadline = Date.now() + 20_000;
        while (winner === null && Date.now() < deadline) {
          for (const contender of ordered) {
            if (fs.existsSync(barrierPath(ctx.barrierDir, contender.worker.spec.readyName))) {
              winner = contender;
              break;
            }
            if (fs.existsSync(barrierPath(ctx.barrierDir, `exited-${contender.worker.spec.role}`))) {
              await contender.worker.waitExit(10_000);
              const failed = await contender.worker.result();
              assert.equal(failed.ok, false, `loser round ${round} must fail: ${JSON.stringify(failed)}`);
              assert.equal(failed.code, ERROR.STORE_BUSY);
            }
          }
          if (winner === null) await new Promise((resolve) => setTimeout(resolve, 5));
        }
        assert.ok(winner, `round ${round}: no contender obtained the recovery right`);
        const loser = ordered.find((contender) => contender !== winner);
        await loser.worker.waitExit(30_000);
        const loserResult = await loser.worker.result();
        assert.equal(loserResult.ok, false, `round ${round}: loser must not write: ${JSON.stringify(loserResult)}`);
        assert.equal(loserResult.code, ERROR.STORE_BUSY, `round ${round}: loser must fail closed with CANVAS_STORE_BUSY`);
        assert.equal(readRawIfExists(ctx.paths.statePath), rawBefore, `round ${round}: loser must not change canvas state`);
        assert.equal(fs.existsSync(ctx.paths.markerPath), false, `round ${round}: winner released the recovery marker`);
        assert.equal(fs.existsSync(ctx.paths.guardPath), false, `round ${round}: winner released the recovery guard`);

        // While the winner holds the write lock (before we let it commit), the live lock record must
        // still belong to it. A failed recoverer may legitimately attempt recovery and may briefly
        // touch recovery sidecars, but it must never remove/move the winner's live write-lock record.
        const winnerLockRaw = readRawIfExists(ctx.paths.lockPath);
        assert.ok(winnerLockRaw, `round ${round}: winner write-lock record must exist while the winner holds it`);
        const winnerLock = JSON.parse(winnerLockRaw);
        assert.equal(winnerLock.pid, winner.worker.pid, `round ${round}: winner write-lock record must still belong to the winner`);
        assert.equal(typeof winnerLock.token, 'string', `round ${round}: winner write-lock token must be a string`);
        assert.equal(winnerLock.fence, currentFence + 1, `round ${round}: winner write-lock fence must match the recovery generation`);

        signalBarrier(ctx.barrierDir, winner.worker.spec.writeName);
        await waitForFile(barrierPath(ctx.barrierDir, winner.worker.spec.writtenName), 20_000);
        signalBarrier(ctx.barrierDir, winner.worker.spec.releaseName);
        await winner.worker.waitExit(20_000);
        const winnerResult = await winner.worker.result();
        assert.equal(winnerResult.ok, true, `round ${round}: winner must write: ${JSON.stringify(winnerResult)}`);
        applied += 1;
        const state = readCanvasState(ctx.storeDir, CANVAS);
        assert.equal(state.revision, applied, `round ${round}: exact revision progression`);
        assert.equal(state.data.nodes.length, 3 + applied, `round ${round}: exact node count`);
        assert.equal(store.readCanvas(CANVAS).lockFence, currentFence + 1, `round ${round}: lockFence must match the recovery generation`);
        // A failed recoverer may LEGITIMATELY attempt recovery: e.g. it can briefly claim the
        // recovery marker after the winner released its recovery sidecars and then be rejected when
        // it re-reads the live write-lock owner. Such an attempt may journal fs-rename/marker events
        // and still be perfectly safe. What must never happen is one of the observable dangers:
        //   * the loser enters the protected write section,
        //   * the loser changes the winner's LIVE write-lock record,
        //   * the loser changes canvas state/revision/receipts,
        //   * critical sections overlap.
        const loserJournal = readJournal(ctx.journalPath).filter((record) => record.pid === loser.worker.pid);
        assert.equal(
          loserJournal.some((record) => ['cs-enter', 'cs-work', 'cs-exit'].includes(record.event)),
          false,
          `round ${round}: the loser entered the protected write critical section`,
        );
        assertOnlyFenceAtRest(ctx.storeDir);
      }
      assert.equal(overlappingSections(ctx.journalPath).length, 0, 'critical sections must never overlap across all rounds');
    });
  });

  test('D1. crash of a recovery-marker holder: the next process recovers safely via the guard and completes the write', { timeout: 90_000 }, async () => {
    await withRaceFixture(async (ctx) => {
      const deadLock = await setupDeadLock(ctx, { fence: 3 });

      const markerHolder = spawnMarkerWorker(
        specFor(ctx, 'crashed-marker-holder', 'crash-marker-holder', {
          readyName: 'ready-crash-marker',
          timeoutMs: 5000,
          staleMs: 50,
        }),
      );
      await waitForFile(barrierPath(ctx.barrierDir, 'ready-crash-marker'), 20_000);
      const markerRecord = readJsonIfExists(ctx.paths.markerPath);
      assert.equal(markerRecord?.pid, markerHolder.pid, 'marker-holder must own a live marker before the crash');
      markerHolder.kill('SIGKILL');
      const exit = await markerHolder.waitExit(20_000);
      assert.equal(exit.signal, 'SIGKILL');
      assert.equal(internals.inspectRecoveryMarker(ctx.storeDir, CANVAS).alive, false, 'crashed marker holder must be provably dead');
      ageFile(ctx.paths.markerPath, 5000); // deterministic age gate (no sleep-based wait)

      const recoverer = await runMarkerWorker(
        specFor(ctx, 'recoverer-writer', 'store-recover-write', { timeoutMs: 8000, staleMs: 50, nodePrefix: 'node-crash-recovery' }),
        30_000,
      );
      assert.equal(recoverer.result.ok, true, `crash recovery writer failed: ${JSON.stringify(recoverer.result)}`);
      assert.equal(recoverer.result.fence, deadLock.fence + 1, 'recovery must advance the dead fence exactly once');
      assert.equal(recoverer.result.revision, 1);
      const state = readCanvasState(ctx.storeDir, CANVAS);
      assert.equal(state.revision, 1);
      assert.equal(state.data.nodes.length, 4);
      assert.equal(state.lockFence, deadLock.fence + 1);
      assert.equal(fs.existsSync(ctx.paths.markerPath), false, 'dead marker reclaimed and released');
      assert.equal(fs.existsSync(ctx.paths.guardPath), false, 'guard released after recovery');
      assertOnlyFenceAtRest(ctx.storeDir);
    });
  });

  test('D2. crash of a recovery-guard holder: CANVAS_LOCK_UNVERIFIABLE fail-closed (manual cleanup), no write, records intact', { timeout: 90_000 }, async () => {
    await withRaceFixture(async (ctx) => {
      await setupDeadLock(ctx, { fence: 2 });
      await setupDeadMarker(ctx); // dead marker aged => next recovery needs the guard

      const guardHolder = spawnMarkerWorker(
        specFor(ctx, 'crashed-guard-holder', 'crash-guard-holder', {
          readyName: 'ready-crash-guard',
          timeoutMs: 5000,
          staleMs: 50,
        }),
      );
      await waitForFile(barrierPath(ctx.barrierDir, 'ready-crash-guard'), 20_000);
      const guardRecord = readJsonIfExists(ctx.paths.guardPath);
      assert.equal(guardRecord?.pid, guardHolder.pid);
      guardHolder.kill('SIGKILL');
      const exit = await guardHolder.waitExit(20_000);
      assert.equal(exit.signal, 'SIGKILL');
      ageFile(ctx.paths.guardPath, 5000); // even an aged dead guard must never be auto-reclaimed

      const snapshots = {
        lock: readRawIfExists(ctx.paths.lockPath),
        marker: readRawIfExists(ctx.paths.markerPath),
        guard: readRawIfExists(ctx.paths.guardPath),
        state: readRawIfExists(ctx.paths.statePath),
      };
      const inspected = internals.inspectRecoveryGuard(ctx.storeDir, CANVAS);
      assert.equal(inspected.exists, true);
      assert.equal(inspected.alive, false);
      assert.equal(inspected.owner.pid, guardHolder.pid);
      assert.equal(inspectCanvasLock(ctx.storeDir, CANVAS).recoveryGuard.alive, false);

      const probe = await runMarkerWorker(specFor(ctx, 'guard-probe', 'guard-probe', { timeoutMs: 400 }));
      assert.equal(probe.result.ok, false, 'guard acquisition must fail closed on a dead guard holder');
      assert.equal(probe.result.code, ERROR.LOCK_UNVERIFIABLE);
      assert.equal(probe.result.detail?.reason, 'GUARD_OWNER_DEAD');
      assert.equal(probe.result.detail?.action, 'MANUAL_OPERATOR_CLEANUP_REQUIRED');
      assert.match(probe.result.detail?.recoveryGuardFile ?? '', new RegExp(`\\.${CANVAS}\\.recovery-guard$`));

      // A real write attempt must also fail closed and write nothing.
      const writer = await runMarkerWorker(specFor(ctx, 'writer', 'store-recover-write', { timeoutMs: 1500, staleMs: 50 }), 30_000);
      assert.equal(writer.result.ok, false, 'write against a dead-guard canvas must fail closed');
      assert.equal(writer.result.code, ERROR.LOCK_UNVERIFIABLE);
      assert.equal(writer.result.detail?.reason, 'GUARD_OWNER_DEAD');
      assert.deepEqual(
        {
          lock: readRawIfExists(ctx.paths.lockPath),
          marker: readRawIfExists(ctx.paths.markerPath),
          guard: readRawIfExists(ctx.paths.guardPath),
          state: readRawIfExists(ctx.paths.statePath),
        },
        snapshots,
        'lock/marker/guard/state bytes must be untouched by a fail-closed attempt',
      );
      assert.equal(readCanvasState(ctx.storeDir, CANVAS).revision, 0);

      // Corrupt and foreign-host guard records are also fail-closed (manual cleanup), never removed.
      fs.writeFileSync(ctx.paths.guardPath, '{not valid json', 'utf8');
      const corruptProbe = await runMarkerWorker(specFor(ctx, 'guard-probe', 'guard-probe', { timeoutMs: 400 }));
      assert.equal(corruptProbe.result.code, ERROR.LOCK_UNVERIFIABLE);
      assert.equal(corruptProbe.result.detail?.reason, 'GUARD_RECORD_INVALID');
      assert.equal(readRawIfExists(ctx.paths.guardPath), '{not valid json', 'corrupt guard must not be removed');

      writeOwnerRecord(
        ctx.paths.guardPath,
        makeOwnerRecord({ canvasId: CANVAS, pid: process.pid, token: 'foreign-guard-token', hostname: 'other-host.invalid' }),
      );
      const foreignGuardRaw = readRawIfExists(ctx.paths.guardPath);
      const foreignProbe = await runMarkerWorker(specFor(ctx, 'guard-probe', 'guard-probe', { timeoutMs: 400 }));
      assert.equal(foreignProbe.result.code, ERROR.LOCK_UNVERIFIABLE);
      assert.equal(foreignProbe.result.detail?.reason, 'GUARD_FOREIGN_HOST');
      assert.equal(readRawIfExists(ctx.paths.guardPath), foreignGuardRaw, 'foreign guard must not be removed');
    });
  });

  test('E. stale/lost-ownership executor write is rejected with CANVAS_LOCK_OWNERSHIP_LOST and leaves the state byte-identical', { timeout: 60_000 }, async () => {
    await withRaceFixture(async (ctx) => {
      const store = createFileCanvasStore({ dir: ctx.storeDir, lockTimeoutMs: 5000, staleLockMs: 150 });
      const staleHandle = store.acquireCanvasLock(CANVAS);
      const rawBefore = readCanvasFileRaw(ctx.storeDir, CANVAS);

      // Forced external ownership loss, then a real child process takes over the lock.
      fs.unlinkSync(staleHandle.lockPath);
      const newOwner = spawnMarkerWorker(
        specFor(ctx, 'new-owner', 'acquire-hold', {
          readyName: 'ready-acquired',
          releaseName: 'go-release-acquired',
          timeoutMs: 8000,
          staleMs: 50,
        }),
      );
      await waitForFile(barrierPath(ctx.barrierDir, 'ready-acquired'), 20_000);
      assert.equal(readJsonIfExists(ctx.paths.lockPath)?.pid, newOwner.pid);

      let caught = null;
      try {
        store.updateCanvas(
          CANVAS,
          (current) => ({ value: 'must-not-commit', nextState: { ...current, revision: current.revision + 1 } }),
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
      assert.equal(readCanvasFileRaw(ctx.storeDir, CANVAS), rawBefore, 'rejected write must leave the state file byte-identical');
      const state = readCanvasState(ctx.storeDir, CANVAS);
      assert.equal(state.revision, 0);
      assert.equal(state.data.nodes.length, 3);
      assert.deepEqual(state.receipts, {});
      assert.equal(store.releaseCanvasLock(staleHandle), false, 'stale handle must not release the new owner lock');
      assert.equal(fs.existsSync(ctx.paths.lockPath), true, 'new owner lock must stay intact');

      signalBarrier(ctx.barrierDir, 'go-release-acquired');
      await newOwner.waitExit(20_000);
      assert.equal((await newOwner.result()).released, true);

      // A fresh handle writes normally afterwards.
      store.updateCanvas(CANVAS, (current) => ({
        value: current.revision,
        nextState: { ...current, revision: current.revision + 1 },
      }));
      const finalState = readCanvasState(ctx.storeDir, CANVAS);
      assert.equal(finalState.revision, 1);
      assert.equal(finalState.lockFence, readFence(ctx.storeDir, CANVAS).fence);
      assertOnlyFenceAtRest(ctx.storeDir);
    });
  });
});
