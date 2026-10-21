// Security suite: fail-closed startup, scoped token authorization, whitelist bypass,
// path traversal, and no writes outside the store. All checks use real server processes.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { SERVER_ENTRY, TOOL_NAMES } from '../helpers/paths.mjs';
import {
  createFixtureStore,
  createTempDir,
  readCanvasState,
  readCanvasFileRaw,
  listFilesRecursive,
  walkDir,
  rmrf,
} from '../helpers/fixture-store.mjs';
import {
  createAuthFixture,
  standardPrincipalSpecs,
  makePrincipal,
  buildAuthConfig,
  writeAuthConfig,
  tokenSha256,
  FIXTURE_TOKENS,
} from '../helpers/auth-config.mjs';
import { attachServer, createServerFixture, spawnStartupFailure } from '../helpers/server-fixture.mjs';
import { callTool, expectToolError, expectToolOk } from '../helpers/mcp-tool.mjs';

function snapshotTree(dir) {
  return walkDir(dir)
    .map((entry) => `${entry.isDir ? 'd' : 'f'}:${entry.rel}`)
    .sort();
}

function assertStartupFailure({ exit, stderr, stdout }, { expectedExit, expectedCodes, expectedCommand }) {
  assert.equal(exit.code, expectedExit, `expected exit ${expectedExit}, got ${exit.code}\ncommand: ${expectedCommand}\nstderr:\n${stderr}`);
  const accepted = Array.isArray(expectedCodes) ? expectedCodes : [expectedCodes];
  assert.ok(
    accepted.some((code) => stderr.includes(code)),
    `expected stderr to contain one of ${accepted.join(', ')}\ncommand: ${expectedCommand}\nstderr:\n${stderr}`,
  );
  assert.equal(stdout.trim(), '', 'stdout is a protocol channel and must stay empty on startup failure');
  assert.equal(stderr.includes('server_start'), false, 'a failed server must not emit a server_start event');
}

