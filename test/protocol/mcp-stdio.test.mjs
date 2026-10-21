// Protocol suite: real child process, real newline-delimited JSON-RPC over stdio.
// No protocol mocks anywhere in this file.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { SERVER_ENTRY, SERVER_NAME, SERVER_VERSION, PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS, TOOL_NAMES, READ_TOOL_NAMES, WRITE_TOOL_NAMES } from '../helpers/paths.mjs';
import { createFixtureStore, makeCanvasState, makeNode, makeEdge, readCanvasState, FIXTURE_NOW } from '../helpers/fixture-store.mjs';
import { createAuthFixture, standardPrincipalSpecs, FIXTURE_TOKENS } from '../helpers/auth-config.mjs';
import { startServerClient, runNode } from '../helpers/spawn-server.mjs';
import { sleep } from '../helpers/rpc-client.mjs';
import { parseToolContent, expectToolOk, expectToolError, callTool, assertStructuredMirrorsContent } from '../helpers/mcp-tool.mjs';
import { assertSchemaSubset, requiredOf, propertyNames } from '../helpers/schema-subset.mjs';

const WRITE_TOOL_OPTIONALS = ['expectedRevision', 'operationId'];
const MUTABLE_DATA_FIELDS = ['content', 'duration', 'errorMessage', 'height', 'label', 'mimeType', 'prompt', 'source', 'status', 'url', 'width'];
const NODE_KINDS = ['text', 'image', 'video', 'audio', 'note'];
const WRITE_RESULT_KEYS = ['ok', 'tool', 'permission', 'server', 'principalId', 'agentId', 'operationId', 'kind', 'replayed', 'payloadHash', 'revision', 'result'];

function isErrorCode(value, codes) {
  return codes.includes(value);
}

async function freshServer({ token = FIXTURE_TOKENS.writerA, canvases, principalCanvasIds = ['canvas-fixture-a', 'canvas-fixture-b'], clientOptions = {} } = {}) {
  const store = createFixtureStore(canvases ? { canvases } : undefined);
  const auth = createAuthFixture(store.root, standardPrincipalSpecs({ canvasIds: principalCanvasIds }));
  const handle = await startServerClient({
    store: store.storeDir,
    auth: auth.authPath,
    token,
    ...clientOptions,
  });
  return {
    store,
    auth,
    handle,
    async close() {
      await handle.cleanup();
      store.cleanup();
    },
  };
}

