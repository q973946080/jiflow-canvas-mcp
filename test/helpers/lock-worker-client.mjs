// Test helper: spawn real lock-worker child processes and analyse their shared journal.
//
// Every worker in `lock-worker.mjs` is a genuine OS process importing the production modules;
// this file only provides orchestration (spawn, wait, result JSON, journal interval analysis).
// No lock/safety code is mocked.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..', '..');
const WORKER_ENTRY = path.join(HERE, 'lock-worker.mjs');

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function randomSuffix() {
  return randomBytes(4).toString('hex');
}

/** Create a scratch directory for one test (caller cleans up). */
export function createWorkerDir(prefix = 'canvas-mcp-lock-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function readJsonIfExists(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
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
  const records = [];
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      records.push({ t: Date.now(), parseError: line });
    }
  }
  return records;
}

export async function waitForFile(filePath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) return true;
    await sleep(2);
  }
  return false;
}

export async function waitForJournal(journalPath, predicate, timeoutMs, label = 'journal event') {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = readJournal(journalPath).find(predicate);
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
    await sleep(5);
  }
}

/** Critical sections as {pid, enterT, exitT} intervals derived from cs-enter/cs-exit journal events. */
export function criticalSections(records) {
  const sections = [];
  const open = new Map();
  for (const record of [...records].sort((a, b) => a.t - b.t)) {
    if (record.event === 'cs-enter') {
      const list = open.get(record.pid) ?? [];
      list.push(record);
      open.set(record.pid, list);
    } else if (record.event === 'cs-exit') {
      const list = open.get(record.pid);
      if (!list || list.length === 0) continue;
      const enter = list.shift();
      sections.push({ pid: record.pid, mode: record.mode, enterT: enter.t, exitT: record.t });
    }
  }
  return sections;
}

/** All pairs of critical sections whose wall-clock intervals overlap. */
export function overlappingPairs(sections) {
  const pairs = [];
  for (let i = 0; i < sections.length; i += 1) {
    for (let j = i + 1; j < sections.length; j += 1) {
      const a = sections[i];
      const b = sections[j];
      if (a.enterT < b.exitT && b.enterT < a.exitT) pairs.push([a, b]);
    }
  }
  return pairs;
}

/** Read a directory's entries, returning [] when it does not exist. */
export function listDirectory(dir) {
  try {
    return fs.readdirSync(dir);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

/** Assign a stable unique result/journal/ready path triplet for one worker. */
export function workerPaths(workDir, label) {
  return {
    resultPath: path.join(workDir, `result-${label}.json`),
    readyPath: path.join(workDir, `ready-${label}`),
    ready2Path: path.join(workDir, `ready2-${label}`),
    releasePath: path.join(workDir, `release-${label}`),
  };
}

/**
 * Spawn one real worker process for `spec` (which must include resultPath/journalPath).
 * Returns a handle with {child, pid, exitPromise, waitExit, result, kill, logPath}.
 */
export function spawnLockWorker(spec) {
  const dir = path.dirname(spec.resultPath);
  const specPath = path.join(dir, `spec-${process.pid}-${randomSuffix()}.json`);
  fs.writeFileSync(specPath, `${JSON.stringify(spec)}\n`, 'utf8');
  const logPath = path.join(dir, `child-${spec.mode}-${process.pid}-${randomSuffix()}.log`);
  const logFd = fs.openSync(logPath, 'w');
  const child = spawn(process.execPath, [WORKER_ENTRY, '--spec', specPath], {
    cwd: REPO_ROOT,
    stdio: ['ignore', logFd, logFd],
  });
  const exitPromise = new Promise((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }));
    child.on('error', (error) => resolve({ code: null, signal: null, error }));
  });
  const handle = {
    child,
    pid: child.pid,
    spec,
    logPath,
    exitPromise,
    async waitExit(timeoutMs = 30_000) {
      // Always clear the timeout timer: an uncleared sleep() would keep the test runner's event
      // loop alive for the whole timeout even after the child exited (and made the suite slow).
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
        throw new Error(`worker ${spec.mode} (pid ${child.pid}) did not exit within ${timeoutMs}ms`);
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
      throw new Error(`worker ${spec.mode} (pid ${child.pid}) produced no result within ${timeoutMs}ms`);
    },
    kill(signal = 'SIGKILL') {
      try {
        child.kill(signal);
      } catch {
        // already gone
      }
    },
  };
  return handle;
}

/** Spawn + wait for exit + return {result, exit, handle}. */
export async function runLockWorker(spec, timeoutMs = 60_000) {
  const handle = spawnLockWorker(spec);
  const exit = await handle.waitExit(timeoutMs);
  const result = await handle.result();
  return { result, exit, handle };
}
