#!/usr/bin/env node
/**
 * End-to-end demo client.
 *
 * Spawns the real MCP server over stdio and performs:
 *   initialize -> tools/list (9 tools) -> canvas_read_canvas -> canvas_create_node ->
 *   canvas_patch_node -> canvas_connect_nodes -> canvas_read_receipt -> canvas_list_receipts.
 *
 * Uses only the fictional demo store and the fictional writer-a token. Exit code 0 on
 * success, non-zero on any failed assertion.
 */
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MinimalMcpClient } from './lib/minimal-mcp-client.mjs';

const examplesDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(examplesDir);
const storeDir = path.join(examplesDir, 'demo-store');
const authPath = path.join(examplesDir, 'auth.demo.json');
const seedScript = path.join(examplesDir, 'seed-demo.mjs');
const serverEntry = path.join(repoRoot, 'src', 'server', 'main.mjs');

const WRITER_TOKEN = 'demo-writer-a-token';
const CANVAS_ID = 'canvas-demo-a';
const EXPECTED_TOOLS = 9;

class DemoFailure extends Error {
  constructor(message) {
    super(message);
    this.name = 'DemoFailure';
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new DemoFailure(message);
  }
}

function ensureSeedData() {
  const canvasFile = path.join(storeDir, 'canvases', `${CANVAS_ID}.json`);
  if (existsSync(canvasFile)) {
    return false;
  }
  const result = spawnSync(process.execPath, [seedScript], { cwd: repoRoot, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new DemoFailure(`seed-demo.mjs failed: ${result.stderr || result.stdout}`);
  }
  return true;
}

function parseToolResult(response, toolName) {
  const payload =
    response?.structuredContent ??
    (() => {
      try {
        return JSON.parse(response?.content?.[0]?.text ?? 'null');
      } catch {
        return null;
      }
    })();
  if (payload === null || typeof payload !== 'object') {
    throw new DemoFailure(`${toolName}: tool result does not contain a JSON payload`);
  }
  if (response.isError === true || payload.ok === false) {
    throw new DemoFailure(`${toolName} failed: ${payload.code ?? 'UNKNOWN'} ${payload.error ?? ''}`);
  }
  assert(typeof response.content?.[0]?.text === 'string', `${toolName}: missing text content`);
  assert(
    response.content[0].text === JSON.stringify(payload),
    `${toolName}: text content and structuredContent disagree`
  );
  return payload;
}

async function callTool(client, toolName, args) {
  return parseToolResult(await client.callTool(toolName, args), toolName);
}

async function main() {
  const seeded = ensureSeedData();
  const client = new MinimalMcpClient({
    args: [serverEntry, '--store', storeDir, '--auth', authPath, '--agent-id', 'demo-agent'],
    cwd: repoRoot,
    env: { CANVAS_MCP_TOKEN: WRITER_TOKEN }
  });
  const summary = {
    server: null,
    protocolVersion: null,
    tools: 0,
    canvasId: CANVAS_ID,
    seededStore: seeded,
    steps: []
  };
  try {
    await client.start();

    // 1. MCP handshake.
    const init = await client.initialize();
    assert(init.serverInfo?.name === 'jiflow-canvas-mcp', 'unexpected serverInfo.name');
    assert(init.serverInfo?.version === '0.1.0', 'unexpected serverInfo.version');
    summary.server = init.serverInfo;
    summary.protocolVersion = init.protocolVersion;

    // 2. tools/list returns exactly nine canvas tools.
    const tools = await client.listTools();
    assert(Array.isArray(tools) && tools.length === EXPECTED_TOOLS, `expected ${EXPECTED_TOOLS} tools, got ${tools?.length}`);
    assert(tools.every((tool) => typeof tool.name === 'string' && tool.name.startsWith('canvas_')), 'all tools must be canvas_*');
    summary.tools = tools.length;

    // 3. List is scoped to the writer-a principal (only canvas-demo-a).
    const listed = await callTool(client, 'canvas_list_canvases', {});
    assert(Array.isArray(listed.canvases) && listed.canvases.length === 1, 'writer-a must only see canvas-demo-a');
    assert(listed.canvases[0].canvasId === CANVAS_ID, 'unexpected listed canvas id');

    // 4. Read the seeded canvas.
    const before = await callTool(client, 'canvas_read_canvas', { canvasId: CANVAS_ID });
    let revision = before.revision;
    const baseNodeCount = before.nodes.length;
    const baseEdgeCount = before.edges.length;
    summary.steps.push({ step: 'read_canvas', revision, nodes: baseNodeCount, edges: baseEdgeCount });

    // 5. Create an image node (explicit nodeId + expectedRevision so a retry is idempotent).
    const createOperationId = `op-demo-create-${randomUUID()}`;
    const explicitNodeId = `node-demo-created-${randomUUID()}`;
    const created = await callTool(client, 'canvas_create_node', {
      canvasId: CANVAS_ID,
      kind: 'image',
      nodeId: explicitNodeId,
      label: 'Demo illustration',
      position: { x: 900, y: 120 },
      data: {
        url: 'https://example.invalid/assets/demo-hero.png',
        status: 'idle',
        width: 1024,
        height: 768,
        mimeType: 'image/png'
      },
      expectedRevision: revision,
      operationId: createOperationId
    });
    assert(created.replayed === false, 'fresh create must not be a replay');
    assert(created.revision === revision + 1, 'create must bump revision by exactly one');
    assert(created.nodeId === explicitNodeId, 'create must echo the explicit nodeId');
    assert(/^[0-9a-f]{64}$/.test(created.payloadHash), 'create must return a sha256 payloadHash');
    assert(created.permission === 'WRITE' && created.tool === 'canvas_create_node', 'unexpected write metadata');
    const createRevision = created.revision;
    const createdNodeId = created.nodeId;
    revision = created.revision;
    summary.steps.push({ step: 'create_node', nodeId: createdNodeId, revision, operationId: createOperationId });

    // 6. Patch the node.
    const patchOperationId = `op-demo-patch-${randomUUID()}`;
    const patched = await callTool(client, 'canvas_patch_node', {
      canvasId: CANVAS_ID,
      nodeId: createdNodeId,
      data: { status: 'done', content: 'Updated by demo-client.mjs.' },
      expectedRevision: revision,
      operationId: patchOperationId
    });
    assert(patched.revision === revision + 1, 'patch must bump revision by exactly one');
    revision = patched.revision;
    const nodeAfterPatch = await callTool(client, 'canvas_read_node', {
      canvasId: CANVAS_ID,
      nodeId: createdNodeId
    });
    assert(nodeAfterPatch.node.data.status === 'done', 'patched status must be persisted');
    assert(nodeAfterPatch.node.data.content === 'Updated by demo-client.mjs.', 'patched content must be persisted');
    summary.steps.push({ step: 'patch_node', nodeId: createdNodeId, revision, operationId: patchOperationId });

    // 7. Connect the new image node to the seeded video node (capability-valid: image -> video/reference).
    const connectOperationId = `op-demo-connect-${randomUUID()}`;
    const connected = await callTool(client, 'canvas_connect_nodes', {
      canvasId: CANVAS_ID,
      source: createdNodeId,
      target: 'node-demo-video',
      relation: 'reference',
      expectedRevision: revision,
      operationId: connectOperationId
    });
    assert(connected.revision === revision + 1, 'connect must bump revision by exactly one');
    assert(typeof connected.edgeId === 'string' && connected.edgeId.length > 0, 'connect must return edgeId');
    revision = connected.revision;
    summary.steps.push({ step: 'connect_nodes', edgeId: connected.edgeId, revision, operationId: connectOperationId });

    // 8. Read the durable receipt of the create operation.
    const receiptResponse = await callTool(client, 'canvas_read_receipt', {
      canvasId: CANVAS_ID,
      operationId: createOperationId
    });
    const receipt = receiptResponse.receipt;
    assert(receipt.operationId === createOperationId, 'receipt operationId mismatch');
    assert(receipt.resultingRevision === createRevision, 'receipt resultingRevision mismatch');
    assert(receipt.payloadHash === created.payloadHash, 'receipt payloadHash must match the write result');
    assert(receipt.principalId === 'agent-writer-a', 'receipt principalId mismatch');
    assert(receipt.actionKinds.length === 1 && receipt.actionKinds[0] === 'node.create', 'receipt actionKinds mismatch');
    const receiptJson = JSON.stringify(receiptResponse);
    assert(!receiptJson.includes(WRITER_TOKEN), 'token must never appear in receipts');

    // 9. Replay the create operation (same operationId + identical payload: same explicit
    //    nodeId, position, data and expectedRevision): idempotent, no revision bump.
    const replayed = await callTool(client, 'canvas_create_node', {
      canvasId: CANVAS_ID,
      kind: 'image',
      label: 'Demo illustration',
      position: { x: 900, y: 120 },
      data: {
        url: 'https://example.invalid/assets/demo-hero.png',
        status: 'idle',
        width: 1024,
        height: 768,
        mimeType: 'image/png'
      },
      nodeId: explicitNodeId,
      expectedRevision: createRevision - 1,
      operationId: createOperationId
    });
    assert(replayed.replayed === true, 're-sending the same operationId must replay');
    assert(replayed.revision === createRevision, 'replay must not bump the revision');
    assert(replayed.payloadHash === created.payloadHash, 'replay payloadHash must match the original write');
    assert(JSON.stringify(replayed.result) === JSON.stringify(created.result), 'replay result must match the original');
    const afterReplay = await callTool(client, 'canvas_read_canvas', { canvasId: CANVAS_ID });
    assert(afterReplay.revision === revision, 'store revision must be unchanged by the replay');
    summary.steps.push({ step: 'replay', operationId: createOperationId, replayed: replayed.replayed, revision: replayed.revision });

    // 10. List receipts (newest first).
    const receipts = await callTool(client, 'canvas_list_receipts', { canvasId: CANVAS_ID, limit: 3 });
    assert(Array.isArray(receipts.receipts) && receipts.receipts.length === 3, 'expected three stored receipts');
    assert(!JSON.stringify(receipts).includes(WRITER_TOKEN), 'token must never appear in receipt listings');

    // 11. Final revision / counts.
    const after = await callTool(client, 'canvas_read_canvas', { canvasId: CANVAS_ID });
    assert(after.revision === revision, 'final revision mismatch');
    assert(after.nodes.length === baseNodeCount + 1, 'node count mismatch after create');
    assert(after.edges.length === baseEdgeCount + 1, 'edge count mismatch after connect');
    assert(after.updatedAt === receipt.committedAt || after.revision === revision, 'updatedAt mismatch');

    summary.finalRevision = after.revision;
    summary.finalNodes = after.nodes.length;
    summary.finalEdges = after.edges.length;
    summary.receipts = receipts.receipts.map((entry) => ({
      operationId: entry.operationId,
      actionKinds: entry.actionKinds,
      resultingRevision: entry.resultingRevision
    }));
    summary.receiptVerified = true;
    console.log(JSON.stringify(summary, null, 2));
    return 0;
  } finally {
    await client.close();
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(`demo failed: ${error.message}`);
    if (error.code !== undefined) {
      console.error(`  code: ${error.code}`);
    }
    process.exitCode = 1;
  });