describe('MCP protocol over stdio (real child process)', () => {
  let shared;

  before(async () => {
    shared = await freshServer();
  });

  after(async () => {
    if (shared) await shared.close();
  });

  describe('initialize handshake', () => {
    test('initialize advertises the the documented contract serverInfo, capabilities and default protocolVersion', () => {
      const init = shared.handle.initializeResult;
      assert.equal(init.protocolVersion, PROTOCOL_VERSION);
      assert.deepEqual(init.capabilities, { tools: { listChanged: false } });
      assert.deepEqual(init.serverInfo, { name: SERVER_NAME, version: SERVER_VERSION });
    });

    test('initialize echoes every supported protocol version and defaults for unknown/missing ones', async () => {
      for (const version of SUPPORTED_PROTOCOL_VERSIONS) {
        const s = await freshServer({ clientOptions: { protocolVersion: version } });
        try {
          assert.equal(s.handle.initializeResult.protocolVersion, version, `expected echo of ${version}`);
        } finally {
          await s.close();
        }
      }
      for (const version of ['1999-01-01', undefined]) {
        const clientOptions = version === undefined ? {} : { protocolVersion: version };
        const s = await freshServer({ clientOptions });
        try {
          assert.equal(s.handle.initializeResult.protocolVersion, PROTOCOL_VERSION, `expected default 2025-11-25 for ${String(version)}`);
        } finally {
          await s.close();
        }
      }
    });

    test('notifications/initialized produces no response', async () => {
      const s = await freshServer();
      try {
        const beforeCount = s.handle.client.messages.length;
        s.handle.client.notify('notifications/initialized', {});
        await sleep(200);
        assert.equal(s.handle.client.messages.length, beforeCount, 'server must not respond to notifications/initialized');
        assert.deepEqual(await s.handle.request('ping'), {});
      } finally {
        await s.close();
      }
    });

    test('notifications/cancelled is accepted and ignored safely', async () => {
      const s = await freshServer();
      try {
        const beforeCount = s.handle.client.messages.length;
        s.handle.client.notify('notifications/cancelled', { requestId: 1, reason: 'test cancellation' });
        await sleep(200);
        assert.equal(s.handle.client.messages.length, beforeCount, 'server must not respond to notifications/cancelled');
        assert.deepEqual(await s.handle.request('ping'), {});
      } finally {
        await s.close();
      }
    });

    test('ping returns an empty object', async () => {
      assert.deepEqual(await shared.handle.request('ping'), {});
    });
  });

  describe('tools/list discovery', () => {
    let tools;

    before(async () => {
      const result = await shared.handle.request('tools/list');
      assert.ok(Array.isArray(result.tools), 'tools/list must return a tools array');
      tools = result.tools;
    });

    test('lists exactly the 9 whitelisted tools in the documented contract order', () => {
      assert.deepEqual(tools.map((t) => t.name), TOOL_NAMES);
    });

    test('every tool has name/title/description/inputSchema and a subset-compliant schema', () => {
      for (const tool of tools) {
        assert.equal(typeof tool.name, 'string');
        assert.equal(typeof tool.title, 'string', `${tool.name}: title must be a string per the documented contract`);
        assert.equal(typeof tool.description, 'string', `${tool.name}: description must be a string`);
        assert.ok(tool.description.length > 0, `${tool.name}: description must not be empty`);
        assert.equal(typeof tool.inputSchema, 'object');
        assertSchemaSubset(tool.inputSchema, `tools.${tool.name}.inputSchema`);
      }
    });

    test('input schemas match the exact the documented contract argument contracts', () => {
      const byName = new Map(tools.map((t) => [t.name, t.inputSchema]));

      const listCanvases = byName.get('canvas_list_canvases');
      assert.deepEqual(requiredOf(listCanvases), []);
      assert.deepEqual(propertyNames(listCanvases), []);

      const readCanvas = byName.get('canvas_read_canvas');
      assert.deepEqual(requiredOf(readCanvas), ['canvasId']);
      assert.deepEqual(propertyNames(readCanvas), ['canvasId']);

      const readNode = byName.get('canvas_read_node');
      assert.deepEqual(requiredOf(readNode), ['canvasId', 'nodeId']);
      assert.deepEqual(propertyNames(readNode), ['canvasId', 'nodeId']);

      const readReceipt = byName.get('canvas_read_receipt');
      assert.deepEqual(requiredOf(readReceipt), ['canvasId', 'operationId']);
      assert.deepEqual(propertyNames(readReceipt), ['canvasId', 'operationId']);

      const listReceipts = byName.get('canvas_list_receipts');
      assert.deepEqual(requiredOf(listReceipts), ['canvasId']);
      assert.deepEqual(propertyNames(listReceipts), ['canvasId', 'limit']);
      assert.equal(listReceipts.properties.limit.type, 'integer');
      assert.equal(listReceipts.properties.limit.default, 20);

      const createNode = byName.get('canvas_create_node');
      assert.deepEqual(requiredOf(createNode), ['canvasId', 'kind', 'label']);
      assert.deepEqual(
        propertyNames(createNode),
        ['canvasId', 'data', 'expectedRevision', 'kind', 'label', 'nodeId', 'operationId', 'position'].sort(),
      );
      assert.equal(createNode.properties.kind.type, 'string');
      assert.deepEqual([...createNode.properties.kind.enum].sort(), [...NODE_KINDS].sort());
      assert.equal(createNode.properties.data.type, 'object');
      assert.equal(createNode.properties.data.additionalProperties, false);
      // the documented contract mutable fields must all be declared. The protected fields may also be declared
      // in the schema (so the domain can return the the documented contract CANVAS_NODE_FIELD_PROTECTED error
      // instead of a generic schema error), but nothing else may be accepted.
      const dataProperties = Object.keys(createNode.properties.data.properties);
      for (const field of MUTABLE_DATA_FIELDS) {
        assert.ok(dataProperties.includes(field), `data schema missing mutable field ${field}`);
      }
      const PROTECTED_DATA_FIELDS = ['nodeType', 'assetId', 'stateId', 'id', 'type'];
      for (const field of dataProperties) {
        assert.ok(
          MUTABLE_DATA_FIELDS.includes(field) || PROTECTED_DATA_FIELDS.includes(field),
          `data schema must not declare arbitrary field "${field}"`,
        );
      }
      assert.equal(createNode.properties.position.type, 'object');
      assert.equal(createNode.properties.position.additionalProperties, false);
      assert.deepEqual(requiredOf(createNode.properties.position), ['x', 'y']);
      assert.equal(createNode.properties.position.properties.x.type, 'number');
      assert.equal(createNode.properties.position.properties.y.type, 'number');

      const patchNode = byName.get('canvas_patch_node');
      assert.deepEqual(requiredOf(patchNode), ['canvasId', 'nodeId']);
      assert.deepEqual(
        propertyNames(patchNode),
        ['canvasId', 'data', 'expectedRevision', 'nodeId', 'operationId', 'position'].sort(),
      );
      assert.equal(patchNode.properties.data.type, 'object');
      assert.equal(patchNode.properties.data.additionalProperties, false);
      for (const field of MUTABLE_DATA_FIELDS) {
        assert.ok(field in patchNode.properties.data.properties, `patch data schema missing mutable field ${field}`);
      }

      const connectNodes = byName.get('canvas_connect_nodes');
      assert.deepEqual(requiredOf(connectNodes), ['canvasId', 'source', 'target']);
      assert.deepEqual(
        propertyNames(connectNodes),
        ['canvasId', 'edgeId', 'expectedRevision', 'operationId', 'relation', 'source', 'target'].sort(),
      );
      assert.equal(connectNodes.properties.relation.type, 'string');
      // Relation validity is capability-dependent, so the schema only annotates the default;
      // the domain must enforce CANVAS_EDGE_RELATION_INVALID at call time (tested elsewhere).
      assert.equal(connectNodes.properties.relation.default, 'reference');
      assert.equal(connectNodes.properties.edgeId.type, 'string');

      const commitBatch = byName.get('canvas_commit_batch');
      assert.deepEqual(requiredOf(commitBatch), ['actions', 'canvasId']);
      assert.deepEqual(propertyNames(commitBatch), ['actions', 'canvasId', 'expectedRevision', 'operationId'].sort());
      assert.equal(commitBatch.properties.actions.type, 'array');

      for (const name of WRITE_TOOL_NAMES) {
        const schema = byName.get(name);
        for (const optional of WRITE_TOOL_OPTIONALS) {
          assert.ok(schema.properties[optional], `${name}: missing optional arg ${optional}`);
          if (optional === 'expectedRevision') assert.equal(schema.properties[optional].type, 'integer', `${name}: expectedRevision must be integer`);
        }
        assert.equal(schema.properties.operationId.type, 'string', `${name}: operationId must be string`);
      }
      for (const name of READ_TOOL_NAMES) {
        const schema = byName.get(name);
        assert.equal(schema.properties.expectedRevision, undefined, `${name}: READ tool must not accept expectedRevision`);
      }
    });
  });

  describe('tools/call read tools', () => {
    test('canvas_list_canvases returns the in-scope canvases sorted by canvasId', async () => {
      const raw = await callTool(shared.handle.client, 'canvas_list_canvases', {});
      const payload = assertStructuredMirrorsContent(raw);
      assert.equal(payload.ok, true);
      assert.equal(payload.tool, 'canvas_list_canvases');
      assert.equal(payload.permission, 'READ');
      assert.equal(payload.server, SERVER_NAME);
      assert.equal(payload.principalId, 'agent-writer-a');
      assert.equal(payload.agentId, 'agent-writer-a');
      assert.deepEqual(payload.canvases, [
        { canvasId: 'canvas-fixture-a', name: 'Fixture canvas A', revision: 0, nodeCount: 3, edgeCount: 1, updatedAt: FIXTURE_NOW },
        { canvasId: 'canvas-fixture-b', name: 'Fixture canvas B', revision: 0, nodeCount: 1, edgeCount: 0, updatedAt: FIXTURE_NOW },
      ]);
    });

    test('canvas_read_canvas returns the fictional fixture nodes and edges exactly', async () => {
      const raw = await callTool(shared.handle.client, 'canvas_read_canvas', { canvasId: 'canvas-fixture-a' });
      const payload = assertStructuredMirrorsContent(raw);
      assert.equal(payload.ok, true);
      assert.equal(payload.tool, 'canvas_read_canvas');
      assert.equal(payload.permission, 'READ');
      assert.equal(payload.server, SERVER_NAME);
      assert.equal(payload.principalId, 'agent-writer-a');
      assert.equal(payload.agentId, 'agent-writer-a');
      assert.equal(payload.canvasId, 'canvas-fixture-a');
      assert.equal(payload.name, 'Fixture canvas A');
      assert.equal(payload.revision, 0);
      assert.equal(payload.updatedAt, FIXTURE_NOW);
      assert.deepEqual(payload.nodes, [
        { id: 'node-text-1', type: 'text', position: { x: 0, y: 0 }, data: { nodeType: 'text', label: 'Fixture text', content: 'Hello fixture', status: 'idle' } },
        {
          id: 'node-image-1',
          type: 'image',
          position: { x: 0, y: 0 },
          data: { nodeType: 'image', label: 'Fixture image', url: 'https://example.com/fixture-image.png', mimeType: 'image/png' },
        },
        { id: 'node-video-1', type: 'video', position: { x: 0, y: 0 }, data: { nodeType: 'video', label: 'Fixture video', status: 'idle' } },
      ]);
      assert.deepEqual(payload.edges, [
        { id: 'edge-image-video', source: 'node-image-1', target: 'node-video-1', relation: 'reference' },
      ]);
    });

    test('canvas_read_node returns one node; missing node is CANVAS_NODE_NOT_FOUND', async () => {
      const raw = await callTool(shared.handle.client, 'canvas_read_node', { canvasId: 'canvas-fixture-a', nodeId: 'node-text-1' });
      const payload = assertStructuredMirrorsContent(raw);
      assert.equal(payload.ok, true);
      assert.equal(payload.permission, 'READ');
      assert.equal(payload.canvasId, 'canvas-fixture-a');
      assert.equal(payload.revision, 0);
      assert.deepEqual(payload.node, {
        id: 'node-text-1',
        type: 'text',
        position: { x: 0, y: 0 },
        data: { nodeType: 'text', label: 'Fixture text', content: 'Hello fixture', status: 'idle' },
      });
      expectToolError(await callTool(shared.handle.client, 'canvas_read_node', { canvasId: 'canvas-fixture-a', nodeId: 'node-missing' }), 'CANVAS_NODE_NOT_FOUND');
    });

    test('canvas_read_receipt on a fresh canvas is CANVAS_RECEIPT_NOT_FOUND', async () => {
      expectToolError(
        await callTool(shared.handle.client, 'canvas_read_receipt', { canvasId: 'canvas-fixture-a', operationId: 'op-does-not-exist' }),
        'CANVAS_RECEIPT_NOT_FOUND',
      );
    });

    test('canvas_list_receipts on a fresh canvas is an empty array', async () => {
      const raw = await callTool(shared.handle.client, 'canvas_list_receipts', { canvasId: 'canvas-fixture-a' });
      const payload = expectToolOk(raw);
      assert.equal(payload.permission, 'READ');
      assert.deepEqual(payload.receipts, []);
    });
  });

  describe('tools/call write tools', () => {
    test('canvas_create_node persists the node and returns the exact the documented contract write result shape', async () => {
      const s = await freshServer();
      try {
        const raw = await callTool(s.handle.client, 'canvas_create_node', {
          canvasId: 'canvas-fixture-a',
          kind: 'note',
          label: 'Protocol note',
          nodeId: 'node-protocol-1',
        });
        const payload = assertStructuredMirrorsContent(raw);
        for (const key of WRITE_RESULT_KEYS) assert.ok(key in payload, `write result missing key ${key}`);
        assert.equal(payload.ok, true);
        assert.equal(payload.tool, 'canvas_create_node');
        assert.equal(payload.permission, 'WRITE');
        assert.equal(payload.server, SERVER_NAME);
        assert.equal(payload.principalId, 'agent-writer-a');
        assert.equal(payload.agentId, 'agent-writer-a');
        assert.match(payload.operationId, /^op-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, 'operationId must be a generated UUID v4 with op- prefix');
        assert.equal(payload.kind, 'canvas.batch');
        assert.equal(payload.replayed, false);
        assert.match(payload.payloadHash, /^[0-9a-f]{64}$/);
        assert.equal(payload.revision, 1);
        assert.equal(payload.actionKind, 'node.create');
        assert.equal(payload.nodeId, 'node-protocol-1');
        assert.equal(payload.result.canvasId, 'canvas-fixture-a');
        assert.equal(payload.result.revision, 1);

        const state = readCanvasState(s.store.storeDir, 'canvas-fixture-a');
        assert.equal(state.revision, 1);
        assert.equal(state.data.nodes.length, 4);
        assert.deepEqual(state.data.nodes[3], {
          id: 'node-protocol-1',
          type: 'note',
          position: { x: 0, y: 0 },
          data: { nodeType: 'note', label: 'Protocol note' },
        });
        assert.ok(state.receipts[payload.operationId], 'receipt must be stored in the same state file');
        assert.equal(state.receipts[payload.operationId].resultingRevision, 1);
      } finally {
        await s.close();
      }
    });

    test('canvas_patch_node shallow-merges data, preserves other fields and bumps revision', async () => {
      const s = await freshServer();
      try {
        const raw = await callTool(s.handle.client, 'canvas_patch_node', {
          canvasId: 'canvas-fixture-a',
          nodeId: 'node-text-1',
          data: { content: 'patched content' },
        });
        const payload = expectToolOk(raw);
        assert.equal(payload.permission, 'WRITE');
        assert.equal(payload.tool, 'canvas_patch_node');
        assert.equal(payload.revision, 1);
        assert.equal(payload.actionKind, 'node.patch');
        assert.equal(payload.nodeId, 'node-text-1');
        const state = readCanvasState(s.store.storeDir, 'canvas-fixture-a');
        assert.equal(state.revision, 1);
        const node = state.data.nodes.find((n) => n.id === 'node-text-1');
        assert.deepEqual(node.data, { nodeType: 'text', label: 'Fixture text', content: 'patched content', status: 'idle' });
      } finally {
        await s.close();
      }
    });

    test('canvas_connect_nodes persists the edge with relation reference by default', async () => {
      const canvases = [
        makeCanvasState({
          canvasId: 'canvas-fixture-a',
          nodes: [makeNode('image', 'node-image-1'), makeNode('video', 'node-video-1')],
          edges: [],
        }),
      ];
      const s = await freshServer({ canvases });
      try {
        const raw = await callTool(s.handle.client, 'canvas_connect_nodes', {
          canvasId: 'canvas-fixture-a',
          source: 'node-image-1',
          target: 'node-video-1',
          edgeId: 'edge-protocol-1',
        });
        const payload = expectToolOk(raw);
        assert.equal(payload.permission, 'WRITE');
        assert.equal(payload.tool, 'canvas_connect_nodes');
        assert.equal(payload.revision, 1);
        assert.equal(payload.actionKind, 'edge.connect');
        assert.equal(payload.edgeId, 'edge-protocol-1');
        const state = readCanvasState(s.store.storeDir, 'canvas-fixture-a');
        assert.deepEqual(state.data.edges, [
          { id: 'edge-protocol-1', source: 'node-image-1', target: 'node-video-1', relation: 'reference' },
        ]);
      } finally {
        await s.close();
      }
    });

    test('canvas_commit_batch applies a node.patch action and reports actionKinds', async () => {
      const s = await freshServer();
      try {
        const raw = await callTool(s.handle.client, 'canvas_commit_batch', {
          canvasId: 'canvas-fixture-a',
          actions: [
            {
              kind: 'node.patch',
              nodeId: 'node-text-1',
              patch: { data: { label: 'Batch patched label' } },
            },
          ],
        });
        const payload = assertStructuredMirrorsContent(raw);
        assert.equal(payload.ok, true);
        assert.equal(payload.permission, 'WRITE');
        assert.equal(payload.tool, 'canvas_commit_batch');
        assert.deepEqual(payload.actionKinds, ['node.patch']);
        assert.equal(payload.revision, 1);
        const state = readCanvasState(s.store.storeDir, 'canvas-fixture-a');
        assert.equal(state.revision, 1);
        assert.equal(state.data.nodes.find((n) => n.id === 'node-text-1').data.label, 'Batch patched label');
      } finally {
        await s.close();
      }
    });

    test('duplicate node id is rejected with CANVAS_NODE_ID_CONFLICT and writes nothing', async () => {
      const s = await freshServer();
      try {
        const result = await callTool(s.handle.client, 'canvas_create_node', {
          canvasId: 'canvas-fixture-a',
          kind: 'text',
          label: 'Collision',
          nodeId: 'node-text-1',
        });
        expectToolError(result, 'CANVAS_NODE_ID_CONFLICT');
        const state = readCanvasState(s.store.storeDir, 'canvas-fixture-a');
        assert.equal(state.revision, 0);
        assert.equal(state.data.nodes.length, 3);
      } finally {
        await s.close();
      }
    });

    test('protected data field is rejected (never silently persisted)', async () => {
      const s = await freshServer();
      try {
        const result = await callTool(s.handle.client, 'canvas_create_node', {
          canvasId: 'canvas-fixture-a',
          kind: 'text',
          label: 'Protected attempt',
          nodeId: 'node-protected-1',
          data: { nodeType: 'text' },
        });
        expectToolError(result, null, { allowedCodes: ['CANVAS_ARGUMENTS_INVALID', 'CANVAS_NODE_FIELD_PROTECTED'] });
        const state = readCanvasState(s.store.storeDir, 'canvas-fixture-a');
        assert.equal(state.revision, 0);
        assert.equal(state.data.nodes.some((n) => n.id === 'node-protected-1'), false);
      } finally {
        await s.close();
      }
    });

    test('unknown argument is rejected by the strict schema and writes nothing', async () => {
      const s = await freshServer();
      try {
        const result = await callTool(s.handle.client, 'canvas_create_node', {
          canvasId: 'canvas-fixture-a',
          kind: 'text',
          label: 'Unknown arg',
          nodeId: 'node-unknown-arg-1',
          bogus: true,
        });
        expectToolError(result, 'CANVAS_ARGUMENTS_INVALID');
        const state = readCanvasState(s.store.storeDir, 'canvas-fixture-a');
        assert.equal(state.revision, 0);
        assert.equal(state.data.nodes.some((n) => n.id === 'node-unknown-arg-1'), false);
      } finally {
        await s.close();
      }
    });
  });

  describe('JSON-RPC error frames', () => {
    test('unknown method returns -32601 Method not found', async () => {
      const response = await shared.handle.client.requestResponse('totally/unknown', {});
      assert.equal(response.error.code, -32601);
      assert.equal(response.error.message, 'Method not found');
      assert.deepEqual(await shared.handle.request('ping'), {});
    });

    test('invalid JSON line returns -32700 with id null and the server keeps serving', async () => {
      shared.handle.client.sendLine('{"jsonrpc": "2.0", "id": 1, "method": "ping"');
      const response = await shared.handle.client.waitForMessage((m) => m.id === null && m.error);
      assert.equal(response.error.code, -32700);
      assert.equal(response.id, null);
      assert.deepEqual(await shared.handle.request('ping'), {});
    });

    test('JSON-RPC batch array is rejected with -32600 id null', async () => {
      shared.handle.client.sendLine('[{"jsonrpc":"2.0","id":1,"method":"ping"}]');
      const response = await shared.handle.client.waitForMessage((m) => m.id === null && m.error && m.error.code === -32600);
      assert.equal(response.error.code, -32600);
      assert.equal(response.id, null);
      assert.deepEqual(await shared.handle.request('ping'), {});
    });

    test('tools/call with missing tool name is a tool-level isError result, not a crash', async () => {
      const response = await shared.handle.client.requestResponse('tools/call', {});
      assert.ok(response.result, `expected a tool-level result, got: ${JSON.stringify(response)}`);
      assert.equal(response.result.isError, true);
      const payload = parseToolContent(response.result);
      assert.equal(payload.ok, false);
      assert.equal(payload.code, 'CANVAS_TOOL_UNKNOWN', `missing tool name must be CANVAS_TOOL_UNKNOWN, got ${payload.code}`);
      assert.deepEqual(await shared.handle.request('ping'), {});
    });

    test('tools/call with invalid arguments is a stable tool-level error (CANVAS_ARGUMENTS_INVALID)', async () => {
      const result = await callTool(shared.handle.client, 'canvas_read_canvas', { canvasId: 42 });
      expectToolError(result, 'CANVAS_ARGUMENTS_INVALID');
      const extra = await callTool(shared.handle.client, 'canvas_read_canvas', { canvasId: 'canvas-fixture-a', bogus: true });
      expectToolError(extra, 'CANVAS_ARGUMENTS_INVALID');
    });
  });

  describe('stdout/stderr discipline and audit logs', () => {
    test('stdout carries only JSON-RPC 2.0 lines (no logs, no stray output)', () => {
      assert.deepEqual(shared.handle.client.invalidLines, [], 'server stdout contained non-JSON lines');
      assert.deepEqual(shared.handle.client.strayLines, [], 'server stdout contained non-object JSON');
      assert.ok(shared.handle.server.stdoutLines.length > 0);
      for (const line of shared.handle.server.stdoutLines) {
        const message = JSON.parse(line);
        assert.equal(message.jsonrpc, '2.0', `stdout line is not JSON-RPC 2.0: ${line.slice(0, 200)}`);
      }
      assert.equal(shared.handle.server.stdoutRaw.includes('server_start'), false, 'audit logs must not go to stdout');
      assert.equal(shared.handle.server.stdoutRaw.includes('"event"'), false, 'audit event logs must not go to stdout');
    });

    test('server_start audit line is JSON on stderr with the documented contract fields', () => {
      const event = shared.handle.startup;
      assert.equal(event.event, 'server_start');
      assert.equal(event.principalId, 'agent-writer-a');
      assert.equal(event.agentId, 'agent-writer-a');
      assert.equal(event.store, shared.store.storeDir);
      assert.equal(event.tools, 9);
      assert.equal(event.version, SERVER_VERSION);
      assert.ok(!Number.isNaN(Date.parse(event.ts)), 'ts must be an ISO timestamp');
    });

    test('every stderr line is a JSON audit object and never contains the token', () => {
      const token = FIXTURE_TOKENS.writerA;
      for (const line of shared.handle.server.stderrLines) {
        const parsed = JSON.parse(line);
        assert.equal(typeof parsed, 'object');
        assert.ok(parsed.event, `stderr JSON line missing event: ${line.slice(0, 200)}`);
        assert.ok(parsed.ts, `stderr JSON line missing ts: ${line.slice(0, 200)}`);
      }
      assert.equal(shared.handle.server.stderrRaw.includes(token), false, 'token must never appear in stderr logs');
      assert.equal(shared.handle.server.stdoutRaw.includes(token), false, 'token must never appear on stdout');
    });

    test('graceful EOF and SIGTERM both exit 0', async () => {
      const eof = await freshServer();
      try {
        const info = await eof.handle.stop();
        assert.equal(info.code, 0, 'EOF shutdown must exit 0');
      } finally {
        await eof.close();
      }
      const store = createFixtureStore();
      const auth = createAuthFixture(store.root, standardPrincipalSpecs());
      const h = await startServerClient({ store: store.storeDir, auth: auth.authPath, token: FIXTURE_TOKENS.writerA });
      try {
        h.server.kill('SIGTERM');
        const info = await h.server.waitExit({ timeoutMs: 10_000 });
        assert.equal(info.code, 0, 'SIGTERM shutdown must exit 0');
      } finally {
        await h.cleanup();
        store.cleanup();
      }
    });
  });

  describe('CLI flags', () => {
    test('--version prints 0.1.0 and exits 0', async () => {
      const run = await runNode([SERVER_ENTRY, '--version']);
      assert.equal(run.code, 0, run.stderr);
      assert.equal(run.stdout.trim(), SERVER_VERSION);
    });

    test('--help prints usage with --store/--auth and exits 0', async () => {
      const run = await runNode([SERVER_ENTRY, '--help']);
      assert.equal(run.code, 0, run.stderr);
      assert.match(run.stdout, /--store/);
      assert.match(run.stdout, /--auth/);
    });
  });

  describe('audit logging', () => {
    test('tool_call and tool_error events carry the documented fields and a sha256 argsDigest', () => {
      const events = shared.handle.server.stderrLines.map((line) => JSON.parse(line));
      const toolCalls = events.filter((event) => event.event === 'tool_call');
      const toolErrors = events.filter((event) => event.event === 'tool_error');
      assert.ok(toolCalls.length > 0, 'expected tool_call audit events on stderr');
      assert.ok(toolErrors.length > 0, 'expected tool_error audit events on stderr');
      for (const event of toolCalls) {
        assert.equal(typeof event.tool, 'string', 'tool_call events always identify the tool');
      }
      for (const event of [...toolCalls, ...toolErrors]) {
        assert.equal(typeof event.principalId, 'string');
        assert.equal(typeof event.agentId, 'string');
        assert.ok(event.tool === null || typeof event.tool === 'string', 'tool is a name, or null when the name was missing/invalid');
        assert.ok(!Number.isNaN(Date.parse(event.ts)));
        assert.equal(typeof event.ms, 'number');
        assert.match(event.argsDigest, /^[0-9a-f]{64}$/, 'argsDigest must be a sha256 hex digest');
        if (event.event === 'tool_error') assert.equal(typeof event.code, 'string');
      }
      // Audit logs must never contain raw caller content, only digests.
      assert.equal(shared.handle.server.stderrRaw.includes('Protocol note'), false);
      assert.equal(shared.handle.server.stderrRaw.includes('"arguments"'), false);
    });
  });

  describe('receipt listing limits', () => {
    test('canvas_list_receipts validates limit 1..100 and defaults to 20', async () => {
      for (const limit of [0, 101, -1, 1.5, '10']) {
        expectToolError(await callTool(shared.handle.client, 'canvas_list_receipts', { canvasId: 'canvas-fixture-a', limit }), 'CANVAS_ARGUMENTS_INVALID');
      }
      const ok = expectToolOk(await callTool(shared.handle.client, 'canvas_list_receipts', { canvasId: 'canvas-fixture-a', limit: 1 }));
      assert.deepEqual(ok.receipts, []);
    });
  });

  describe('revision resolution when expectedRevision is omitted', () => {
    test('a write without expectedRevision to a missing canvas is CANVAS_REVISION_REQUIRED', async () => {
      const principals = standardPrincipalSpecs({ canvasIds: ['*'] });
      const s = await freshServer({ principalCanvasIds: ['*'], principals });
      try {
        const result = await callTool(s.handle.client, 'canvas_create_node', {
          canvasId: 'canvas-does-not-exist',
          kind: 'text',
          label: 'Missing canvas write',
          nodeId: 'node-missing-canvas-1',
        });
        expectToolError(result, 'CANVAS_REVISION_REQUIRED');
      } finally {
        await s.close();
      }
    });
  });
});
