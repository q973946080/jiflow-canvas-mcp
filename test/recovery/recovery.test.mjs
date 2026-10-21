// Recovery suite: kill -9, restart, idempotent replay, stale lock, corrupt store,
// and no temp/lock leftovers. Uses real server processes against a real file store.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  createLockFile,
  findTempFiles,
  getExitedProcessPid,
  listLocks,
  lockFilePath,
  readCanvasState,
  readCanvasFileRaw,
  writeRawCanvasFile,
} from '../helpers/fixture-store.mjs';
import { FIXTURE_TOKENS } from '../helpers/auth-config.mjs';
import { attachServer, createServerFixture } from '../helpers/server-fixture.mjs';
import { callTool, expectToolError, expectToolOk } from '../helpers/mcp-tool.mjs';

function assertStoreClean(storeDir) {
  assert.deepEqual(findTempFiles(storeDir), [], 'store must not contain stale .tmp-* files');
  assert.deepEqual(listLocks(storeDir), [], 'store must not contain unreleased lock owner files');
}

describe('crash recovery and durability (real processes, real store)', () => {
  test('kill -9 after a committed write; restart and replay the same operationId', async () => {
    const fixture = await createServerFixture();
    let restarted;
    try {
      const request = {
        canvasId: 'canvas-fixture-a',
        kind: 'text',
        label: 'Crash-safe node',
        nodeId: 'node-crash-1',
        expectedRevision: 0,
        operationId: 'op-crash-replay-1',
      };
      const first = expectToolOk(await callTool(fixture.client, 'canvas_create_node', request));
      assert.equal(first.replayed, false);
      assert.equal(first.revision, 1);
      const stateBeforeKill = readCanvasState(fixture.store.storeDir, 'canvas-fixture-a');
      assert.equal(stateBeforeKill.revision, 1);
      assert.equal(stateBeforeKill.data.nodes.some((n) => n.id === 'node-crash-1'), true);

      const exit = await fixture.handle.server.killAndWait({ signal: 'SIGKILL' });
      assert.equal(exit.code, null, 'SIGKILL terminates without an exit code');
      assert.equal(exit.signal, 'SIGKILL');

      // The atomic-rename store must still be parseable and consistent after kill -9.
      const stateAfterKill = readCanvasState(fixture.store.storeDir, 'canvas-fixture-a');
      assert.equal(stateAfterKill.revision, 1);
      assert.equal(stateAfterKill.data.nodes.length, 4);
      assert.deepEqual(stateAfterKill.receipts, stateBeforeKill.receipts);
      assertStoreClean(fixture.store.storeDir);

      restarted = await attachServer(fixture, { token: FIXTURE_TOKENS.writerA });
      const replay = expectToolOk(await callTool(restarted.client, 'canvas_create_node', request));
      assert.equal(replay.replayed, true, 'replaying a committed operationId must not re-apply');
      assert.equal(replay.operationId, 'op-crash-replay-1');
      assert.equal(replay.revision, 1, 'replay must not bump the revision');
      assert.equal(replay.payloadHash, first.payloadHash);
      assert.deepEqual(replay.result, first.result);

      const finalState = readCanvasState(fixture.store.storeDir, 'canvas-fixture-a');
      assert.equal(finalState.revision, 1);
      assert.equal(finalState.data.nodes.length, 4);
      assert.equal(Object.keys(finalState.receipts).length, 1);
      assertStoreClean(fixture.store.storeDir);

      // The restarted server accepts new work (fresh operationId) and bumps revision.
      const next = expectToolOk(
        await callTool(restarted.client, 'canvas_create_node', {
          canvasId: 'canvas-fixture-a',
          kind: 'note',
          label: 'After restart',
          nodeId: 'node-crash-2',
        }),
      );
      assert.equal(next.replayed, false);
      assert.equal(next.revision, 2);
      assert.equal(readCanvasState(fixture.store.storeDir, 'canvas-fixture-a').revision, 2);
    } finally {
      if (restarted) await restarted.cleanup();
      await fixture.close();
    }
  });

  test('provably dead owner lock (aged past --stale-lock-ms) is recovered and the write succeeds', async () => {
    const fixture = await createServerFixture();
    let staleServer;
    try {
      // Safe protocol: recovery requires a same-host owner that is provably dead (ESRCH)
      // plus the conservative file-age gate. A live owner would never be preempted.
      const deadPid = await getExitedProcessPid();
      createLockFile(fixture.store.storeDir, 'canvas-fixture-a', { pid: deadPid, ageMs: 5000 });
      assert.equal(fs.existsSync(lockFilePath(fixture.store.storeDir, 'canvas-fixture-a')), true);
      staleServer = await attachServer(fixture, { serverOptions: { staleLockMs: 200, lockTimeoutMs: 3000 } });
      const payload = expectToolOk(
        await callTool(staleServer.client, 'canvas_create_node', {
          canvasId: 'canvas-fixture-a',
          kind: 'text',
          label: 'Stale lock write',
          nodeId: 'node-stale-1',
          expectedRevision: 0,
        }),
      );
      assert.equal(payload.revision, 1);
      assert.equal(fs.existsSync(lockFilePath(fixture.store.storeDir, 'canvas-fixture-a')), false, 'recovered lock must be released');
      assertStoreClean(fixture.store.storeDir);
    } finally {
      if (staleServer) await staleServer.cleanup();
      await fixture.close();
    }
  });

  test('a live owner lock makes the write fail with CANVAS_STORE_BUSY and changes nothing', async () => {
    const fixture = await createServerFixture({ serverOptions: { lockTimeoutMs: 400, staleLockMs: 60000 } });
    try {
      // Owner record references a live process (the test runner), so the age gate must not matter.
      createLockFile(fixture.store.storeDir, 'canvas-fixture-a', { pid: process.pid, writeFenceFile: false });
      const request = {
        canvasId: 'canvas-fixture-a',
        kind: 'text',
        label: 'Blocked write',
        nodeId: 'node-blocked-1',
        expectedRevision: 0,
      };
      expectToolError(await callTool(fixture.client, 'canvas_create_node', request), 'CANVAS_STORE_BUSY');
      assert.equal(fs.existsSync(lockFilePath(fixture.store.storeDir, 'canvas-fixture-a')), true, 'a live owner lock must not be stolen');
      const blockedState = readCanvasState(fixture.store.storeDir, 'canvas-fixture-a');
      assert.equal(blockedState.revision, 0);
      assert.equal(blockedState.data.nodes.some((n) => n.id === 'node-blocked-1'), false);
      assert.deepEqual(blockedState.receipts, {});
      assert.deepEqual(findTempFiles(fixture.store.storeDir), []);

      // Releasing the lock lets the same write succeed.
      fs.rmSync(lockFilePath(fixture.store.storeDir, 'canvas-fixture-a'), { force: true });
      const payload = expectToolOk(await callTool(fixture.client, 'canvas_create_node', request));
      assert.equal(payload.revision, 1);
      assertStoreClean(fixture.store.storeDir);
    } finally {
      await fixture.close();
    }
  });

  test('corrupt canvas files are reported as CANVAS_STORE_CORRUPT without crashing or reinitializing', async () => {
    const fixture = await createServerFixture({ token: FIXTURE_TOKENS.reader });
    let restarted;
    try {
      const corruptPath = writeRawCanvasFile(fixture.store.storeDir, 'corrupt-canvas', '{ this is definitely not valid json');
      const corruptBytes = readCanvasFileRaw(fixture.store.storeDir, 'corrupt-canvas');
      expectToolError(await callTool(fixture.client, 'canvas_read_canvas', { canvasId: 'corrupt-canvas' }), 'CANVAS_STORE_CORRUPT');
      assert.deepEqual(await fixture.request('ping'), {}, 'server must keep serving after a corrupt canvas read');

      // A malformed file is skipped by list but valid canvases remain listed.
      const list = expectToolOk(await callTool(fixture.client, 'canvas_list_canvases', {}));
      assert.deepEqual(list.canvases.map((c) => c.canvasId), ['canvas-fixture-a', 'canvas-fixture-b']);

      // Valid canvases are unaffected.
      const valid = expectToolOk(await callTool(fixture.client, 'canvas_read_canvas', { canvasId: 'canvas-fixture-a' }));
      assert.equal(valid.nodes.length, 3);

      // Never silently reinitialize the corrupt file.
      assert.equal(readCanvasFileRaw(fixture.store.storeDir, 'corrupt-canvas'), corruptBytes);
      assert.equal(fs.existsSync(corruptPath), true);

      // Wrong-shape JSON is also CANVAS_STORE_CORRUPT.
      writeRawCanvasFile(fixture.store.storeDir, 'corrupt-shape', '{"storeVersion": 1}');
      expectToolError(await callTool(fixture.client, 'canvas_read_canvas', { canvasId: 'corrupt-shape' }), 'CANVAS_STORE_CORRUPT');

      // A restart with corrupt files present still boots and reports the same stable error.
      await fixture.handle.server.killAndWait({ signal: 'SIGKILL' });
      restarted = await attachServer(fixture, { token: FIXTURE_TOKENS.reader });
      expectToolError(await callTool(restarted.client, 'canvas_read_canvas', { canvasId: 'corrupt-canvas' }), 'CANVAS_STORE_CORRUPT');
      assert.deepEqual(await restarted.request('ping'), {});
    } finally {
      if (restarted) await restarted.cleanup();
      await fixture.close();
    }
  });

  test('no temp files or locks are left after successful writes, rejections and conflicts', async () => {
    const fixture = await createServerFixture();
    try {
      expectToolOk(
        await callTool(fixture.client, 'canvas_create_node', {
          canvasId: 'canvas-fixture-a',
          kind: 'text',
          label: 'Success path',
          nodeId: 'node-clean-1',
          expectedRevision: 0,
        }),
      );
      assertStoreClean(fixture.store.storeDir);

      // Rejected by CAS (stale revision): no temp files, no write.
      expectToolError(
        await callTool(fixture.client, 'canvas_create_node', {
          canvasId: 'canvas-fixture-a',
          kind: 'text',
          label: 'Conflict path',
          nodeId: 'node-clean-2',
          expectedRevision: 0,
        }),
        'CANVAS_REVISION_CONFLICT',
      );
      assertStoreClean(fixture.store.storeDir);

      // Rejected by validation: no temp files, no write.
      expectToolError(
        await callTool(fixture.client, 'canvas_create_node', {
          canvasId: 'canvas-fixture-a',
          kind: 'text',
          label: '',
          nodeId: 'node-clean-3',
        }),
        'CANVAS_NODE_FIELD_INVALID',
      );
      assertStoreClean(fixture.store.storeDir);

      const state = readCanvasState(fixture.store.storeDir, 'canvas-fixture-a');
      assert.equal(state.revision, 1);
      assert.equal(state.data.nodes.length, 4);
      assert.deepEqual(Object.keys(state.receipts).length, 1);
    } finally {
      await fixture.close();
    }
  });
});
