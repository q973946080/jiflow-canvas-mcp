// official @modelcontextprotocol/sdk 1.30.0 Client + StdioClientTransport.
// The SDK is a devDependency used only here; it is loaded from the project's node_modules.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { REPO_ROOT, SERVER_ENTRY, SERVER_NAME, SERVER_VERSION, TOOL_NAMES } from '../helpers/paths.mjs';
import { createFixtureStore, readCanvasState } from '../helpers/fixture-store.mjs';
import { createAuthFixture, standardPrincipalSpecs, FIXTURE_TOKENS } from '../helpers/auth-config.mjs';
import { parseToolContent } from '../helpers/mcp-tool.mjs';

const SDK_PACKAGE_JSON = path.join(REPO_ROOT, 'node_modules', '@modelcontextprotocol', 'sdk', 'package.json');

async function loadSdk() {
  try {
    const clientModule = await import('@modelcontextprotocol/sdk/client/index.js');
    const stdioModule = await import('@modelcontextprotocol/sdk/client/stdio.js');
    return { Client: clientModule.Client, StdioClientTransport: stdioModule.StdioClientTransport };
  } catch (err) {
    assert.fail(
      `cannot load the official @modelcontextprotocol/sdk from ${path.join(REPO_ROOT, 'node_modules')}: ${err.message}\n` +
        'The devDependency @modelcontextprotocol/sdk@1.30.0 must be installed by core-dev (npm install).',
    );
  }
}

describe('official @modelcontextprotocol/sdk Client over real stdio', () => {
  let Client;
  let StdioClientTransport;
  let store;
  let auth;
  let client;
  let transport;
  let stderrText = '';

  before(async () => {
    assert.ok(fs.existsSync(SDK_PACKAGE_JSON), `official SDK not installed at ${SDK_PACKAGE_JSON}; core-dev must run npm install`);
    const installed = JSON.parse(fs.readFileSync(SDK_PACKAGE_JSON, 'utf8'));
    assert.equal(installed.version, '1.30.0', 'the documented contract requires @modelcontextprotocol/sdk pinned exactly to 1.30.0');

    ({ Client, StdioClientTransport } = await loadSdk());

    store = createFixtureStore();
    auth = createAuthFixture(store.root, standardPrincipalSpecs());
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [SERVER_ENTRY, '--store', store.storeDir, '--auth', auth.authPath],
      env: { CANVAS_MCP_TOKEN: FIXTURE_TOKENS.writerA },
      cwd: REPO_ROOT,
      stderr: 'pipe',
    });
    if (transport.stderr) {
      transport.stderr.setEncoding('utf8');
      transport.stderr.on('data', (chunk) => {
        stderrText += chunk;
      });
    }
    client = new Client({ name: 'sdk-independent-verifier', version: '0.0.0' }, { capabilities: {} });
    await client.connect(transport);
  });

  after(async () => {
    try {
      await client?.close();
    } catch {
      /* best effort */
    }
    store?.cleanup();
  });

  test('connect() negotiates the the documented contract server identity and capabilities', () => {
    assert.deepEqual(client.getServerVersion(), { name: SERVER_NAME, version: SERVER_VERSION });
    const capabilities = client.getServerCapabilities();
    assert.equal(capabilities.tools.listChanged, false);
  });

  test('listTools() discovers exactly 9 canvas_* tools', async () => {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 9);
    assert.deepEqual(tools.map((t) => t.name), TOOL_NAMES);
    for (const tool of tools) {
      assert.equal(typeof tool.description, 'string');
      assert.equal(typeof tool.inputSchema, 'object');
    }
  });

  test('callTool() reads the fictional fixture through the official SDK', async () => {
    const result = await client.callTool({ name: 'canvas_read_canvas', arguments: { canvasId: 'canvas-fixture-a' } });
    assert.notEqual(result.isError, true);
    const payload = parseToolContent(result);
    assert.equal(payload.ok, true);
    assert.equal(payload.permission, 'READ');
    assert.equal(payload.canvasId, 'canvas-fixture-a');
    assert.equal(payload.revision, 0);
    assert.equal(payload.nodes.length, 3);
    assert.deepEqual(result.structuredContent, payload);
  });

  test('callTool() creates a node through the official SDK and persists it', async () => {
    const result = await client.callTool({
      name: 'canvas_create_node',
      arguments: { canvasId: 'canvas-fixture-a', kind: 'audio', label: 'SDK-created audio', nodeId: 'node-sdk-1' },
    });
    assert.notEqual(result.isError, true);
    const payload = parseToolContent(result);
    assert.equal(payload.ok, true);
    assert.equal(payload.permission, 'WRITE');
    assert.equal(payload.replayed, false);
    assert.equal(payload.revision, 1);
    assert.equal(payload.nodeId, 'node-sdk-1');
    assert.deepEqual(result.structuredContent, payload);
    const state = readCanvasState(store.storeDir, 'canvas-fixture-a');
    assert.equal(state.revision, 1);
    assert.equal(state.data.nodes.some((n) => n.id === 'node-sdk-1'), true);
  });

  test('callTool() surfaces tool-level errors as isError results (no throw)', async () => {
    const result = await client.callTool({ name: 'canvas_read_node', arguments: { canvasId: 'canvas-fixture-a', nodeId: 'node-nope' } });
    assert.equal(result.isError, true);
    const payload = parseToolContent(result);
    assert.equal(payload.ok, false);
    assert.equal(payload.code, 'CANVAS_NODE_NOT_FOUND');
    assert.equal(typeof payload.error, 'string');
  });

  test('the token never leaks to the child stderr captured by the transport', () => {
    assert.ok(stderrText.length > 0, 'expected captured server stderr');
    assert.equal(stderrText.includes(FIXTURE_TOKENS.writerA), false, 'token must never appear in server logs');
  });
});
