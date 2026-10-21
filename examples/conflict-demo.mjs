#!/usr/bin/env node
/**
 * Concurrent-writer demo: CAS conflict + retry + idempotent replay.
 *
 * Two independent real server processes (writer-a token, same canvas) both read revision R
 * and both attempt a create with `expectedRevision: R`. Exactly one wins; the loser receives
 * `CANVAS_REVISION_CONFLICT`, re-reads the revision and retries successfully. The winning
 * operation receipt is then replayed cross-process without bumping the revision.
 *
 * Exit code 0 when all assertions hold, non-zero otherwise.
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
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

function parsePayload(response) {
  const payload =
    response?.structuredContent ??
    (() => {
      try {
        return JSON.parse(response?.content?.[0]?.text ?? 'null');
      } catch {
        return null;
      }
    })();
  return payload;
}

async function readPayload(client, toolName, args) {
  const response = await client.callTool(toolName, args);
  const payload = parsePayload(response);
  assert(payload !== null, `${toolName}: missing payload`);
  if (response.isError === true || payload.ok === false) {
    throw new DemoFailure(`${toolName} failed: ${payload.code ?? 'UNKNOWN'}`);
  }
  return payload;
}

async function attemptCreate(client, args) {
  const response = await client.callTool('canvas_create_node', args);
  const payload = parsePayload(response);
  return { ok: response.isError !== true && payload?.ok !== false, payload };
}

function makeClient(label) {
  return new MinimalMcpClient({
    args: [serverEntry, '--store', storeDir, '--auth', authPath, '--agent-id', `demo-race-${label}`],
    cwd: repoRoot,
    env: { CANVAS_MCP_TOKEN: WRITER_TOKEN }
  });
}

async function main() {
  // Reset the demo store so the evidence starts from a deterministic revision 0.
  const seedResult = spawnSync(process.execPath, [seedScript], { cwd: repoRoot, encoding: 'utf8' });
  assert(seedResult.status === 0, `seed-demo.mjs failed: ${seedResult.stderr || seedResult.stdout}`);

  const clientA = makeClient('a');
  const clientB = makeClient('b');
  const evidence = {
    canvasId: CANVAS_ID,
    initialRevision: null,
    attempts: [],
    conflict: null,
    loserRetry: null,
    replay: null,
    finalRevision: null
  };
  try {
    await Promise.all([clientA.start(), clientB.start()]);
    await Promise.all([clientA.initialize(), clientB.initialize()]);

    // Both agents observe the same revision R.
    const [readA, readB] = await Promise.all([
      readPayload(clientA, 'canvas_read_canvas', { canvasId: CANVAS_ID }),
      readPayload(clientB, 'canvas_read_canvas', { canvasId: CANVAS_ID })
    ]);
    assert(readA.revision === readB.revision, 'both agents must observe the same revision');
    const initialRevision = readA.revision;
    evidence.initialRevision = initialRevision;

    const operationA = `op-race-a-${randomUUID()}`;
    const operationB = `op-race-b-${randomUUID()}`;
    const argsA = {
      canvasId: CANVAS_ID,
      kind: 'text',
      label: 'Race contender A',
      nodeId: `node-race-a-${randomUUID()}`,
      expectedRevision: initialRevision,
      operationId: operationA
    };
    const argsB = {
      canvasId: CANVAS_ID,
      kind: 'text',
      label: 'Race contender B',
      nodeId: `node-race-b-${randomUUID()}`,
      expectedRevision: initialRevision,
      operationId: operationB
    };

    // Both write concurrently with the same stale expectedRevision.
    const [resultA, resultB] = await Promise.all([
      attemptCreate(clientA, argsA),
      attemptCreate(clientB, argsB)
    ]);
    const successes = [resultA, resultB].filter((result) => result.ok);
    const failures = [resultA, resultB].filter((result) => !result.ok);
    assert(successes.length === 1, `expected exactly one winner, got ${successes.length}`);
    assert(failures.length === 1, `expected exactly one conflict, got ${failures.length}`);
    assert(failures[0].payload.code === 'CANVAS_REVISION_CONFLICT', `expected CANVAS_REVISION_CONFLICT, got ${failures[0].payload.code}`);
    assert(failures[0].payload.detail?.expectedRevision === initialRevision, 'conflict detail expectedRevision mismatch');
    assert(failures[0].payload.detail?.actualRevision === initialRevision + 1, 'conflict detail actualRevision mismatch');
    const loserIsA = !resultA.ok;
    const winner = successes[0].payload;
    const failed = failures[0].payload;
    const winningArgs = loserIsA ? argsB : argsA;
    const winningClient = loserIsA ? clientB : clientA;
    const loserClient = loserIsA ? clientA : clientB;
    const loserArgs = loserIsA ? argsA : argsB;
    evidence.attempts = [
      { agent: 'a', operationId: operationA, expectedRevision: initialRevision, ...(resultA.ok ? { outcome: 'success', revision: resultA.payload.revision } : { outcome: 'conflict', code: resultA.payload.code }) },
      { agent: 'b', operationId: operationB, expectedRevision: initialRevision, ...(resultB.ok ? { outcome: 'success', revision: resultB.payload.revision } : { outcome: 'conflict', code: resultB.payload.code }) }
    ];
    evidence.conflict = {
      code: failed.code,
      expectedRevision: failed.detail.expectedRevision,
      actualRevision: failed.detail.actualRevision,
      winnerRevision: winner.revision,
      winnerOperationId: winner.operationId
    };

    // The loser re-reads the revision and retries with a fresh operationId.
    const afterConflict = await readPayload(loserClient, 'canvas_read_canvas', { canvasId: CANVAS_ID });
    assert(afterConflict.revision === initialRevision + 1, 'winner must bump revision by exactly one');
    const retryOperationId = `op-race-retry-${randomUUID()}`;
    const retried = await readPayload(loserClient, 'canvas_create_node', {
      ...loserArgs,
      nodeId: `node-race-retry-${randomUUID()}`,
      expectedRevision: afterConflict.revision,
      operationId: retryOperationId
    });
    assert(retried.revision === afterConflict.revision + 1, 'retry must succeed and bump revision');
    evidence.loserRetry = { operationId: retryOperationId, revision: afterConflict.revision, newRevision: retried.revision, replayed: retried.replayed };

    // Cross-process replay of the winning operation: same operationId + same payload.
    const replayed = await readPayload(loserClient, 'canvas_create_node', winningArgs);
    assert(replayed.replayed === true, 'same operationId + payload must replay');
    assert(replayed.revision === winner.revision, 'replay must not bump the revision');
    assert(replayed.payloadHash === winner.payloadHash, 'replay payloadHash must match the original');
    assert(JSON.stringify(replayed.result) === JSON.stringify(winner.result), 'replay result must be byte-equivalent');
    evidence.replay = {
      operationId: replayed.operationId,
      replayed: replayed.replayed,
      revision: replayed.revision,
      payloadHash: replayed.payloadHash
    };

    // The losing operation must not have produced a receipt.
    const missingReceipt = await loserClient.callTool('canvas_read_receipt', {
      canvasId: CANVAS_ID,
      operationId: loserArgs.operationId
    });
    const missingPayload = parsePayload(missingReceipt);
    assert(missingReceipt.isError === true && missingPayload.code === 'CANVAS_RECEIPT_NOT_FOUND', 'conflicted operation must not persist a receipt');

    // Receipt of the winning operation matches the applied state.
    const receiptResponse = await readPayload(loserClient, 'canvas_read_receipt', {
      canvasId: CANVAS_ID,
      operationId: winner.operationId
    });
    assert(receiptResponse.receipt.resultingRevision === winner.revision, 'winner receipt resultingRevision mismatch');
    assert(receiptResponse.receipt.payloadHash === winner.payloadHash, 'winner receipt payloadHash mismatch');

    const finalCanvas = await readPayload(winningClient, 'canvas_read_canvas', { canvasId: CANVAS_ID });
    assert(finalCanvas.revision === initialRevision + 2, 'final revision must reflect winner + successful retry');
    evidence.finalRevision = finalCanvas.revision;
    evidence.receiptsVerified = true;
    console.log(JSON.stringify(evidence, null, 2));
    return 0;
  } finally {
    await Promise.allSettled([clientA.close(), clientB.close()]);
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(`conflict demo failed: ${error.message}`);
    if (error.code !== undefined) {
      console.error(`  code: ${error.code}`);
    }
    process.exitCode = 1;
  });