describe('fail-closed startup', () => {
  let root;
  let storeDir;
  let authPath;

  before(() => {
    root = createTempDir('canvas-mcp-startup-');
    storeDir = path.join(root, 'store');
    fs.mkdirSync(path.join(storeDir, 'canvases'), { recursive: true });
    fs.mkdirSync(path.join(storeDir, '.locks'), { recursive: true });
    const fixture = createAuthFixture(root, standardPrincipalSpecs());
    authPath = fixture.authPath;
  });

  after(() => rmrf(root));

  const run = (args, token) => spawnStartupFailure({ args, token });

  test('missing CANVAS_MCP_TOKEN exits 3 with CANVAS_AUTH_REQUIRED', async () => {
    const result = await run(['--store', storeDir, '--auth', authPath], undefined);
    assertStartupFailure(result, { expectedExit: 3, expectedCodes: 'CANVAS_AUTH_REQUIRED', expectedCommand: result.commandLine });
    assert.equal(result.stderr.includes('demo-fixture-writer-a-token'), false);
  });

  test('empty CANVAS_MCP_TOKEN exits 3 with CANVAS_AUTH_REQUIRED', async () => {
    const result = await run(['--store', storeDir, '--auth', authPath], '');
    assertStartupFailure(result, { expectedExit: 3, expectedCodes: 'CANVAS_AUTH_REQUIRED', expectedCommand: result.commandLine });
  });

  test('unknown token exits 3 with CANVAS_PRINCIPAL_UNKNOWN and never echoes the token', async () => {
    const unknown = 'demo-unknown-attacker-token';
    const result = await run(['--store', storeDir, '--auth', authPath], unknown);
    assertStartupFailure(result, { expectedExit: 3, expectedCodes: 'CANVAS_PRINCIPAL_UNKNOWN', expectedCommand: result.commandLine });
    assert.equal(result.stderr.includes(unknown), false, 'the submitted token must never be printed');
  });

  test('invalid auth JSON exits 3 with CANVAS_AUTH_CONFIG_INVALID', async () => {
    const bad = path.join(root, 'bad-access.json');
    fs.writeFileSync(bad, '{"version": 1, "principals": [', 'utf8');
    const result = await run(['--store', storeDir, '--auth', bad], FIXTURE_TOKENS.writerA);
    assertStartupFailure(result, { expectedExit: 3, expectedCodes: 'CANVAS_AUTH_CONFIG_INVALID', expectedCommand: result.commandLine });
  });

  test('auth config with invalid mode exits 3 with CANVAS_AUTH_CONFIG_INVALID', async () => {
    const bad = path.join(root, 'bad-mode.json');
    writeAuthConfig(bad, buildAuthConfig([
      { principalId: 'p', tokenSha256: tokenSha256('demo-bad-mode-token'), mode: 'ADMIN', canvasIds: ['canvas-fixture-a'] },
    ]));
    const result = await run(['--store', storeDir, '--auth', bad], 'demo-bad-mode-token');
    assertStartupFailure(result, { expectedExit: 3, expectedCodes: 'CANVAS_AUTH_CONFIG_INVALID', expectedCommand: result.commandLine });
  });

  test('missing --store exits 2 with CANVAS_STORE_UNAVAILABLE', async () => {
    const result = await run(['--auth', authPath], FIXTURE_TOKENS.writerA);
    assertStartupFailure(result, { expectedExit: 2, expectedCodes: 'CANVAS_STORE_UNAVAILABLE', expectedCommand: result.commandLine });
  });

  test('--store pointing at a file exits 2 with CANVAS_STORE_UNAVAILABLE', async () => {
    const filePath = path.join(root, 'not-a-dir');
    fs.writeFileSync(filePath, 'x', 'utf8');
    const result = await run(['--store', filePath, '--auth', authPath], FIXTURE_TOKENS.writerA);
    assertStartupFailure(result, { expectedExit: 2, expectedCodes: 'CANVAS_STORE_UNAVAILABLE', expectedCommand: result.commandLine });
  });

  test('missing --auth exits 3 with an auth config error', async () => {
    const result = await run(['--store', storeDir], FIXTURE_TOKENS.writerA);
    assertStartupFailure(result, {
      expectedExit: 3,
      expectedCodes: ['CANVAS_AUTH_CONFIG_INVALID', 'CANVAS_AUTH_REQUIRED'],
      expectedCommand: result.commandLine,
    });
  });
});

