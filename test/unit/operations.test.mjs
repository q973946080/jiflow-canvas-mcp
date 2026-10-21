// Unit suite: operation runtime — CAS, receipts, idempotent replay, conflicts.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { createFileCanvasStore } from '../../src/store/store.js';
import { createOperationExecutor, OperationRegistry } from '../../src/operations/runtime.js';
import { assertTrustedScope, createOperationScope, isTrustedScope } from '../../src/operations/scope.js';
import { createAuthorizer } from '../../src/auth/authorize.js';
import { createCanvasDomain, projectReceipt } from '../../src/canvas/domain.js';
import {
  createTempDir,
  fixtureCanvasState,
  fixtureCanvasStateB,
  makeCanvasState,
  makeEdge,
  makeNode,
  rmrf,
} from '../helpers/fixture-store.mjs';
import { makePrincipal, FIXTURE_TOKENS } from '../helpers/auth-config.mjs';
import { independentHash } from '../helpers/canonical-independent.mjs';

const ERROR = {
  REVISION_CONFLICT: 'CANVAS_REVISION_CONFLICT',
  REVISION_REQUIRED: 'CANVAS_REVISION_REQUIRED',
  OPERATION_REQUEST_INVALID: 'CANVAS_OPERATION_REQUEST_INVALID',
  OPERATION_ID_INVALID: 'CANVAS_OPERATION_ID_INVALID',
  OPERATION_SCOPE_CONFLICT: 'CANVAS_OPERATION_SCOPE_CONFLICT',
  OPERATION_KIND_CONFLICT: 'CANVAS_OPERATION_KIND_CONFLICT',
  OPERATION_PAYLOAD_CONFLICT: 'CANVAS_OPERATION_PAYLOAD_CONFLICT',
  AUTH_DENIED: 'CANVAS_AUTH_DENIED',
  ACTION_NOT_WHITELISTED: 'CANVAS_ACTION_NOT_WHITELISTED',
  NODE_ID_CONFLICT: 'CANVAS_NODE_ID_CONFLICT',
  RECEIPT_NOT_FOUND: 'CANVAS_RECEIPT_NOT_FOUND',
  NODE_NOT_FOUND: 'CANVAS_NODE_NOT_FOUND',
  NODE_ID_CONFLICT: 'CANVAS_NODE_ID_CONFLICT',
  EDGE_ID_CONFLICT: 'CANVAS_EDGE_ID_CONFLICT',
  REVISION_EXHAUSTED: 'CANVAS_REVISION_EXHAUSTED',
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

function envelope(operationId, canvasId, expectedRevision, actions) {
  return { operationId, kind: 'canvas.batch', payload: { canvasId, expectedRevision, actions } };
}

function createNodeAction(id, label, kind = 'text') {
  return { kind: 'node.create', node: { id, type: kind, data: { label } } };
}

function setup({ agentId = 'agent-writer-a', principalOverrides = {}, authorizeOverride = null, canvases = null } = {}) {
  const root = createTempDir('canvas-mcp-ops-unit-');
  const storeDir = path.join(root, 'store');
  fs.mkdirSync(storeDir, { recursive: true });
  const store = createFileCanvasStore({ dir: storeDir, lockTimeoutMs: 1000, staleLockMs: 500 });
  store.init();
  if (canvases !== null) {
    for (const state of canvases) store.writeCanvas(state.canvas.canvasId, state);
  } else {
    store.writeCanvas('canvas-fixture-a', fixtureCanvasState('canvas-fixture-a'));
    store.writeCanvas('canvas-fixture-b', fixtureCanvasStateB('canvas-fixture-b'));
  }
  const principal = makePrincipal({
    principalId: 'agent-writer-a',
    token: 'demo-ops-token',
    mode: 'CANVAS_WRITE',
    canvasIds: ['canvas-fixture-a'],
    ...principalOverrides,
  });
  const authorize = authorizeOverride ?? createAuthorizer({ principal });
  const executor = createOperationExecutor({ store, authorize, principal, agentId });
  return { root, store, principal, authorize, executor, cleanup: () => rmrf(root) };
}

async function withSetup(options, fn) {
  const fixture = setup(options);
  try {
    return await fn(fixture);
  } finally {
    fixture.cleanup();
  }
}

describe('operation runtime: execute, receipt, replay', () => {
  test('executes a batch, persists one receipt and bumps revision exactly once', async () => {
    await withSetup({}, ({ store, executor }) => {
      const request = envelope('op-create-1', 'canvas-fixture-a', 0, [createNodeAction('node-op-1', 'Op node')]);
      const result = executor.execute(request);
      assert.equal(result.ok, true);
      assert.equal(result.replayed, false);
      assert.equal(result.operationId, 'op-create-1');
      assert.equal(result.kind, 'canvas.batch');
      assert.match(result.payloadHash, /^[0-9a-f]{64}$/);
      assert.equal(result.payloadHash, independentHash(request.payload));
      assert.equal(result.revision, 1);
      assert.deepEqual(result.result, { canvasId: 'canvas-fixture-a', revision: 1, nodes: 4, edges: 1 });

      const state = store.readCanvas('canvas-fixture-a');
      assert.equal(state.revision, 1);
      assert.equal(state.data.nodes.length, 4);
      const created = state.data.nodes.find((node) => node.id === 'node-op-1');
      assert.deepEqual(created, {
        id: 'node-op-1',
        type: 'text',
        position: { x: 0, y: 0 },
        data: { label: 'Op node', nodeType: 'text' },
      });

      const receipt = state.receipts['op-create-1'];
      assert.ok(receipt, 'receipt must be persisted with the state');
      assert.equal(receipt.operationId, 'op-create-1');
      assert.equal(receipt.kind, 'canvas.batch');
      assert.equal(receipt.payloadHash, result.payloadHash);
      assert.equal(receipt.scopeHash, independentHash({ principalId: 'agent-writer-a', canvasId: 'canvas-fixture-a' }));
      assert.deepEqual(receipt.scope, { principalId: 'agent-writer-a', canvasId: 'canvas-fixture-a' });
      assert.equal(receipt.expectedRevision, 0);
      assert.equal(receipt.resultingRevision, 1);
      assert.deepEqual(receipt.actionKinds, ['node.create']);
      assert.equal(receipt.principalId, 'agent-writer-a');
      assert.equal(receipt.agentId, 'agent-writer-a');
      assert.ok(!Number.isNaN(Date.parse(receipt.committedAt)));
      assert.equal(typeof receipt.durationMs, 'number');
      assert.ok(receipt.durationMs >= 0);
      assert.deepEqual(receipt.result, result.result);
      assert.equal('token' in receipt, false);
      assert.equal('tokenSha256' in receipt, false);
    });
  });

  test('replaying the same operationId returns the stored result without mutating state', async () => {
    await withSetup({}, ({ store, executor }) => {
      const request = envelope('op-replay-1', 'canvas-fixture-a', 0, [createNodeAction('node-replay-1', 'Replay node')]);
      const first = executor.execute(request);
      const stateAfterFirst = store.readCanvas('canvas-fixture-a');
      const replay = executor.execute(request);
      assert.equal(replay.ok, true);
      assert.equal(replay.replayed, true);
      assert.equal(replay.operationId, 'op-replay-1');
      assert.equal(replay.payloadHash, first.payloadHash);
      assert.equal(replay.revision, 1, 'replay must not bump the revision');
      assert.deepEqual(replay.result, first.result);
      const stateAfterReplay = store.readCanvas('canvas-fixture-a');
      assert.deepEqual(stateAfterReplay, stateAfterFirst, 'replay must not mutate the store');
    });
  });

  test('same operationId with a different payload is CANVAS_OPERATION_PAYLOAD_CONFLICT', async () => {
    await withSetup({}, ({ store, executor }) => {
      const first = envelope('op-conflict-1', 'canvas-fixture-a', 0, [createNodeAction('node-conflict-1', 'First')]);
      executor.execute(first);
      const second = envelope('op-conflict-1', 'canvas-fixture-a', 1, [createNodeAction('node-conflict-1', 'Different payload')]);
      expectCode(() => executor.execute(second), ERROR.OPERATION_PAYLOAD_CONFLICT, 'payload conflict');
      const state = store.readCanvas('canvas-fixture-a');
      assert.equal(state.revision, 1);
      assert.equal(Object.keys(state.receipts).length, 1);
      assert.equal(state.data.nodes.some((node) => node.id === 'node-conflict-1'), true);
      assert.equal(state.data.nodes.some((node) => node.data.label === 'Different payload'), false);
    });
  });

  test('same operationId from a different scope is CANVAS_OPERATION_SCOPE_CONFLICT', async () => {
    await withSetup({}, ({ store, executor }) => {
      const request = envelope('op-scope-1', 'canvas-fixture-a', 0, [createNodeAction('node-scope-1', 'Scope')]);
      executor.execute(request);
      const otherPrincipal = makePrincipal({
        principalId: 'agent-writer-b',
        token: 'demo-ops-other-token',
        mode: 'CANVAS_WRITE',
        canvasIds: ['canvas-fixture-a'],
      });
      const otherExecutor = createOperationExecutor({
        store,
        authorize: createAuthorizer({ principal: otherPrincipal }),
        principal: otherPrincipal,
      });
      expectCode(() => otherExecutor.execute(request), ERROR.OPERATION_SCOPE_CONFLICT, 'scope conflict');
      assert.equal(store.readCanvas('canvas-fixture-a').revision, 1);
    });
  });

  test('an existing receipt with a different kind is CANVAS_OPERATION_KIND_CONFLICT', async () => {
    await withSetup({}, ({ store, executor }) => {
      const request = envelope('op-kind-1', 'canvas-fixture-a', 0, [createNodeAction('node-kind-1', 'Kind')]);
      const scopeHash = independentHash({ principalId: 'agent-writer-a', canvasId: 'canvas-fixture-a' });
      store.updateCanvas('canvas-fixture-a', (current) => ({
        value: null,
        nextState: {
          ...current,
          receipts: {
            ...current.receipts,
            'op-kind-1': {
              operationId: 'op-kind-1',
              kind: 'canvas.other',
              payloadHash: 'f'.repeat(64),
              scopeHash,
            },
          },
        },
      }));
      expectCode(() => executor.execute(request), ERROR.OPERATION_KIND_CONFLICT, 'kind conflict');
      assert.equal(store.readCanvas('canvas-fixture-a').revision, 0);
    });
  });

  test('stale expectedRevision is CANVAS_REVISION_CONFLICT with detail and writes nothing', async () => {
    await withSetup({}, ({ store, executor }) => {
      executor.execute(envelope('op-cas-1', 'canvas-fixture-a', 0, [createNodeAction('node-cas-1', 'First')]));
      const stale = envelope('op-cas-2', 'canvas-fixture-a', 0, [createNodeAction('node-cas-2', 'Stale')]);
      const error = expectCode(() => executor.execute(stale), ERROR.REVISION_CONFLICT, 'stale revision');
      assert.deepEqual(error.detail, { expectedRevision: 0, actualRevision: 1 });
      const state = store.readCanvas('canvas-fixture-a');
      assert.equal(state.revision, 1, 'conflict must not bump the revision');
      assert.equal(state.data.nodes.some((node) => node.id === 'node-cas-2'), false);
      assert.equal(state.receipts['op-cas-2'], undefined, 'conflict must not persist a receipt');
    });
  });

  test('one operation with multiple actions increments revision by exactly 1', async () => {
    await withSetup({}, ({ store, executor }) => {
      const request = envelope('op-multi-1', 'canvas-fixture-a', 0, [
        createNodeAction('node-multi-1', 'Multi one'),
        createNodeAction('node-multi-2', 'Multi two', 'note'),
      ]);
      const result = executor.execute(request);
      assert.equal(result.revision, 1);
      assert.equal(result.result.nodes, 5);
      const state = store.readCanvas('canvas-fixture-a');
      assert.equal(state.revision, 1);
      assert.equal(state.data.nodes.length, 5);
      assert.deepEqual(state.receipts['op-multi-1'].actionKinds, ['node.create', 'node.create']);
    });
  });

  test('rejected operations never persist a receipt or bump the revision', async () => {
    await withSetup({}, ({ store, executor }) => {
      const duplicate = envelope('op-rejected-1', 'canvas-fixture-a', 0, [createNodeAction('node-text-1', 'Duplicate id')]);
      expectCode(() => executor.execute(duplicate), ERROR.NODE_ID_CONFLICT, 'duplicate node id');
      const state = store.readCanvas('canvas-fixture-a');
      assert.equal(state.revision, 0);
      assert.deepEqual(state.receipts, {});
      assert.equal(state.data.nodes.length, 3);
    });
  });

  test('a custom agentId is recorded in the receipt while principalId stays scoped', async () => {
    await withSetup({ agentId: 'custom-agent-label' }, ({ store, executor }) => {
      const result = executor.execute(envelope('op-agent-1', 'canvas-fixture-a', 0, [createNodeAction('node-agent-1', 'Agent')]));
      assert.equal(result.ok, true);
      const receipt = store.readCanvas('canvas-fixture-a').receipts['op-agent-1'];
      assert.equal(receipt.principalId, 'agent-writer-a');
      assert.equal(receipt.agentId, 'custom-agent-label');
    });
  });
});

describe('operation runtime: authorization and envelope validation', () => {
  test('authorization happens before mutation and must return exactly true', async () => {
    await withSetup({ authorizeOverride: () => ({ truthy: true }) }, ({ store, executor }) => {
      expectCode(
        () => executor.execute(envelope('op-auth-1', 'canvas-fixture-a', 0, [createNodeAction('node-auth-1', 'Denied')])),
        ERROR.AUTH_DENIED,
        'truthy non-true authorize result',
      );
      assert.equal(store.readCanvas('canvas-fixture-a').revision, 0);
    });
  });

  test('READ_ONLY principals are denied writes before any store access', async () => {
    const fixture = setup();
    try {
      const readerPrincipal = makePrincipal({
        principalId: 'agent-reader',
        token: 'demo-ops-reader-token',
        mode: 'READ_ONLY',
        canvasIds: ['*'],
      });
      const readerExecutor = createOperationExecutor({
        store: fixture.store,
        authorize: createAuthorizer({ principal: readerPrincipal }),
        principal: readerPrincipal,
      });
      expectCode(
        () => readerExecutor.execute(envelope('op-reader-1', 'canvas-fixture-a', 0, [createNodeAction('node-reader-1', 'Denied')])),
        ERROR.AUTH_DENIED,
        'read-only write',
      );
      assert.equal(fixture.store.readCanvas('canvas-fixture-a').revision, 0);
    } finally {
      fixture.cleanup();
    }
  });

  test('out-of-scope canvases are denied', async () => {
    await withSetup({}, ({ executor }) => {
      expectCode(
        () => executor.execute(envelope('op-scope-denied', 'canvas-fixture-b', 0, [createNodeAction('node-scope-denied', 'Denied')])),
        ERROR.AUTH_DENIED,
        'out of scope canvas',
      );
    });
  });

  test('invalid envelopes are rejected with stable codes', async () => {
    await withSetup({}, ({ executor }) => {
      const good = envelope('op-envelope-1', 'canvas-fixture-a', 0, [createNodeAction('node-envelope-1', 'Envelope')]);
      expectCode(() => executor.execute(null), ERROR.OPERATION_REQUEST_INVALID, 'null envelope');
      expectCode(() => executor.execute({ ...good, extra: 1 }), ERROR.OPERATION_REQUEST_INVALID, 'extra envelope key');
      expectCode(() => executor.execute({ ...good, kind: 'canvas.single' }), ERROR.OPERATION_REQUEST_INVALID, 'wrong kind');
      expectCode(() => executor.execute({ operationId: 'op-x', kind: 'canvas.batch' }), ERROR.OPERATION_REQUEST_INVALID, 'missing payload');
      expectCode(
        () => executor.execute({ ...good, operationId: 'bad/id' }),
        [ERROR.OPERATION_ID_INVALID, ERROR.OPERATION_REQUEST_INVALID],
        'invalid operationId',
      );
      expectCode(
        () => executor.execute({ ...good, operationId: '' }),
        [ERROR.OPERATION_ID_INVALID, ERROR.OPERATION_REQUEST_INVALID],
        'empty operationId',
      );
      expectCode(
        () => executor.execute({ ...good, payload: { canvasId: 'canvas-fixture-a', expectedRevision: '0', actions: [] } }),
        [ERROR.REVISION_REQUIRED, ERROR.OPERATION_REQUEST_INVALID],
        'non-integer revision',
      );
      expectCode(
        () => executor.execute({ ...good, payload: { canvasId: 'canvas-fixture-a', expectedRevision: 0, actions: [] } }),
        ERROR.OPERATION_REQUEST_INVALID,
        'empty actions',
      );
      expectCode(
        () =>
          executor.execute({
            ...good,
            payload: { canvasId: 'canvas-fixture-a', expectedRevision: 0, actions: [{ kind: 'shell.exec', command: 'id' }] },
          }),
        ERROR.ACTION_NOT_WHITELISTED,
        'unwhitelisted action',
      );
      expectCode(
        () => executor.execute({ ...good, payload: { canvasId: '../escape', expectedRevision: 0, actions: [createNodeAction('n1', 'x')] } }),
        'CANVAS_CANVAS_ID_INVALID',
        'bad canvasId',
      );
    });
  });

  test('trusted scopes: created scopes are accepted, forged scopes are denied', async () => {
    await withSetup({}, ({ executor }) => {
      const scope = createOperationScope({ principalId: 'agent-writer-a', canvasId: 'canvas-fixture-a' });
      assert.equal(isTrustedScope(scope), true);
      assert.equal(assertTrustedScope(scope), true);
      const result = executor.execute(scope, envelope('op-trusted-1', 'canvas-fixture-a', 0, [createNodeAction('node-trusted-1', 'Trusted')]));
      assert.equal(result.ok, true);
      assert.equal(result.revision, 1);

      const forged = { principalId: 'agent-writer-a', canvasId: 'canvas-fixture-a' };
      assert.equal(isTrustedScope(forged), false);
      expectCode(() => assertTrustedScope(forged), ERROR.AUTH_DENIED, 'forged scope');
      expectCode(
        () => executor.execute(forged, envelope('op-forged-1', 'canvas-fixture-a', 1, [createNodeAction('node-forged-1', 'Forged')])),
        ERROR.AUTH_DENIED,
        'forged scope through executor',
      );
      const otherScope = createOperationScope({ principalId: 'agent-writer-a', canvasId: 'canvas-fixture-b' });
      expectCode(
        () => executor.execute(otherScope, envelope('op-mismatch-1', 'canvas-fixture-a', 1, [createNodeAction('node-mismatch-1', 'Mismatch')])),
        ERROR.AUTH_DENIED,
        'scope/payload canvas mismatch',
      );
    });
  });

  test('OperationRegistry is pre-populated with the three whitelisted action kinds', () => {
    const registry = new OperationRegistry();
    assert.deepEqual([...registry.kinds()].sort(), ['edge.connect', 'node.create', 'node.patch']);
    for (const kind of registry.kinds()) assert.equal(typeof registry.get(kind), 'function');
  });
});

describe('canvas domain projections (the documented contract read tools)', () => {
  test('list/read projections match the stored fixture and scope-filter', async () => {
    await withSetup({}, ({ store, principal, authorize }) => {
      const domain = createCanvasDomain({ store, authorize, principal });
      const listed = domain.listCanvases(principal);
      assert.deepEqual(listed.map((canvas) => canvas.canvasId), ['canvas-fixture-a']);
      assert.deepEqual(listed[0], {
        canvasId: 'canvas-fixture-a',
        name: 'Fixture canvas A',
        revision: 0,
        nodeCount: 3,
        edgeCount: 1,
        updatedAt: '2026-10-21T00:00:00.000Z',
      });
      const canvas = domain.readCanvas('canvas-fixture-a');
      assert.equal(canvas.canvasId, 'canvas-fixture-a');
      assert.equal(canvas.revision, 0);
      assert.equal(canvas.nodes.length, 3);
      assert.equal(canvas.edges.length, 1);
      const node = domain.readNode('canvas-fixture-a', 'node-text-1');
      assert.equal(node.node.id, 'node-text-1');
      assert.equal(node.revision, 0);
      expectCode(() => domain.readNode('canvas-fixture-a', 'node-missing'), ERROR.NODE_NOT_FOUND, 'missing node');
      expectCode(() => domain.readReceipt('canvas-fixture-a', 'op-missing'), ERROR.RECEIPT_NOT_FOUND, 'missing receipt');
    });
  });

  test('receipts are projected publicly (no durationMs/token) and listed newest first', async () => {
    await withSetup({}, ({ store, principal, authorize, executor }) => {
      const domain = createCanvasDomain({ store, authorize, principal });
      executor.execute(envelope('op-project-1', 'canvas-fixture-a', 0, [createNodeAction('node-project-1', 'Project one')]));
      executor.execute(envelope('op-project-2', 'canvas-fixture-a', 1, [createNodeAction('node-project-2', 'Project two')]));
      const { receipts } = domain.listReceipts('canvas-fixture-a');
      assert.equal(receipts.length, 2);
      assert.deepEqual(receipts.map((receipt) => receipt.operationId), ['op-project-2', 'op-project-1']);
      for (const receipt of receipts) {
        assert.deepEqual(Object.keys(receipt).sort(), [
          'actionKinds',
          'agentId',
          'committedAt',
          'expectedRevision',
          'kind',
          'operationId',
          'payloadHash',
          'principalId',
          'result',
          'resultingRevision',
          'scopeHash',
        ]);
        assert.equal('durationMs' in receipt, false);
        assert.equal('token' in receipt, false);
        assert.equal('tokenSha256' in receipt, false);
      }
      const read = domain.readReceipt('canvas-fixture-a', 'op-project-1');
      assert.equal(read.receipt.operationId, 'op-project-1');
      assert.equal(read.receipt.resultingRevision, 1);
    });
  });

  test('domain.execute writes through the operation runtime', async () => {
    await withSetup({}, ({ store, principal, authorize }) => {
      const domain = createCanvasDomain({ store, authorize, principal });
      const scope = createOperationScope({ principalId: 'agent-writer-a', canvasId: 'canvas-fixture-a' });
      const result = domain.execute(scope, envelope('op-domain-1', 'canvas-fixture-a', 0, [createNodeAction('node-domain-1', 'Domain node')]));
      assert.equal(result.ok, true);
      assert.equal(result.replayed, false);
      assert.equal(store.readCanvas('canvas-fixture-a').revision, 1);
      const projected = projectReceipt(store.readCanvas('canvas-fixture-a').receipts['op-domain-1']);
      assert.equal(projected.operationId, 'op-domain-1');
      assert.equal('durationMs' in projected, false);
    });
  });
});

describe('node id collisions and revision limits', () => {
  test('rejects node ids colliding with canvasId, nodes, edges, tombstones and operationIds', async () => {
    const canvases = [
      makeCanvasState({
        canvasId: 'canvas-fixture-a',
        nodes: [makeNode('text', 'node-text-1', { data: { label: 'Fixture text' } })],
        edges: [],
        tombstones: { nodes: ['node-tombstone'], edges: ['edge-tombstone'] },
      }),
    ];
    const fixture = setup({ canvases });
    try {
      let caseIndex = 0;
      for (const nodeId of ['canvas-fixture-a', 'node-text-1', 'node-tombstone', 'edge-tombstone']) {
        caseIndex += 1;
        expectCode(
          () => fixture.executor.execute(envelope(`op-collision-${caseIndex}`, 'canvas-fixture-a', 0, [createNodeAction(nodeId, 'Collision')])),
          ERROR.NODE_ID_CONFLICT,
          `collision ${nodeId}`,
        );
      }
      // A committed operationId may not be reused as a node id, and neither may the operation's own id.
      fixture.executor.execute(envelope('op-collision-existing', 'canvas-fixture-a', 0, [createNodeAction('node-ok-1', 'Ok')]));
      expectCode(
        () =>
          fixture.executor.execute(
            envelope('op-self-collide', 'canvas-fixture-a', 1, [createNodeAction('op-self-collide', 'Own operationId')]),
          ),
        ERROR.NODE_ID_CONFLICT,
        'own operationId',
      );
      expectCode(
        () =>
          fixture.executor.execute(
            envelope('op-other-1', 'canvas-fixture-a', 1, [createNodeAction('op-collision-existing', 'Previous operationId')]),
          ),
        ERROR.NODE_ID_CONFLICT,
        'previous operationId',
      );
      const state = fixture.store.readCanvas('canvas-fixture-a');
      assert.equal(state.revision, 1);
      assert.equal(state.data.nodes.length, 2);
    } finally {
      fixture.cleanup();
    }
  });

  test('edge ids colliding with existing edges or the same (source,target,relation) are CANVAS_EDGE_ID_CONFLICT', async () => {
    const fixture = setup();
    try {
      const base = {
        kind: 'edge.connect',
        edge: { id: 'edge-new-1', source: 'node-image-1', target: 'node-video-1', relation: 'reference' },
      };
      // The default fixture already has edge-image-video image->video reference.
      expectCode(
        () =>
          fixture.executor.execute(
            envelope('op-edge-dup-id', 'canvas-fixture-a', 0, [
              { kind: 'edge.connect', edge: { ...base.edge } },
            ]),
          ),
        ERROR.EDGE_ID_CONFLICT,
        'duplicate edge triple',
      );
      expectCode(
        () =>
          fixture.executor.execute(
            envelope('op-edge-dup-id2', 'canvas-fixture-a', 0, [
              { kind: 'edge.connect', edge: { id: 'edge-image-video', source: 'node-image-1', target: 'node-video-1', relation: 'reference' } },
            ]),
          ),
        ERROR.EDGE_ID_CONFLICT,
        'duplicate edge id',
      );
      expectCode(
        () =>
          fixture.executor.execute(
            envelope('op-edge-missing', 'canvas-fixture-a', 0, [
              { kind: 'edge.connect', edge: { id: 'edge-missing-endpoint', source: 'node-image-1', target: 'node-missing', relation: 'reference' } },
            ]),
          ),
        ERROR.NODE_NOT_FOUND,
        'missing edge endpoint',
      );
      assert.equal(fixture.store.readCanvas('canvas-fixture-a').revision, 0);
    } finally {
      fixture.cleanup();
    }
  });

  test('node.patch on a missing node is CANVAS_NODE_NOT_FOUND and writes nothing', async () => {
    const fixture = setup();
    try {
      expectCode(
        () =>
          fixture.executor.execute(
            envelope('op-patch-missing', 'canvas-fixture-a', 0, [
              { kind: 'node.patch', nodeId: 'node-missing', patch: { data: { label: 'x' } } },
            ]),
          ),
        ERROR.NODE_NOT_FOUND,
        'patch missing node',
      );
      assert.equal(fixture.store.readCanvas('canvas-fixture-a').revision, 0);
    } finally {
      fixture.cleanup();
    }
  });

  test('revision exhaustion is CANVAS_REVISION_EXHAUSTED and leaves the store untouched', async () => {
    const canvases = [makeCanvasState({ canvasId: 'canvas-fixture-a', revision: Number.MAX_SAFE_INTEGER })];
    const fixture = setup({ canvases });
    try {
      expectCode(
        () =>
          fixture.executor.execute(
            envelope('op-exhausted', 'canvas-fixture-a', Number.MAX_SAFE_INTEGER, [createNodeAction('node-exhausted', 'Exhausted')]),
          ),
        ERROR.REVISION_EXHAUSTED,
        'revision exhaustion',
      );
      const state = fixture.store.readCanvas('canvas-fixture-a');
      assert.equal(state.revision, Number.MAX_SAFE_INTEGER);
      assert.deepEqual(state.receipts, {});
    } finally {
      fixture.cleanup();
    }
  });
});
