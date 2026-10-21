// Test helper: build deterministic, valid file-backed canvas stores per the documented contract/§5.
// All data is fictional (example.com URLs, generic canvas vocabulary).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

export const TMP_BASE = os.tmpdir();
export const FIXTURE_NOW = '2026-10-21T00:00:00.000Z';

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Create a unique temp directory. Caller owns cleanup. */
export function createTempDir(prefix = 'canvas-mcp-test-') {
  return fs.mkdtempSync(path.join(TMP_BASE, prefix));
}

export function rmrf(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

/** A node in the on-disk canvas shape: {id,type,position,data:{nodeType,...}}. */
export function makeNode(kind, id, { position = { x: 0, y: 0 }, data = {} } = {}) {
  return { id, type: kind, position: { x: position.x, y: position.y }, data: { nodeType: kind, ...data } };
}

export function makeEdge({ id, source, target, relation }) {
  return { id, source, target, relation };
}

/** Complete on-disk canvas state object (the documented contract Canvas state file). */
export function makeCanvasState({
  canvasId,
  name = `Fixture canvas ${canvasId}`,
  revision = 0,
  nodes = [],
  edges = [],
  tombstones = { nodes: [], edges: [] },
  receipts = {},
  createdAt = FIXTURE_NOW,
  updatedAt = FIXTURE_NOW,
} = {}) {
  return {
    storeVersion: 1,
    canvas: { canvasId, name, createdAt },
    revision,
    data: { nodes, edges },
    tombstones: { nodes: [...tombstones.nodes], edges: [...tombstones.edges] },
    receipts: { ...receipts },
    updatedAt,
  };
}

/** The shared fictional fixture returned byte-exactly by C03. */
export function fixtureCanvasState(canvasId = 'canvas-fixture-a') {
  return makeCanvasState({
    canvasId,
    name: 'Fixture canvas A',
    revision: 0,
    nodes: [
      makeNode('text', 'node-text-1', {
        data: { label: 'Fixture text', content: 'Hello fixture', status: 'idle' },
      }),
      makeNode('image', 'node-image-1', {
        data: {
          label: 'Fixture image',
          url: 'https://example.com/fixture-image.png',
          mimeType: 'image/png',
        },
      }),
      makeNode('video', 'node-video-1', {
        data: { label: 'Fixture video', status: 'idle' },
      }),
    ],
    edges: [makeEdge({ id: 'edge-image-video', source: 'node-image-1', target: 'node-video-1', relation: 'reference' })],
  });
}

export function fixtureCanvasStateB(canvasId = 'canvas-fixture-b') {
  return makeCanvasState({
    canvasId,
    name: 'Fixture canvas B',
    revision: 0,
    nodes: [
      makeNode('note', 'node-note-1', { data: { label: 'Fixture note', content: 'Note body' } }),
    ],
    edges: [],
  });
}

export function defaultFixtureCanvases() {
  return [fixtureCanvasState('canvas-fixture-a'), fixtureCanvasStateB('canvas-fixture-b')];
}

export function canvasFilePath(storeDir, canvasId) {
  return path.join(storeDir, 'canvases', `${canvasId}.json`);
}

/** Path of the JSON lock owner file (`<canvas>.lock`, a file, not a directory). */
export function lockFilePath(storeDir, canvasId) {
  return path.join(storeDir, '.locks', `${canvasId}.lock`);
}

/** Path of the monotonic lock fence file (`<canvas>.fence`). */
export function fenceFilePath(storeDir, canvasId) {
  return path.join(storeDir, '.locks', `${canvasId}.fence`);
}

/** Create <root>/store with canvases/ and .locks/ and optionally seed canvases. */
export function initStore(root, { canvases = [] } = {}) {
  const storeDir = path.join(root, 'store');
  fs.mkdirSync(path.join(storeDir, 'canvases'), { recursive: true });
  fs.mkdirSync(path.join(storeDir, '.locks'), { recursive: true });
  for (const state of canvases) writeCanvasState(storeDir, state);
  return storeDir;
}

export function writeCanvasState(storeDir, state) {
  const file = canvasFilePath(storeDir, state.canvas.canvasId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  return file;
}

export function writeRawCanvasFile(storeDir, canvasId, text) {
  const file = canvasFilePath(storeDir, canvasId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
  return file;
}

export function readCanvasFileRaw(storeDir, canvasId) {
  return fs.readFileSync(canvasFilePath(storeDir, canvasId), 'utf8');
}

export function readCanvasState(storeDir, canvasId) {
  return JSON.parse(readCanvasFileRaw(storeDir, canvasId));
}

/**
 * Convenience bundle: temp root + seeded store.
 * Returns {root, storeDir, ...helpers, cleanup()}.
 */
export function createFixtureStore({ prefix = 'canvas-mcp-fixture-', canvases = defaultFixtureCanvases() } = {}) {
  const root = createTempDir(prefix);
  const storeDir = initStore(root, { canvases });
  return {
    root,
    storeDir,
    writeState: (state) => writeCanvasState(storeDir, state),
    writeRaw: (canvasId, text) => writeRawCanvasFile(storeDir, canvasId, text),
    readState: (canvasId) => readCanvasState(storeDir, canvasId),
    readRaw: (canvasId) => readCanvasFileRaw(storeDir, canvasId),
    cleanup: () => rmrf(root),
  };
}

/** Recursively list entries under dir as {rel, abs, isDir}. Missing dir -> []. */
export function walkDir(dir) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    out.push({ rel: path.relative(dir, abs), abs, isDir: entry.isDirectory() });
    if (entry.isDirectory()) out.push(...walkDir(abs));
  }
  return out;
}

/** Absolute paths of stray .tmp-* files anywhere under the store. */
export function findTempFiles(storeDir) {
  return walkDir(storeDir)
    .filter((e) => !e.isDir && path.basename(e.abs).startsWith('.tmp-'))
    .map((e) => e.abs);
}

/**
 * Remaining `.lock` owner files inside <store>/.locks.
 * The per-canvas `<canvas>.fence` file persists by design (monotonic fence counter) and is
 * intentionally not reported here; only real lock files must be gone after release.
 */
export function listLocks(storeDir) {
  try {
    return fs.readdirSync(path.join(storeDir, '.locks')).filter((name) => name.endsWith('.lock'));
  } catch {
    return [];
  }
}

/** All regular files under a directory (absolute paths). */
export function listFilesRecursive(dir) {
  return walkDir(dir).filter((e) => !e.isDir).map((e) => e.abs);
}

/** Set the mtime of a lock owner file into the past (dead-owner age-gate fixture). */
export function ageLockFile(storeDir, canvasId, ageMs) {
  const file = lockFilePath(storeDir, canvasId);
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(file, t, t);
}

/** Read the raw lock owner record, or null when no lock file exists. */
export function readLockOwnerRaw(storeDir, canvasId) {
  try {
    return fs.readFileSync(lockFilePath(storeDir, canvasId), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

/** Read the parsed lock owner record, or null when no lock file exists. */
export function readLockOwner(storeDir, canvasId) {
  const raw = readLockOwnerRaw(storeDir, canvasId);
  return raw === null ? null : JSON.parse(raw);
}

/** Read the fence record, or null when the fence file does not exist. */
export function readFence(storeDir, canvasId) {
  try {
    return JSON.parse(fs.readFileSync(fenceFilePath(storeDir, canvasId), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

/** Write a valid fence record file (monotonic counter). */
export function writeFence(storeDir, canvasId, fence) {
  const file = fenceFilePath(storeDir, canvasId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ version: 1, fence })}\n`, 'utf8');
  return file;
}

/**
 * Build a valid v1 lock owner record (the on-disk lock protocol shape).
 * The default pid is the current (live) test process; pass the pid of an exited child
 * (`getExitedProcessPid()`) to build a provably dead owner fixture.
 */
export function makeLockOwnerRecord({
  canvasId,
  pid = process.pid,
  token = `fixture-token-${canvasId}`,
  hostname = os.hostname(),
  acquiredAt = new Date().toISOString(),
  fence = 1,
} = {}) {
  return { version: 1, canvasId, token, pid, hostname, acquiredAt, fence };
}

/**
 * Create a lock owner file by hand (valid JSON record), optionally aged into the past and
 * synchronised with an optional fence file. This replaces the legacy empty-directory fixture:
 * the lock is a JSON owner file, not a directory.
 */
export function createLockFile(
  storeDir,
  canvasId,
  { ageMs = 0, pid = process.pid, token, hostname, fence = 1, writeFenceFile = true } = {},
) {
  const file = lockFilePath(storeDir, canvasId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const record = makeLockOwnerRecord({ canvasId, pid, token, hostname, fence });
  fs.writeFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
  if (writeFenceFile) writeFence(storeDir, canvasId, fence);
  if (ageMs > 0) ageLockFile(storeDir, canvasId, ageMs);
  return file;
}

/** Write an arbitrary (possibly corrupt) raw lock file for fail-closed tests. */
export function writeRawLockFile(storeDir, canvasId, text) {
  const file = lockFilePath(storeDir, canvasId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
  return file;
}

/**
 * Spawn a real short-lived node process, wait until it has exited and been reaped, and return
 * its pid. `process.kill(pid, 0)` then reports ESRCH, i.e. a provably dead same-host owner that
 * the lock may recover after the age gate.
 */
export async function getExitedProcessPid() {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  const pid = child.pid;
  await new Promise((resolve, reject) => {
    child.on('exit', resolve);
    child.on('error', reject);
  });
  return pid;
}

export { fs, path, os };