describe('authorization enforcement', () => {
  let fixture;
  let writer;
  let reader;
  let limited;

  before(async () => {
    fixture = await createServerFixture();
    writer = fixture.handle;
    reader = await attachServer(fixture, { token: FIXTURE_TOKENS.reader });
    limited = await attachServer(fixture, { token: FIXTURE_TOKENS.limited });
  });

  after(async () => {
    await Promise.allSettled([reader.cleanup(), limited.cleanup()]);
    await fixture.close();
  });

  test('READ_ONLY principal cannot write (CANVAS_READ_ONLY) and revision does not move', async () => {
    const beforeState = readCanvasState(fixture.store.storeDir, 'canvas-fixture-a');
    expectToolError(
      await callTool(reader.client, 'canvas_create_node', { canvasId: 'canvas-fixture-a', kind: 'text', label: 'Reader write', nodeId: 'node-reader-write' }),
      'CANVAS_READ_ONLY',
    );
    const afterState = readCanvasState(fixture.store.storeDir, 'canvas-fixture-a');
    assert.equal(afterState.revision, beforeState.revision);
    assert.equal(afterState.data.nodes.some((n) => n.id === 'node-reader-write'), false);
  });

  test('canvas outside the principal scope is CANVAS_CANVAS_SCOPE_MISMATCH for reads and writes', async () => {
    expectToolError(await callTool(writer.client, 'canvas_read_canvas', { canvasId: 'canvas-fixture-b' }), 'CANVAS_CANVAS_SCOPE_MISMATCH');
    expectToolError(await callTool(writer.client, 'canvas_read_node', { canvasId: 'canvas-fixture-b', nodeId: 'node-note-1' }), 'CANVAS_CANVAS_SCOPE_MISMATCH');
    expectToolError(
      await callTool(writer.client, 'canvas_create_node', { canvasId: 'canvas-fixture-b', kind: 'text', label: 'Cross write', nodeId: 'node-cross' }),
      'CANVAS_CANVAS_SCOPE_MISMATCH',
    );
  });

  test('canvas_list_canvases filters silently by scope', async () => {
    const writerList = expectToolOk(await callTool(writer.client, 'canvas_list_canvases', {}));
    assert.deepEqual(writerList.canvases.map((c) => c.canvasId), ['canvas-fixture-a']);
    const readerList = expectToolOk(await callTool(reader.client, 'canvas_list_canvases', {}));
    assert.deepEqual(readerList.canvases.map((c) => c.canvasId), ['canvas-fixture-a', 'canvas-fixture-b']);
  });

  test('allowedTools denies non-listed tools with CANVAS_TOOL_DENIED', async () => {
    expectToolOk(await callTool(limited.client, 'canvas_list_canvases', {}));
    expectToolError(await callTool(limited.client, 'canvas_read_canvas', { canvasId: 'canvas-fixture-a' }), 'CANVAS_TOOL_DENIED');
    expectToolError(
      await callTool(limited.client, 'canvas_create_node', { canvasId: 'canvas-fixture-a', kind: 'text', label: 'Limited write', nodeId: 'node-limited' }),
      'CANVAS_TOOL_DENIED',
    );
  });

  test('READ_ONLY principal can read in-scope canvases', async () => {
    const payload = expectToolOk(await callTool(reader.client, 'canvas_read_canvas', { canvasId: 'canvas-fixture-b' }));
    assert.equal(payload.permission, 'READ');
    assert.equal(payload.canvasId, 'canvas-fixture-b');
  });

  test('whitelist bypass tool names are rejected with CANVAS_TOOL_NOT_WHITELISTED and touch nothing', async () => {
    const beforeTree = snapshotTree(fixture.store.root);
    const beforeState = readCanvasFileRaw(fixture.store.storeDir, 'canvas-fixture-a');
    for (const name of ['bash', 'read_file', 'web_fetch', 'exec', 'shell', 'write_file', 'http_get', 'mcp__bash']) {
      const result = await callTool(writer.client, name, { command: 'id' });
      expectToolError(result, 'CANVAS_TOOL_NOT_WHITELISTED');
    }
    assert.deepEqual(snapshotTree(fixture.store.root), beforeTree);
    assert.equal(readCanvasFileRaw(fixture.store.storeDir, 'canvas-fixture-a'), beforeState);
  });

  test('action kinds outside the whitelist are rejected (CANVAS_ACTION_NOT_WHITELISTED)', async () => {
    const result = await callTool(writer.client, 'canvas_commit_batch', {
      canvasId: 'canvas-fixture-a',
      actions: [{ kind: 'shell.exec', command: 'id' }],
    });
    expectToolError(result, 'CANVAS_ACTION_NOT_WHITELISTED');
    assert.equal(readCanvasState(fixture.store.storeDir, 'canvas-fixture-a').revision, 0);
  });

  test('path traversal canvas ids are rejected before any path join', async () => {
    const badIds = ['../escape', '..', 'a/b', 'a\\b', '/etc/passwd', '.hidden', 'a..b', 'x'.repeat(65), ''];
    for (const canvasId of badIds) {
      const result = await callTool(writer.client, 'canvas_read_canvas', { canvasId });
      expectToolError(result, 'CANVAS_CANVAS_ID_INVALID');
    }
  });

  test('malicious node/edge/operation ids are rejected with stable codes', async () => {
    for (const nodeId of ['../escape-node', 'node/bad', '..', 'n'.repeat(129), '']) {
      const result = await callTool(writer.client, 'canvas_create_node', { canvasId: 'canvas-fixture-a', kind: 'text', label: 'x', nodeId });
      expectToolError(result, 'CANVAS_NODE_ID_INVALID');
    }
    expectToolError(
      await callTool(writer.client, 'canvas_connect_nodes', { canvasId: 'canvas-fixture-a', source: 'node-image-1', target: 'node-video-1', relation: 'reference', edgeId: '../bad-edge' }),
      'CANVAS_EDGE_ID_INVALID',
    );
    for (const operationId of ['op/../bad', 'op bad', 'op-' + 'x'.repeat(200)]) {
      const result = await callTool(writer.client, 'canvas_create_node', {
        canvasId: 'canvas-fixture-a',
        kind: 'text',
        label: 'x',
        nodeId: 'node-op-invalid',
        operationId,
      });
      expectToolError(result, 'CANVAS_OPERATION_ID_INVALID');
    }
  });

  test('no files are created outside the store after malicious calls', async () => {
    const rootEntries = fs.readdirSync(fixture.store.root).sort();
    assert.deepEqual(rootEntries, ['auth.json', 'store']);
    const stray = listFilesRecursive(fixture.store.root).filter((file) => /passwd|escape/i.test(file));
    assert.deepEqual(stray, []);
    const canvasFiles = fs.readdirSync(path.join(fixture.store.storeDir, 'canvases')).sort();
    assert.deepEqual(canvasFiles, ['canvas-fixture-a.json', 'canvas-fixture-b.json']);
  });

  test('tokens and token hashes are never persisted in the store', async () => {
    const rawA = readCanvasFileRaw(fixture.store.storeDir, 'canvas-fixture-a');
    const rawB = readCanvasFileRaw(fixture.store.storeDir, 'canvas-fixture-b');
    for (const token of Object.values(FIXTURE_TOKENS)) {
      assert.equal(rawA.includes(token), false, 'token value persisted in canvas file');
      assert.equal(rawB.includes(token), false, 'token value persisted in canvas file');
    }
    assert.equal(rawA.includes('tokenSha256'), false);
  });
});

