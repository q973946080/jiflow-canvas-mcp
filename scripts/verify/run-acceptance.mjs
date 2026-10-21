#!/usr/bin/env node
/**
 * the documented contract acceptance matrix runner for jiflow-canvas-mcp.
 *
 * Every check spawns REAL server processes and speaks REAL newline-delimited JSON-RPC over
 * stdio (or runs the real scanner / real npm test). There is no MCP protocol mocking.
 *
 * Outputs:
 *   evidence/logs/<checkId>.log        commands, exit codes and key output per check
 *   evidence/logs/npm-test.log         raw `npm test` output (C11)
 *   evidence/acceptance-results.json   machine readable matrix
 *
 * Exit code 0 only when every check is PASS.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

import { startServerClient, runNode } from '../../test/helpers/spawn-server.mjs';
import {
  FIXTURE_NOW,
  createFixtureStore,
  createTempDir,
  fixtureCanvasState,
  fixtureCanvasStateB,
  findTempFiles,
  initStore,
  listLocks,
  makeCanvasState,
  makeEdge,
  makeNode,
  readCanvasState,
  rmrf,
  walkDir,
  writeCanvasState,
} from '../../test/helpers/fixture-store.mjs';
import { createAuthFixture, standardPrincipalSpecs, FIXTURE_TOKENS } from '../../test/helpers/auth-config.mjs';
import { callTool, expectToolError, expectToolOk, parseToolContent } from '../../test/helpers/mcp-tool.mjs';
import { assertSchemaSubset } from '../../test/helpers/schema-subset.mjs';
import { independentHash } from '../../test/helpers/canonical-independent.mjs';
import { scanRepository } from './scan-secrets.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const EVIDENCE_DIR = path.join(ROOT, 'evidence');
const LOGS_DIR = path.join(EVIDENCE_DIR, 'logs');
const RESULTS_PATH = path.join(EVIDENCE_DIR, 'acceptance-results.json');
const TMP_ROOT = createTempDir('canvas-mcp-acceptance-');

const SERVER_NAME = 'jiflow-canvas-mcp';
const SERVER_VERSION = '0.1.0';
const TOOL_NAMES = [
  'canvas_list_canvases',
  'canvas_read_canvas',
  'canvas_read_node',
  'canvas_read_receipt',
  'canvas_list_receipts',
  'canvas_create_node',
  'canvas_patch_node',
  'canvas_connect_nodes',
  'canvas_commit_batch',
];

// ---------------------------------------------------------------------------------------
// Evidence bookkeeping
// ---------------------------------------------------------------------------------------
const checks = [];
let active = null;
let activeLog = [];
let activeServers = [];
let activeCleanups = [];
const recordedServers = new WeakSet();

function log(message = '') {
  console.log(message);
  activeLog.push(message);
}

function truncate(text, max = 4000) {
  const value = String(text ?? '');
  return value.length <= max ? value : `${value.slice(0, max)}\n… (${value.length - max} chars truncated)`;
}

function recordCommand(commandLine, exitCode, output) {
  active.evidence.commands.push(commandLine);
  active.evidence.exitCodes.push(exitCode);
  log(`$ ${commandLine}`);
  log(`[exit ${exitCode}]`);
  if (output) log(truncate(output, 3000));
}

function note(message) {
  active.notes.push(message);
  log(`NOTE: ${message}`);
}

function logRpc(label, payload) {
  log(`-> ${label}${payload === undefined ? '' : ` ${truncate(JSON.stringify(payload), 1200)}`}`);
}

async function runCheck(id, title, fn) {
  active = {
    id,
    title,
    status: 'FAIL',
    startedAt: new Date().toISOString(),
    evidence: { commands: [], exitCodes: [], logFile: `evidence/logs/${id}.log` },
    notes: [],
  };
  activeLog = [];
  activeServers = [];
  activeCleanups = [];
  log(`\n=== ${id} — ${title} ===`);
  try {
    await fn();
    active.status = 'PASS';
  } catch (error) {
    active.status = 'FAIL';
    active.notes.push(`error: ${error && error.message ? error.message : String(error)}`);
    log(`FAIL: ${error && error.stack ? error.stack : String(error)}`);
  } finally {
    await cleanupServers();
    await runCleanups();
    active.finishedAt = new Date().toISOString();
    flushActiveLog();
    checks.push(active);
  }
}

async function cleanupServers() {
  for (const handle of [...activeServers].reverse()) {
    try {
      const info = await handle.stop({ timeoutMs: 10_000 });
      recordServerExit(handle, info);
    } catch (error) {
      log(`cleanup warning: failed to stop server: ${error.message}`);
      await handle.cleanup();
    }
  }
  activeServers = [];
}

function recordServerExit(handle, info) {
  if (recordedServers.has(handle)) return;
  recordedServers.add(handle);
  const code = info && info.code !== null && info.code !== undefined ? info.code : `signal:${info ? info.signal : 'unknown'}`;
  recordCommand(handle.server.commandLine, code);
}

async function runCleanups() {
  for (const cleanup of activeCleanups.reverse()) {
    try {
      await cleanup();
    } catch (error) {
      log(`cleanup warning: ${error.message}`);
    }
  }
  activeCleanups = [];
}

function flushActiveLog() {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  const header = [
    `# acceptance check ${active.id} — ${active.title}`,
    `# generated ${new Date().toISOString()}`,
    `# status ${active.status}`,
    '',
  ].join('\n');
  fs.writeFileSync(path.join(ROOT, active.evidence.logFile), `${header}${activeLog.join('\n')}\n`, 'utf8');
}

// ---------------------------------------------------------------------------------------
// Generic process helper (real subprocesses, real exit codes)
// ---------------------------------------------------------------------------------------
function shellQuote(value) {
  return /^[A-Za-z0-9_./:=@-]+$/.test(value) ? value : `'${String(value).replaceAll("'", "'\\''")}'`;
}

function runCommand(command, args, { cwd = ROOT, env = {}, timeoutMs = 240_000 } = {}) {
  const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stderr.on('data', (chunk) => (stderr += chunk));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      reject(new Error(`timed out after ${timeoutMs}ms: ${command} ${args.join(' ')}`));
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, commandLine: `${command} ${args.map(shellQuote).join(' ')}` });
    });
  });
}

/**
 * Resolve the npm CLI script without depending on the ambient PATH.
 *
 * C11 used to fall back to a bare `npm` from PATH when acceptance was invoked directly
 * (`node scripts/verify/run-acceptance.mjs`), which fails with `spawn npm ENOENT` in GUI/agent
 * environments with a scrubbed PATH even though `npm test` works fine in a normal shell. Since
 * Node distributions ship npm beside the Node binary, prefer the CLI that belongs to
 * `process.execPath`; `npm_execpath` (set when launched through an npm script) still wins.
 */
