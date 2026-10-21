// Concurrency suite: REAL multi-process CAS races on one shared store.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { readCanvasState } from '../helpers/fixture-store.mjs';
import { FIXTURE_TOKENS } from '../helpers/auth-config.mjs';
import { attachServer, createServerFixture } from '../helpers/server-fixture.mjs';
import { callTool, expectToolOk, parseToolContent } from '../helpers/mcp-tool.mjs';

async function startExtraServers(fixture, count, options = {}) {
  const handles = [];
  for (let i = 0; i < count; i += 1) handles.push(await attachServer(fixture, options));
  return handles;
}

async function stopAll(handles) {
  await Promise.allSettled(handles.map((handle) => handle.cleanup()));
}

describe('multi-process CAS concurrency (real server processes)', () => {
  test('3 processes racing a stale expectedRevision: exactly 1 success + 2 CANVAS_REVISION_CONFLICT, revision +1', async () => {
    const fixture = await createServerFixture();
    const extras = await startExtraServers(fixture, 2);
    const servers = [fixture.handle, ...extras];
    try {
      const results = await Promise.all(
        servers.map((handle, i) =>
          callTool(handle.client, 'canvas_create_node', {
            canvasId: 'canvas-fixture-a',
            kind: 'text',
            label: `Race writer ${i}`,
            nodeId: `node-race-${i}`,
            expectedRevision: 0,
          }),
        ),
      );
      const payloads = results.map((raw) => parseToolContent(raw));
      const successes = payloads.filter((p) => p.ok === true);
      const conflicts = payloads.filter((p) => p.ok === false);
      assert.equal(successes.length, 1, `expected exactly one winner, got payloads: ${JSON.stringify(payloads)}`);
      assert.equal(conflicts.length, 2, `expected two losers, got payloads: ${JSON.stringify(payloads)}`);
      for (const loser of conflicts) {
        assert.equal(loser.code, 'CANVAS_REVISION_CONFLICT');
        assert.equal(loser.detail.expectedRevision, 0, 'conflict detail must report the stale expectedRevision');
        assert.equal(loser.detail.actualRevision, 1, 'conflict detail must report the actual revision');
      }

      const winner = successes[0];
      assert.equal(winner.replayed, false);
      assert.equal(winner.revision, 1);
      const state = readCanvasState(fixture.store.storeDir, 'canvas-fixture-a');
      assert.equal(state.revision, 1, 'exactly one revision increment for the whole race');
      assert.equal(state.data.nodes.length, 4, 'only the winner node may be persisted');
      assert.equal(state.data.nodes.filter((n) => n.id.startsWith('node-race-')).length, 1);
      assert.equal(state.data.nodes.some((n) => n.id === winner.nodeId), true);
      assert.equal(Object.keys(state.receipts).length, 1, 'only the winner may persist a receipt');

      // A loser retries with a fresh revision and must succeed on revision 2.
      const retry = expectToolOk(
        await callTool(servers[1].client, 'canvas_create_node', {
          canvasId: 'canvas-fixture-a',
          kind: 'text',
          label: 'Race retry',
          nodeId: 'node-race-retry',
          expectedRevision: 1,
        }),
      );
      assert.equal(retry.replayed, false);
      assert.equal(retry.revision, 2);
      const finalState = readCanvasState(fixture.store.storeDir, 'canvas-fixture-a');
      assert.equal(finalState.revision, 2);
      assert.equal(finalState.data.nodes.some((n) => n.id === 'node-race-retry'), true);
    } finally {
      await stopAll(extras);
      await fixture.close();
    }
  });

  test('two processes using the SAME operationId concurrently: exactly one applied, the other replayed:true', async () => {
    const fixture = await createServerFixture();
    const extras = await startExtraServers(fixture, 1);
    const servers = [fixture.handle, ...extras];
    try {
      const request = {
        canvasId: 'canvas-fixture-a',
        kind: 'note',
        label: 'Idempotent race node',
        nodeId: 'node-idem-race-1',
        operationId: 'op-idem-race-1',
        expectedRevision: 0,
      };
      const results = await Promise.all(servers.map((handle) => callTool(handle.client, 'canvas_create_node', request)));
      const payloads = results.map((raw) => parseToolContent(raw));
      assert.equal(payloads.every((p) => p.ok === true), true, `both must succeed (one applied, one replayed): ${JSON.stringify(payloads)}`);

      const applied = payloads.filter((p) => p.replayed === false);
      const replayed = payloads.filter((p) => p.replayed === true);
      assert.equal(applied.length, 1, `exactly one request may apply, got: ${JSON.stringify(payloads)}`);
      assert.equal(replayed.length, 1, `exactly one request must replay, got: ${JSON.stringify(payloads)}`);
      assert.equal(applied[0].revision, 1);
      assert.equal(replayed[0].revision, 1, 'replay must not bump the revision');
      assert.equal(applied[0].payloadHash, replayed[0].payloadHash);
      assert.deepEqual(replayed[0].result, applied[0].result, 'replayed result must equal the first result');

      const state = readCanvasState(fixture.store.storeDir, 'canvas-fixture-a');
      assert.equal(state.revision, 1, 'never double-apply the same operationId');
      assert.equal(state.data.nodes.filter((n) => n.id === 'node-idem-race-1').length, 1);
      assert.equal(Object.keys(state.receipts).length, 1);
      assert.equal(state.receipts['op-idem-race-1'].resultingRevision, 1);
    } finally {
      await stopAll(extras);
      await fixture.close();
    }
  });

  test('different canvases written in parallel all succeed without contention', async () => {
    const fixture = await createServerFixture();
    const extra = await attachServer(fixture, { token: FIXTURE_TOKENS.writerB });
    try {
      const [a, b] = await Promise.all([
        callTool(fixture.handle.client, 'canvas_create_node', {
          canvasId: 'canvas-fixture-a',
          kind: 'text',
          label: 'Parallel A',
          nodeId: 'node-parallel-a',
          expectedRevision: 0,
        }),
        callTool(extra.client, 'canvas_create_node', {
          canvasId: 'canvas-fixture-b',
          kind: 'note',
          label: 'Parallel B',
          nodeId: 'node-parallel-b',
          expectedRevision: 0,
        }),
      ]);
      const payloadA = expectToolOk(a);
      const payloadB = expectToolOk(b);
      assert.equal(payloadA.revision, 1);
      assert.equal(payloadB.revision, 1);
      assert.equal(payloadA.result.canvasId, 'canvas-fixture-a');
      assert.equal(payloadB.result.canvasId, 'canvas-fixture-b');
      const stateA = readCanvasState(fixture.store.storeDir, 'canvas-fixture-a');
      const stateB = readCanvasState(fixture.store.storeDir, 'canvas-fixture-b');
      assert.equal(stateA.revision, 1);
      assert.equal(stateB.revision, 1);
      assert.equal(stateA.data.nodes.some((n) => n.id === 'node-parallel-a'), true);
      assert.equal(stateB.data.nodes.some((n) => n.id === 'node-parallel-b'), true);
    } finally {
      await extra.cleanup();
      await fixture.close();
    }
  });

  test('sequential writes converge: three serialized creates yield revision 3 and three receipts', async () => {
    const fixture = await createServerFixture();
    try {
      let revision = 0;
      for (let i = 0; i < 3; i += 1) {
        const payload = expectToolOk(
          await callTool(fixture.client, 'canvas_create_node', {
            canvasId: 'canvas-fixture-a',
            kind: 'text',
            label: `Sequential ${i}`,
            nodeId: `node-sequential-${i}`,
          }),
        );
        revision = payload.revision;
        assert.equal(payload.replayed, false);
      }
      assert.equal(revision, 3);
      const state = readCanvasState(fixture.store.storeDir, 'canvas-fixture-a');
      assert.equal(state.revision, 3);
      assert.equal(state.data.nodes.length, 6);
      assert.equal(Object.keys(state.receipts).length, 3);
    } finally {
      await fixture.close();
    }
  });
});