describe('agent-id attribution cannot elevate permissions', () => {
  test('writer keeps writer principal while agentId is recorded as supplied', async () => {
    const fixture = await createServerFixture({ serverOptions: { agentId: 'spoofed-agent-label' } });
    try {
      const raw = await callTool(fixture.client, 'canvas_create_node', {
        canvasId: 'canvas-fixture-a',
        kind: 'note',
        label: 'Attribution node',
        nodeId: 'node-attribution-1',
      });
      const payload = expectToolOk(raw);
      assert.equal(payload.principalId, 'agent-writer-a');
      assert.equal(payload.agentId, 'spoofed-agent-label');
      const state = readCanvasState(fixture.store.storeDir, 'canvas-fixture-a');
      const receipt = state.receipts[payload.operationId];
      assert.equal(receipt.principalId, 'agent-writer-a');
      assert.equal(receipt.agentId, 'spoofed-agent-label');
    } finally {
      await fixture.close();
    }
  });

  test('reader with a writer-looking agentId stays READ_ONLY', async () => {
    const fixture = await createServerFixture({ token: FIXTURE_TOKENS.reader, serverOptions: { agentId: 'agent-writer-a' } });
    try {
      expectToolError(
        await callTool(fixture.client, 'canvas_create_node', { canvasId: 'canvas-fixture-a', kind: 'text', label: 'Spoof', nodeId: 'node-spoof-1' }),
        'CANVAS_READ_ONLY',
      );
      assert.equal(readCanvasState(fixture.store.storeDir, 'canvas-fixture-a').revision, 0);
    } finally {
      await fixture.close();
    }
  });
});