function resolveNpmCli() {
  const candidates = [];
  if (typeof process.env.CANVAS_MCP_NPM_CLI === 'string' && process.env.CANVAS_MCP_NPM_CLI.length > 0) {
    candidates.push(process.env.CANVAS_MCP_NPM_CLI);
  }
  if (typeof process.env.npm_execpath === 'string' && process.env.npm_execpath.length > 0) {
    candidates.push(process.env.npm_execpath);
  }
  const nodeDir = path.dirname(process.execPath);
  candidates.push(
    path.resolve(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.resolve(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.resolve(nodeDir, '..', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.resolve(nodeDir, '..', '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  );
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

function runNpm(args, options = {}) {
  const npmCli = resolveNpmCli();
  if (npmCli !== null) {
    // npm lifecycle scripts spawn a bare `node`; keep the current Node directory on PATH so npm
    // works even when the acceptance runner was started with a scrubbed PATH (GUI/agent hosts).
    const nodeBinDir = path.dirname(process.execPath);
    const env = {
      PATH: [nodeBinDir, options.env?.PATH, process.env.PATH].filter(Boolean).join(path.delimiter),
      ...(options.env ?? {}),
    };
    return runCommand(process.execPath, [npmCli, ...args], { ...options, env });
  }
  // Last resort: PATH lookup. Environments without npm anywhere will fail C11 explicitly instead of
  // silently reporting a fake PASS.
  return runCommand('npm', args, options);
}

// ---------------------------------------------------------------------------------------
// Fixture / server helpers for checks
// ---------------------------------------------------------------------------------------
async function openFixture({ canvases, principals, token = FIXTURE_TOKENS.writerA, spawnOptions = {}, clientOptions = {} } = {}) {
  const store = createFixtureStore(canvases ? { canvases } : undefined);
  const auth = createAuthFixture(store.root, principals ?? standardPrincipalSpecs());
  activeCleanups.push(() => store.cleanup());
  const handle = await startServerClient({
    store: store.storeDir,
    auth: auth.authPath,
    token,
    ...spawnOptions,
    ...clientOptions,
  });
  activeServers.push(handle);
  return {
    store,
    auth,
    handle,
    client: handle.client,
    request: (method, params, options) => handle.request(method, params, options),
    notify: (method, params) => handle.notify(method, params),
  };
}

async function attachServer(fixture, { token = FIXTURE_TOKENS.writerA, spawnOptions = {}, clientOptions = {} } = {}) {
  const handle = await startServerClient({
    store: fixture.store.storeDir,
    auth: fixture.auth.authPath,
    token,
    ...spawnOptions,
    ...clientOptions,
  });
  activeServers.push(handle);
  return handle;
}

async function toolOk(client, name, args = {}) {
  logRpc(`tools/call ${name}`, args);
  const raw = await callTool(client, name, args);
  return expectToolOk(raw, { tool: name });
}

async function toolError(client, name, args, expectedCode) {
  logRpc(`tools/call ${name}`, args);
  const raw = await callTool(client, name, args);
  return expectToolError(raw, expectedCode);
}

function assertStoreClean(storeDir) {
  assert.deepEqual(findTempFiles(storeDir), [], 'no stale temp files may remain in the store');
  assert.deepEqual(listLocks(storeDir), [], 'no unreleased lock owner files may remain in the store');
}

// ---------------------------------------------------------------------------------------
// C01 — standalone start
// ---------------------------------------------------------------------------------------
async function c01StandaloneStart() {
  log('Copying src/ + package.json to an isolated temp tree (no node_modules, no repo).');
  const copyRoot = path.join(TMP_ROOT, 'c01-standalone');
  fs.mkdirSync(copyRoot, { recursive: true });
  const cpSrc = await runCommand('cp', ['-R', path.join(ROOT, 'src'), path.join(copyRoot, 'src')]);
  recordCommand(cpSrc.commandLine, cpSrc.code, cpSrc.stderr);
  assert.equal(cpSrc.code, 0, 'copy of src/ must succeed');
  const cpPkg = await runCommand('cp', [path.join(ROOT, 'package.json'), path.join(copyRoot, 'package.json')]);
  recordCommand(cpPkg.commandLine, cpPkg.code, cpPkg.stderr);
  assert.equal(cpPkg.code, 0, 'copy of package.json must succeed');
  assert.equal(fs.existsSync(path.join(copyRoot, 'node_modules')), false, 'temp copy must not contain node_modules');
  assert.equal(fs.existsSync(path.join(copyRoot, 'test')), false, 'temp copy must not contain test/');

  // The copied src/ must be self-contained: only node: builtins and relative imports.
  const copiedFiles = walkDir(path.join(copyRoot, 'src')).filter((entry) => !entry.isDir);
  assert.ok(copiedFiles.length > 0, 'copied src/ must not be empty');
  const importPattern = /(?:import\s+(?:[^'"]*?\s+from\s+)?|export\s+[^'"]*?\s+from\s+|import\s*\(\s*)['"]([^'"]+)['"]/g;
  for (const entry of copiedFiles) {
    const text = fs.readFileSync(entry.abs, 'utf8');
    let match;
    while ((match = importPattern.exec(text)) !== null) {
      const specifier = match[1];
      assert.ok(
        specifier.startsWith('node:') || specifier.startsWith('./') || specifier.startsWith('../'),
        `standalone src must only import node builtins/relative modules, found "${specifier}" in ${entry.rel}`,
      );
    }
    assert.equal(/\/Users\/|\/home\/|\/private\/var\/folders\//.test(text), false, `standalone src contains a developer path: ${entry.rel}`);
  }

  // The copied tree must itself be clean according to the secret/PII/proprietary scanner.
  const copyScan = scanRepository(copyRoot);
  assert.equal(copyScan.counts.failures, 0, `standalone tree scanner findings: ${JSON.stringify(copyScan.findings.filter((f) => !f.allowlisted))}`);

  // Fixture data + auth inside the isolated copy tree (server runtime needs no npm install).
  const storeDir = path.join(copyRoot, 'data-store');
  fs.mkdirSync(path.join(storeDir, 'canvases'), { recursive: true });
  fs.mkdirSync(path.join(storeDir, '.locks'), { recursive: true });
  writeCanvasState(storeDir, fixtureCanvasState('canvas-fixture-a'));
  const auth = createAuthFixture(copyRoot, standardPrincipalSpecs());
  const entry = path.join(copyRoot, 'src', 'server', 'main.mjs');
  log(`spawning isolated server: ${process.execPath} ${entry}`);

  const handle = await startServerClient({
    entry,
    cwd: copyRoot,
    store: storeDir,
    auth: auth.authPath,
    token: FIXTURE_TOKENS.writerA,
    env: { NODE_PATH: '' },
  });
  activeServers.push(handle);
  const init = handle.initializeResult;
  assert.equal(init.serverInfo.name, SERVER_NAME);
  assert.equal(init.serverInfo.version, SERVER_VERSION);
  assert.equal(init.protocolVersion, '2025-11-25');
  assert.deepEqual(init.capabilities, { tools: { listChanged: false } });
  const startup = handle.startup;
  assert.equal(startup.store, storeDir);
  assert.equal(startup.tools, 9);

  const ping = await handle.request('ping');
  assert.deepEqual(ping, {});
  const listing = await handle.request('tools/list');
  assert.deepEqual(listing.tools.map((tool) => tool.name), TOOL_NAMES);
  const read = await toolOk(handle.client, 'canvas_read_canvas', { canvasId: 'canvas-fixture-a' });
  assert.equal(read.revision, 0);
  assert.equal(read.nodes.length, 3);

  const exit = await handle.stop();
  recordServerExit(handle, exit);
  assert.equal(exit.code, 0, 'standalone server must shut down gracefully with exit 0');
  note('server booted from a temp copy of src/+package.json without node_modules or repo context');
}

// ---------------------------------------------------------------------------------------
// C02 — MCP handshake: raw JSON-RPC + official SDK
// ---------------------------------------------------------------------------------------
async function c02McpHandshake() {
  const principals = standardPrincipalSpecs({ canvasIds: ['canvas-fixture-a', 'canvas-fixture-b'] });
  const fixture = await openFixture({ principals });
  const init = fixture.handle.initializeResult;
  assert.deepEqual(init.serverInfo, { name: SERVER_NAME, version: SERVER_VERSION });
  assert.equal(init.protocolVersion, '2025-11-25');
  assert.deepEqual(init.capabilities, { tools: { listChanged: false } });

  const ping = await fixture.request('ping');
  assert.deepEqual(ping, {});
  const { tools } = await fixture.request('tools/list');
  assert.equal(tools.length, 9);
  assert.deepEqual(tools.map((tool) => tool.name), TOOL_NAMES);
  for (const tool of tools) assertSchemaSubset(tool.inputSchema, `tools.${tool.name}.inputSchema`);

  const listPayload = await toolOk(fixture.client, 'canvas_list_canvases', {});
  assert.equal(listPayload.ok, true);
  assert.equal(listPayload.canvases.length, 2);

  // Official @modelcontextprotocol/sdk v1.30.0 Client + StdioClientTransport, real child process.
  const sdkVersionRun = await runNode([
    '-p',
    "require('./node_modules/@modelcontextprotocol/sdk/package.json').version",
  ]);
  recordCommand(
    `${process.execPath} -p "require('./node_modules/@modelcontextprotocol/sdk/package.json').version"`,
    sdkVersionRun.code,
    sdkVersionRun.stdout.trim(),
  );
  assert.equal(sdkVersionRun.code, 0, sdkVersionRun.stderr);
  assert.equal(sdkVersionRun.stdout.trim(), '1.30.0', 'the documented contract requires SDK pinned to exactly 1.30.0');

  let Client;
  let StdioClientTransport;
  try {
    ({ Client } = await import('@modelcontextprotocol/sdk/client/index.js'));
    ({ StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js'));
  } catch (error) {
    assert.fail(`cannot import the official MCP SDK: ${error.message}`);
  }
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      path.join(ROOT, 'src', 'server', 'main.mjs'),
      '--store',
      fixture.store.storeDir,
      '--auth',
      fixture.auth.authPath,
    ],
    env: { CANVAS_MCP_TOKEN: FIXTURE_TOKENS.writerA },
    cwd: ROOT,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'acceptance-sdk-client', version: '0.0.0' }, { capabilities: {} });
  try {
    await client.connect(transport);
    const sdkServer = client.getServerVersion();
    assert.deepEqual(sdkServer, { name: SERVER_NAME, version: SERVER_VERSION });
    const sdkTools = await client.listTools();
    assert.equal(sdkTools.tools.length, 9);
    assert.deepEqual(sdkTools.tools.map((tool) => tool.name), TOOL_NAMES);
    log('SDK listTools(): 9 tools discovered');
    const readResult = await client.callTool({ name: 'canvas_read_canvas', arguments: { canvasId: 'canvas-fixture-a' } });
    assert.notEqual(readResult.isError, true);
    const readPayload = parseToolContent(readResult);
    assert.equal(readPayload.ok, true);
    assert.equal(readPayload.canvasId, 'canvas-fixture-a');
    assert.equal(readPayload.revision, 0);
    log('SDK callTool(canvas_read_canvas): ok');
    const createResult = await client.callTool({
      name: 'canvas_create_node',
      arguments: { canvasId: 'canvas-fixture-a', kind: 'note', label: 'SDK acceptance node', nodeId: 'node-sdk-accept-1' },
    });
    assert.notEqual(createResult.isError, true);
    const createPayload = parseToolContent(createResult);
    assert.equal(createPayload.ok, true);
    assert.equal(createPayload.revision, 1);
    assert.equal(createPayload.permission, 'WRITE');
    log('SDK callTool(canvas_create_node): ok');
  } finally {
    await client.close().catch(() => {});
  }
  recordCommand('sdk: Client.connect + listTools + callTool(canvas_read_canvas, canvas_create_node)', 0);
  note('raw newline-delimited JSON-RPC and official SDK both exercised against real stdio servers');
}

// ---------------------------------------------------------------------------------------
// C03 — read canvas
// ---------------------------------------------------------------------------------------
async function c03ReadCanvas() {
  const principals = standardPrincipalSpecs({ canvasIds: ['canvas-fixture-a', 'canvas-fixture-b'] });
  const fixture = await openFixture({ principals });
  const payload = await toolOk(fixture.client, 'canvas_read_canvas', { canvasId: 'canvas-fixture-a' });
  assert.equal(payload.ok, true);
  assert.equal(payload.tool, 'canvas_read_canvas');
  assert.equal(payload.permission, 'READ');
  assert.equal(payload.server, SERVER_NAME);
  assert.equal(payload.principalId, 'agent-writer-a');
  assert.equal(payload.agentId, 'agent-writer-a');
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
  assert.deepEqual(payload.edges, [{ id: 'edge-image-video', source: 'node-image-1', target: 'node-video-1', relation: 'reference' }]);
  assert.equal(payload.revision, 0);
  assert.equal(payload.updatedAt, FIXTURE_NOW);
  assert.equal(payload.name, 'Fixture canvas A');

  const list = await toolOk(fixture.client, 'canvas_list_canvases', {});
  assert.deepEqual(list.canvases.map((canvas) => canvas.canvasId), ['canvas-fixture-a', 'canvas-fixture-b']);
  const node = await toolOk(fixture.client, 'canvas_read_node', { canvasId: 'canvas-fixture-a', nodeId: 'node-image-1' });
  assert.equal(node.node.data.url, 'https://example.com/fixture-image.png');
  await toolError(fixture.client, 'canvas_read_node', { canvasId: 'canvas-fixture-a', nodeId: 'node-missing' }, 'CANVAS_NODE_NOT_FOUND');
  note('returned fixture nodes/edges byte-equal to the seeded fictional store');
}

// ---------------------------------------------------------------------------------------
// C04 — create node
// ---------------------------------------------------------------------------------------
async function c04CreateNode() {
  const fixture = await openFixture();
  const payload = await toolOk(fixture.client, 'canvas_create_node', {
    canvasId: 'canvas-fixture-a',
    kind: 'note',
    label: 'Acceptance create node',
    nodeId: 'node-accept-1',
    expectedRevision: 0,
    operationId: 'op-accept-create-1',
  });
  assert.equal(payload.ok, true);
  assert.equal(payload.permission, 'WRITE');
  assert.equal(payload.replayed, false);
  assert.equal(payload.revision, 1);
  assert.equal(payload.actionKind, 'node.create');
  assert.equal(payload.nodeId, 'node-accept-1');
  assert.equal(payload.result.canvasId, 'canvas-fixture-a');
  assert.equal(payload.result.revision, 1);

  const state = readCanvasState(fixture.store.storeDir, 'canvas-fixture-a');
  assert.equal(state.revision, 1);
  const created = state.data.nodes.find((node) => node.id === 'node-accept-1');
  assert.deepEqual(created, {
    id: 'node-accept-1',
    type: 'note',
    position: { x: 0, y: 0 },
    data: { nodeType: 'note', label: 'Acceptance create node' },
  });
  assert.ok(state.receipts['op-accept-create-1'], 'receipt must be committed in the same store file');
  assert.equal(state.receipts['op-accept-create-1'].resultingRevision, 1);
  assertStoreClean(fixture.store.storeDir);
  note('node persisted to the isolated store file together with its operation receipt');
}

// ---------------------------------------------------------------------------------------
// C05 — patch node
// ---------------------------------------------------------------------------------------
async function c05PatchNode() {
  const fixture = await openFixture();
  const created = await toolOk(fixture.client, 'canvas_create_node', {
    canvasId: 'canvas-fixture-a',
    kind: 'text',
    label: 'Patch target',
    nodeId: 'node-patch-target',
    expectedRevision: 0,
  });
  assert.equal(created.revision, 1);
  const patched = await toolOk(fixture.client, 'canvas_patch_node', {
    canvasId: 'canvas-fixture-a',
    nodeId: 'node-patch-target',
    data: { content: 'patched content', status: 'done' },
    position: { x: 5, y: 6 },
    expectedRevision: 1,
  });
  assert.equal(patched.actionKind, 'node.patch');
  assert.equal(patched.revision, 2);
  const state = readCanvasState(fixture.store.storeDir, 'canvas-fixture-a');
  assert.equal(state.revision, 2);
  const node = state.data.nodes.find((candidate) => candidate.id === 'node-patch-target');
  assert.deepEqual(node.position, { x: 5, y: 6 });
  assert.deepEqual(node.data, {
    nodeType: 'text',
    label: 'Patch target',
    content: 'patched content',
    status: 'done',
  });
  assertStoreClean(fixture.store.storeDir);
  note('content + position updated, unrelated data fields preserved, revision bumped to 2');
}

// ---------------------------------------------------------------------------------------
// C06 — connect nodes
// ---------------------------------------------------------------------------------------
async function c06ConnectNodes() {
  const canvases = [
    makeCanvasState({
      canvasId: 'canvas-fixture-a',
      nodes: [makeNode('image', 'node-image-1'), makeNode('video', 'node-video-1')],
      edges: [],
    }),
  ];
  const fixture = await openFixture({ canvases });
  const payload = await toolOk(fixture.client, 'canvas_connect_nodes', {
    canvasId: 'canvas-fixture-a',
    source: 'node-image-1',
    target: 'node-video-1',
    relation: 'reference',
    edgeId: 'edge-accept-1',
    expectedRevision: 0,
  });
  assert.equal(payload.actionKind, 'edge.connect');
  assert.equal(payload.edgeId, 'edge-accept-1');
  assert.equal(payload.revision, 1);
  const state = readCanvasState(fixture.store.storeDir, 'canvas-fixture-a');
  assert.deepEqual(state.data.edges, [
    { id: 'edge-accept-1', source: 'node-image-1', target: 'node-video-1', relation: 'reference' },
  ]);
  await toolError(
    fixture.client,
    'canvas_connect_nodes',
    { canvasId: 'canvas-fixture-a', source: 'node-video-1', target: 'node-image-1', relation: 'reference' },
    'CANVAS_EDGE_RELATION_INVALID',
  );
  assert.equal(readCanvasState(fixture.store.storeDir, 'canvas-fixture-a').data.edges.length, 1);
  assertStoreClean(fixture.store.storeDir);
  note('edge persisted exactly; capability-invalid reverse relation rejected without writing');
}

// ---------------------------------------------------------------------------------------
// C07 — concurrency conflict
// ---------------------------------------------------------------------------------------
async function c07ConcurrencyConflict() {
  const fixture = await openFixture();
  const extras = [await attachServer(fixture), await attachServer(fixture)];
  const servers = [fixture.handle, ...extras];

  // Every process reads the same base revision, then races a stale expectedRevision.
  const revisions = [];
  for (const handle of servers) {
    const read = await toolOk(handle.client, 'canvas_read_canvas', { canvasId: 'canvas-fixture-a' });
    revisions.push(read.revision);
  }
  assert.deepEqual(revisions, [0, 0, 0], 'all writers must start from revision 0');

  log('racing 3 real server processes with expectedRevision=0');
  const results = await Promise.all(
    servers.map((handle, index) =>
      callTool(handle.client, 'canvas_create_node', {
        canvasId: 'canvas-fixture-a',
        kind: 'text',
        label: `Acceptance racer ${index}`,
        nodeId: `node-accept-race-${index}`,
        expectedRevision: 0,
      }),
    ),
  );
  const payloads = results.map((raw) => parseToolContent(raw));
  const successes = payloads.filter((payload) => payload.ok === true);
  const conflicts = payloads.filter((payload) => payload.ok === false);
  assert.equal(successes.length, 1, `exactly one winner expected, got ${JSON.stringify(payloads)}`);
  assert.equal(conflicts.length, 2, `exactly two conflicts expected, got ${JSON.stringify(payloads)}`);
  for (const conflict of conflicts) {
    assert.equal(conflict.code, 'CANVAS_REVISION_CONFLICT');
    assert.equal(conflict.detail.expectedRevision, 0);
    assert.equal(conflict.detail.actualRevision, 1);
  }
  const winner = successes[0];
  assert.equal(winner.replayed, false);
  assert.equal(winner.revision, 1);
  const state = readCanvasState(fixture.store.storeDir, 'canvas-fixture-a');
  assert.equal(state.revision, 1);
  assert.equal(state.data.nodes.length, 4);
  assert.equal(state.data.nodes.filter((node) => node.id.startsWith('node-accept-race-')).length, 1);
  assert.equal(Object.keys(state.receipts).length, 1);

  // The loser retries with the fresh revision and succeeds.
  const retry = await toolOk(extras[0].client, 'canvas_create_node', {
    canvasId: 'canvas-fixture-a',
    kind: 'text',
    label: 'Acceptance retry',
    nodeId: 'node-accept-race-retry',
    expectedRevision: 1,
  });
  assert.equal(retry.replayed, false);
  assert.equal(retry.revision, 2);
  const finalState = readCanvasState(fixture.store.storeDir, 'canvas-fixture-a');
  assert.equal(finalState.revision, 2);
  assert.equal(finalState.data.nodes.filter((node) => node.id.startsWith('node-accept-race-')).length, 2);
  assertStoreClean(fixture.store.storeDir);
  note('CAS + owner/fence canvas lock produced exactly one winner across 3 real processes; retry succeeded');
}

// ---------------------------------------------------------------------------------------
// C08 — unauthorized rejected
// ---------------------------------------------------------------------------------------
async function c08UnauthorizedRejected() {
  const principals = standardPrincipalSpecs({ canvasIds: ['canvas-fixture-a'] });
  const fixture = await openFixture({ principals });
  const reader = await attachServer(fixture, { token: FIXTURE_TOKENS.reader });
  const limited = await attachServer(fixture, { token: FIXTURE_TOKENS.limited });
  const revisionBefore = readCanvasState(fixture.store.storeDir, 'canvas-fixture-a').revision;

  await toolError(fixture.client, 'canvas_read_canvas', { canvasId: 'canvas-fixture-b' }, 'CANVAS_CANVAS_SCOPE_MISMATCH');
  await toolError(
    fixture.client,
    'canvas_create_node',
    { canvasId: 'canvas-fixture-b', kind: 'text', label: 'Cross write', nodeId: 'node-cross-write' },
    'CANVAS_CANVAS_SCOPE_MISMATCH',
  );
  await toolError(
    reader.client,
    'canvas_create_node',
    { canvasId: 'canvas-fixture-a', kind: 'text', label: 'Read only write', nodeId: 'node-readonly-write' },
    'CANVAS_READ_ONLY',
  );
  await toolError(limited.client, 'canvas_read_canvas', { canvasId: 'canvas-fixture-a' }, 'CANVAS_TOOL_DENIED');
  for (const toolName of ['bash', 'read_file', 'web_fetch', 'exec', 'shell']) {
    await toolError(fixture.client, toolName, { command: 'id' }, 'CANVAS_TOOL_NOT_WHITELISTED');
  }
  for (const canvasId of ['../escape', 'a/b', '..', '/etc/passwd', 'a..b']) {
    await toolError(fixture.client, 'canvas_read_canvas', { canvasId }, 'CANVAS_CANVAS_ID_INVALID');
  }
  const revisionAfter = readCanvasState(fixture.store.storeDir, 'canvas-fixture-a').revision;
  assert.equal(revisionAfter, revisionBefore, 'unauthorized calls must not change the store revision');
  const state = readCanvasState(fixture.store.storeDir, 'canvas-fixture-a');
  assert.equal(state.data.nodes.some((node) => node.id.startsWith('node-cross-write') || node.id === 'node-readonly-write'), false);
  assert.deepEqual(fs.readdirSync(fixture.store.root).sort(), ['auth.json', 'store']);
  assert.deepEqual(
    fs.readdirSync(path.join(fixture.store.storeDir, 'canvases')).filter((file) => !file.endsWith('.json')),
    [],
  );
  note('READ_ONLY, scope mismatch, allowedTools, whitelist-bypass names and traversal ids all rejected with stable codes');
}

// ---------------------------------------------------------------------------------------
// C09 — operation receipt
// ---------------------------------------------------------------------------------------
async function c09OperationReceipt() {
  const fixture = await openFixture();
  const request = {
    canvasId: 'canvas-fixture-a',
    kind: 'text',
    label: 'Receipt node',
    nodeId: 'node-receipt-1',
    expectedRevision: 0,
    operationId: 'op-accept-receipt-1',
  };
  const payload = await toolOk(fixture.client, 'canvas_create_node', request);
  assert.equal(payload.replayed, false);
  assert.equal(payload.kind, 'canvas.batch');
  assert.equal(payload.revision, 1);

  // Independently reconstruct the canonical operation payload per the documented contract/§8 and hash it.
  const expectedPayload = {
    canvasId: 'canvas-fixture-a',
    expectedRevision: 0,
    actions: [
      {
        kind: 'node.create',
        node: {
          id: 'node-receipt-1',
          type: 'text',
          position: { x: 0, y: 0 },
          data: { label: 'Receipt node', nodeType: 'text' },
        },
      },
    ],
  };
  const expectedPayloadHash = independentHash(expectedPayload);
  assert.equal(payload.payloadHash, expectedPayloadHash, 'write result payloadHash must equal the independently computed canonical payload hash');

  const { receipt } = await (async () => {
    logRpc('tools/call canvas_read_receipt', { canvasId: 'canvas-fixture-a', operationId: 'op-accept-receipt-1' });
    const raw = await callTool(fixture.client, 'canvas_read_receipt', {
      canvasId: 'canvas-fixture-a',
      operationId: 'op-accept-receipt-1',
    });
    return expectToolOk(raw);
  })();
  assert.equal(receipt.operationId, 'op-accept-receipt-1');
  assert.equal(receipt.kind, 'canvas.batch');
  assert.equal(receipt.payloadHash, expectedPayloadHash);
  assert.equal(receipt.expectedRevision, 0);
  assert.equal(receipt.resultingRevision, payload.revision);
  assert.deepEqual(receipt.actionKinds, ['node.create']);
  assert.equal(receipt.principalId, 'agent-writer-a');
  assert.equal(receipt.agentId, 'agent-writer-a');
  assert.ok(!Number.isNaN(Date.parse(receipt.committedAt)));
  assert.deepEqual(receipt.result, payload.result);
  assert.equal('token' in receipt, false);
  assert.equal('durationMs' in receipt, false, 'public receipt projection must not expose durationMs');

  const listed = await toolOk(fixture.client, 'canvas_list_receipts', { canvasId: 'canvas-fixture-a', limit: 10 });
  assert.equal(listed.receipts.length, 1);
  assert.equal(listed.receipts[0].operationId, 'op-accept-receipt-1');

  const replay = await toolOk(fixture.client, 'canvas_create_node', request);
  assert.equal(replay.replayed, true, 'same operationId + same payload must replay');
  assert.equal(replay.revision, 1, 'replay must not bump the revision');
  assert.deepEqual(replay.result, payload.result);
  assert.equal(readCanvasState(fixture.store.storeDir, 'canvas-fixture-a').revision, 1);
  await toolError(fixture.client, 'canvas_read_receipt', { canvasId: 'canvas-fixture-a', operationId: 'op-missing-receipt' }, 'CANVAS_RECEIPT_NOT_FOUND');
  note('receipt matches the execution, payloadHash independently recomputed, replay is idempotent');
}

// ---------------------------------------------------------------------------------------
// C10 — isolation & security
// ---------------------------------------------------------------------------------------
async function c10IsolationSecurity() {
  // 1) Real scanner subprocess on the publishable tree.
  const scanRun = await runCommand(process.execPath, [path.join('scripts', 'verify', 'scan-secrets.mjs'), '--json'], { cwd: ROOT });
  recordCommand(`${process.execPath} scripts/verify/scan-secrets.mjs --json`, scanRun.code, scanRun.stdout.slice(0, 1500));
  assert.equal(scanRun.code, 0, `scan-secrets must exit 0 on the publishable tree\n${scanRun.stderr}`);
  let report;
  try {
    report = JSON.parse(scanRun.stdout);
  } catch {
    assert.fail(`scan-secrets --json output is not JSON: ${scanRun.stdout.slice(0, 500)}`);
  }
  assert.equal(report.result, 'CLEAN');
  assert.equal(report.counts.failures, 0, `scanner failures: ${JSON.stringify(report.findings.filter((finding) => !finding.allowlisted))}`);
  assert.ok(report.filesScanned > 0, 'scanner must scan at least one file');
  const genericRuleIds = [
    'absolute-user-path',
    'private-url',
    'email-address',
    'real-asset-reference',
    'generic-business-material',
    'real-run-identifier',
  ];
  for (const ruleId of genericRuleIds) {
    assert.equal(
      report.findings.some((finding) => finding.ruleId === ruleId && !finding.allowlisted),
      false,
      `scanner reported a real ${ruleId} finding`,
    );
  }
  // Internal audit runs include the optional local-only restricted-term policy so C10 stays strict;
  // a public checkout without that file is clearly reported as a generic-only (degraded) scan.
  if (report.restrictedTerms?.loaded === true) {
    assert.ok(
      report.restrictedTerms.ruleIds.length >= 10,
      `local restricted policy must contain the full internal rule set, got ${report.restrictedTerms.ruleIds.length}`,
    );
    for (const ruleId of report.restrictedTerms.ruleIds) {
      assert.equal(
        report.findings.some((finding) => finding.ruleId === ruleId && !finding.allowlisted),
        false,
        `scanner reported a real restricted finding for ${ruleId}`,
      );
    }
    log(
      `scanner: ${report.filesScanned} files, ${report.counts.allowlisted} allowlisted fictional demo/fixture references, 0 failures, ` +
        `${report.restrictedTerms.ruleIds.length} local-only restricted rules active (strict internal mode)`,
    );
  } else {
    log(
      `scanner: ${report.filesScanned} files, ${report.counts.allowlisted} allowlisted fictional demo/fixture references, 0 failures, ` +
        'GENERIC-ONLY mode (local-only restricted policy absent — degraded, public-checkout expectation)',
    );
  }

  // 2) Static analysis of src/: node builtins/relative imports only, no network/exec APIs,
  //    no absolute developer paths, and no restricted-material findings (the scanner above applies
  //    the full generic + optional local-only restricted policy to every src file).
  assert.equal(
    report.findings.some((finding) => !finding.allowlisted && finding.file.split(/[\\/]/)[0] === 'src'),
    false,
    'scanner reported a restricted finding in src/',
  );
  const importPattern = /(?:import\s+(?:[^'"]*?\s+from\s+)?|export\s+[^'"]*?\s+from\s+|import\s*\(\s*)['"]([^'"]+)['"]/g;
  const networkApiPattern = /\b(?:fetch\s*\(|XMLHttpRequest|WebSocket|https?\.request\s*\(|https?\.get\s*\(|net\.connect|dns\.lookup|child_process|execSync|spawnSync|execFileSync)\b/;
  const srcFiles = walkDir(path.join(ROOT, 'src')).filter((entry) => !entry.isDir);
  assert.ok(srcFiles.length > 0);
  for (const entry of srcFiles) {
    const text = fs.readFileSync(entry.abs, 'utf8');
    let match;
    while ((match = importPattern.exec(text)) !== null) {
      assert.ok(
        match[1].startsWith('node:') || match[1].startsWith('./') || match[1].startsWith('../'),
        `src import must be a node builtin or relative module, found "${match[1]}" in ${entry.rel}`,
      );
    }
    assert.equal(networkApiPattern.test(text), false, `src must not perform network/exec calls (${entry.rel})`);
    assert.equal(/node:(?:http|https|net|dns|tls|dgram|http2|child_process)['"]/.test(text), false, `src must not import network/exec builtins (${entry.rel})`);
    assert.equal(/\/Users\/|\/home\/|\/private\/var\/folders\//.test(text), false, `src contains an absolute developer path (${entry.rel})`);
    assert.equal(/require\s*\(\s*['"](?!node:)/.test(text), false, `src must not use CJS require for packages (${entry.rel})`);
  }
  log(`static src scan: ${srcFiles.length} files, builtins-only imports, no network/exec, no absolute paths, no restricted-material findings`);

  // 3) package.json dependency contract: zero runtime dependencies, one exact devDependency.
  const pkgRun = await runCommand(process.execPath, ['-p', "JSON.stringify(require('./package.json'))"], { cwd: ROOT });
  recordCommand(`${process.execPath} -p "JSON.stringify(require('./package.json'))"`, pkgRun.code);
  assert.equal(pkgRun.code, 0);
  const pkg = JSON.parse(pkgRun.stdout);
  assert.equal(pkg.name, SERVER_NAME);
  assert.equal(pkg.version, SERVER_VERSION);
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.engines.node, '>=20.0.0');
  assert.deepEqual(pkg.bin, { 'jiflow-canvas-mcp': 'src/server/main.mjs' });
  assert.ok(!pkg.dependencies || Object.keys(pkg.dependencies).length === 0, 'zero runtime dependencies required');
  assert.deepEqual(pkg.devDependencies, { '@modelcontextprotocol/sdk': '1.30.0' });
  for (const script of ['start', 'seed:demo', 'demo', 'demo:conflict', 'test', 'test:acceptance', 'audit:secrets']) {
    assert.equal(typeof pkg.scripts[script], 'string', `package.json missing script ${script}`);
  }
  log('package.json: zero runtime deps, devDependency @modelcontextprotocol/sdk pinned 1.30.0, required scripts present');

  // 4) No .env files anywhere in the publishable tree.
  const envFiles = walkDir(ROOT)
    .filter((entry) => !entry.isDir)
    .filter((entry) => !entry.rel.split(path.sep).some((part) => ['node_modules', evidenceDirName(), 'audit', '.git'].includes(part)))
    .filter((entry) => /(^|[\\/])\.env(?:\.|$)/.test(entry.rel));
  assert.deepEqual(envFiles.map((entry) => entry.rel), [], 'no .env files may be committed');

  // 5) No network/paid API endpoints or real assets in runtime code (fixtures use example.com).
  const examplesFiles = fs.existsSync(path.join(ROOT, 'examples')) ? walkDir(path.join(ROOT, 'examples')).filter((entry) => !entry.isDir) : [];
  for (const entry of [...srcFiles, ...examplesFiles]) {
    const text = fs.readFileSync(entry.abs, 'utf8');
    const assetUrls = text.match(/https?:\/\/[^\s"'`<>)]+\.(?:png|jpe?g|gif|webp|svg|mp4|mov|webm|mp3|wav|m4a|aac)/gi) ?? [];
    for (const url of assetUrls) {
      assert.ok(
        /^https?:\/\/[^/\s]*(?:example\.(?:com|org|net|invalid)|localhost|127\.0\.0\.1)/i.test(url),
        `only fictional example.com assets are allowed, found ${url} in ${entry.rel}`,
      );
    }
  }
  note('no secret/PII/private-reference/generic-business or restricted-material findings; runtime is Node-builtins-only with no network or paid calls');
}

function evidenceDirName() {
  return path.basename(EVIDENCE_DIR);
}

// ---------------------------------------------------------------------------------------
// C11 — automated test suite
// ---------------------------------------------------------------------------------------
async function c11AutomatedTestSuite() {
  log('running the full automated suite: npm test (node --test)');
  if (resolveNpmCli() === null && !process.env.npm_execpath) {
    throw new Error(
      'npm CLI could not be located (C11 environment problem, not a code failure). ' +
        'Run via `npm run test:acceptance`, or set CANVAS_MCP_NPM_CLI to the absolute path of npm-cli.js.',
    );
  }
  const run = await runNpm(['test'], { cwd: ROOT, timeoutMs: 300_000 });
  recordCommand(run.commandLine, run.code, `${run.stdout}\n${run.stderr}`.slice(-4000));
  fs.writeFileSync(path.join(LOGS_DIR, 'npm-test.log'), `$ ${run.commandLine}\n[exit ${run.code}]\n\n${run.stdout}\n${run.stderr}\n`, 'utf8');
  const counts = {
    tests: Number((run.stdout.match(/^ℹ tests (\d+)$/m) ?? [])[1]),
    pass: Number((run.stdout.match(/^ℹ pass (\d+)$/m) ?? [])[1]),
    fail: Number((run.stdout.match(/^ℹ fail (\d+)$/m) ?? [])[1]),
    suites: Number((run.stdout.match(/^ℹ suites (\d+)$/m) ?? [])[1]),
  };
  assert.equal(run.code, 0, `npm test must exit 0 (got ${run.code})\n${run.stdout.slice(-3000)}\n${run.stderr.slice(-3000)}`);
  assert.ok(Number.isFinite(counts.tests) && counts.tests > 0, 'could not parse the test count from npm test output');
  assert.equal(counts.fail, 0, 'npm test reported failing tests');
  assert.equal(counts.pass, counts.tests, 'all discovered tests must pass');
  note(`npm test: ${counts.tests} tests / ${counts.suites} suites, ${counts.pass} pass, ${counts.fail} fail, exit ${run.code} (raw log evidence/logs/npm-test.log)`);
}

// ---------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------
async function collectEnvironment() {
  const npmVersion = await runNpm(['--version'], { cwd: ROOT }).catch((error) => ({ code: -1, stdout: `unavailable: ${error.message}` }));
  return {
    node: process.version,
    nodeExecPath: process.execPath,
    npm: String(npmVersion.stdout ?? '').trim(),
    platform: `${process.platform} ${process.arch}`,
    osRelease: os.release(),
    cwd: ROOT,
    npmCli: resolveNpmCli(),
    protocol: 'newline-delimited JSON-RPC 2.0 over stdio (real child processes)',
  };
}

async function main() {
  const environment = await collectEnvironment();
  console.log('jiflow-canvas-mcp acceptance matrix');
  console.log(`environment: node=${environment.node} npm=${environment.npm} platform=${environment.platform}`);
  console.log('no MCP protocol mocking: every check spawns real servers and speaks real stdio JSON-RPC\n');

  const matrix = [
    ['C01_standalone_start', 'Standalone start from temp copy of src+package.json (no node_modules, no network)', c01StandaloneStart],
    ['C02_mcp_handshake', 'MCP handshake: raw JSON-RPC + official @modelcontextprotocol/sdk 1.30.0 Client', c02McpHandshake],
    ['C03_read_canvas', 'Read canvas/nodes returns the fictional fixture exactly', c03ReadCanvas],
    ['C04_create_node', 'Create node persisted in an isolated store file + receipt', c04CreateNode],
    ['C05_patch_node', 'Patch node updates content/position and revision', c05PatchNode],
    ['C06_connect_nodes', 'Connect nodes persists a capability-valid edge', c06ConnectNodes],
    ['C07_concurrency_conflict', 'Stale-revision conflict: exactly one winner across processes; retry succeeds', c07ConcurrencyConflict],
    ['C08_unauthorized_rejected', 'READ_ONLY/scope/allowedTools/whitelist-bypass/traversal all rejected', c08UnauthorizedRejected],
    ['C09_operation_receipt', 'Receipt matches execution; payloadHash independently recomputed; replay is idempotent', c09OperationReceipt],
    ['C10_isolation_security', 'No restricted/secret/PII/private-reference material; no network/paid calls; builtins-only', c10IsolationSecurity],
    ['C11_automated_test_suite', 'Full automated suite (npm test) captured as evidence', c11AutomatedTestSuite],
  ];

  try {
    for (const [id, title, fn] of matrix) {
      await runCheck(id, title, fn);
    }
  } finally {
    rmrf(TMP_ROOT);
    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
    const overallStatus = checks.length === matrix.length && checks.every((check) => check.status === 'PASS') ? 'PASS' : 'FAIL';
    const results = {
      generatedAt: new Date().toISOString(),
      environment,
      overallStatus,
      checks: checks.map((check) => ({
        id: check.id,
        title: check.title,
        status: check.status,
        evidence: check.evidence,
        notes: check.notes,
        startedAt: check.startedAt,
        finishedAt: check.finishedAt,
      })),
    };
    fs.writeFileSync(RESULTS_PATH, `${JSON.stringify(results, null, 2)}\n`, 'utf8');

    const header = ['CHECK'.padEnd(28), 'STATUS'.padEnd(7), 'NOTES'].join(' | ');
    console.log(`\n${header}`);
    console.log('-'.repeat(header.length + 20));
    for (const check of results.checks) {
      console.log(`${check.id.padEnd(28)} | ${check.status.padEnd(7)} | ${(check.notes[check.notes.length - 1] ?? '').slice(0, 110)}`);
    }
    const passed = results.checks.filter((check) => check.status === 'PASS').length;
    console.log(`\nOVERALL: ${overallStatus} (${passed}/${results.checks.length} checks passed)`);
    console.log(`results: ${RESULTS_PATH}`);
    for (const check of results.checks) console.log(`log: ${check.evidence.logFile}`);
    process.exitCode = overallStatus === 'PASS' ? 0 : 1;
  }
}

main().catch((error) => {
  console.error('acceptance runner crashed:', error);
  rmrf(TMP_ROOT);
  process.exitCode = 1;
});
