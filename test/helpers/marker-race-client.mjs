// Test helper: spawn real marker-race worker processes and inspect their shared journal.
//
// The worker (`marker-race-worker.mjs`) is a genuine OS child process importing the production
// lock/guard/marker/store modules. This file only orchestrates (spawn, barrier files, result JSON,
// journal analysis) — the safety core itself is never mocked.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..', '..');
export const WORKER_ENTRY = path.join(HERE, 'marker-race-worker.mjs');

export const internals = await import(pathToFileURL(path.join(REPO_ROOT, 'src', 'store', 'lock-internals.js')).href);

export function randomSuffix() {
  return randomBytes(4).toString('hex');
}

export function createRaceDir(prefix = 'canvas-mcp-test-race-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function readJsonIfExists(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export function readRawIfExists(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export function readJournal(journalPath) {
  let text;
  try {
    text = fs.readFileSync(journalPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { parseError: line };
      }
    });
}

export async function waitForFile(filePath, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) return true;
    await sleep(2);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${filePath}`);
}

export async function waitForJournal(journalPath, predicate, timeoutMs = 20_000, label = 'journal event') {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = readJournal(journalPath).find(predicate);
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
    await sleep(5);
  }
}

export function listFilesRecursive(dir) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRecursive(abs));
    else out.push(abs);
  }
  return out;
}

/** Remaining entries inside `<store>/.locks` (fence files persist by design). */
export function listLockArtifacts(storeDir) {
  try {
    return fs.readdirSync(path.join(storeDir, '.locks'));
  } catch {
    return [];
  }
}

/** True when any file under .locks still contains the given token string (lost-marker proof). */
export function tokenStillPresent(storeDir, token) {
  for (const file of listFilesRecursive(path.join(storeDir, '.locks'))) {
    try {
      if (fs.readFileSync(file, 'utf8').includes(token)) return file;
    } catch {
      // ignore transient temp files
    }
  }
  return null;
}

/**
 * Spawn one real marker-race worker.
 * spec must include: mode, role, storeDir, canvasId, journalPath, barrierDir, resultPath.
 */
export function spawnMarkerWorker(spec, { logPrefix = '' } = {}) {
  const specDir = path.join(spec.barrierDir, 'specs');
  fs.mkdirSync(specDir, { recursive: true });
  const specPath = path.join(specDir, `spec-${spec.role}-${process.pid}-${randomSuffix()}.json`);
  fs.writeFileSync(specPath, `${JSON.stringify(spec)}\n`, 'utf8');
  const logDir = path.join(spec.barrierDir, 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const logFd = fs.openSync(path.join(logDir, `${logPrefix}${spec.role}-${randomSuffix()}.log`), 'w');
  const child = spawn(process.execPath, [WORKER_ENTRY, '--spec', specPath], {
    cwd: REPO_ROOT,
    stdio: ['ignore', logFd, logFd],
  });
  const exitPromise = new Promise((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }));
    child.on('error', (error) => resolve({ code: null, signal: null, error }));
  });
  return {
    child,
    pid: child.pid,
    spec,
    exitPromise,
    async waitExit(timeoutMs = 60_000) {
      let timer;
      const timeoutPromise = new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
      });
      const outcome = await Promise.race([exitPromise, timeoutPromise]);
      clearTimeout(timer);
      if (outcome === null) {
        try {
          child.kill('SIGKILL');
        } catch {
          // already gone
        }
        throw new Error(`worker ${spec.mode}/${spec.role} did not exit within ${timeoutMs}ms`);
      }
      return outcome;
    },
    async result(timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const parsed = readJsonIfExists(spec.resultPath);
        if (parsed !== null) return parsed;
        await sleep(5);
      }
      throw new Error(`worker ${spec.mode}/${spec.role} produced no result within ${timeoutMs}ms`);
    },
    kill(signal = 'SIGKILL') {
      try {
        child.kill(signal);
      } catch {
        // already gone
      }
    },
  };
}

/** Wait for a child's exit + result together. */
export async function runMarkerWorker(spec, timeoutMs = 60_000) {
  const handle = spawnMarkerWorker(spec);
  const exit = await handle.waitExit(timeoutMs);
  const result = await handle.result();
  return { handle, exit, result };
}

/** Write a valid v1 owner record file (write lock / recovery marker / recovery guard shape). */
export function writeOwnerRecord(filePath, record) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(record)}\n`, 'utf8');
  return filePath;
}

/** Age a record file's mtime into the past (dead-owner/marker age-gate fixture). */
export function ageFile(filePath, ageMs) {
  const when = new Date(Date.now() - ageMs);
  fs.utimesSync(filePath, when, when);
}

/** Build a v1 owner record object with fictional token/identity. */
export function makeOwnerRecord({
  canvasId,
  pid,
  token,
  hostname = os.hostname(),
  fence = 0,
}) {
  return {
    version: 1,
    canvasId,
    token,
    pid,
    hostname,
    acquiredAt: new Date().toISOString(),
    fence,
  };
}

/** Wait for a worker-written barrier marker file. */
export function signalBarrier(barrierDir, name) {
  fs.writeFileSync(path.join(barrierDir, name), '1');
}

export function barrierPath(barrierDir, name) {
  return path.join(barrierDir, name);
}
