// Test helper: spawn the real server as a child process (process.execPath, stdio pipes).
// No sockets, no ports; stderr is captured for assertions/diagnostics.
import { spawn } from 'node:child_process';
import { RawJsonRpcClient } from './rpc-client.mjs';
import { SERVER_ENTRY, REPO_ROOT, PROTOCOL_VERSION } from './paths.mjs';

const STDERR_MAX_LINES = 2000;

/** Build the CLI argument list for src/server/main.mjs from the documented contract. */
export function buildServerArgs({
  entry = SERVER_ENTRY,
  store,
  auth,
  agentId,
  lockTimeoutMs,
  staleLockMs,
} = {}) {
  const args = [entry];
  if (store !== undefined) args.push('--store', String(store));
  if (auth !== undefined) args.push('--auth', String(auth));
  if (agentId !== undefined) args.push('--agent-id', String(agentId));
  if (lockTimeoutMs !== undefined) args.push('--lock-timeout-ms', String(lockTimeoutMs));
  if (staleLockMs !== undefined) args.push('--stale-lock-ms', String(staleLockMs));
  return args;
}

/** Child env: never inherit a stray CANVAS_MCP_TOKEN from the test runner. */
export function buildServerEnv({ token, env = {}, clearToken = false } = {}) {
  const base = { ...process.env };
  delete base.CANVAS_MCP_TOKEN;
  if (clearToken) {
    delete base.CANVAS_MCP_TOKEN;
  }
  if (token !== undefined) base.CANVAS_MCP_TOKEN = token;
  return { ...base, ...env };
}

/**
 * Spawn a real server process.
 * options: {entry, args?, store, auth, token?, agentId?, lockTimeoutMs?, staleLockMs?, env?, cwd?}
 * token: undefined => env var absent; string (including '') => env var set to that value.
 */
export function spawnServer(options = {}) {
  const {
    entry = SERVER_ENTRY,
    args: explicitArgs,
    store,
    auth,
    token,
    agentId,
    lockTimeoutMs,
    staleLockMs,
    env = {},
    cwd = REPO_ROOT,
    clearToken = false,
  } = options;

  const argv = explicitArgs
    ? [entry, ...explicitArgs]
    : buildServerArgs({ entry, store, auth, agentId, lockTimeoutMs, staleLockMs });

  const child = spawn(process.execPath, argv, {
    cwd,
    env: buildServerEnv({ token, env, clearToken }),
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const state = {
    child,
    argv,
    cwd,
    exitInfo: null,
    stderrRaw: '',
    stderrLines: [],
    stdoutRaw: '',
    stdoutLines: [],
    exitPromise: null,
    _stderrBuffer: '',
    _stdoutBuffer: '',
    _lineWaiters: new Set(),
    _killed: false,
  };

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    state.stdoutRaw += chunk;
    state._stdoutBuffer += chunk;
    let idx;
    while ((idx = state._stdoutBuffer.indexOf('\n')) !== -1) {
      const line = state._stdoutBuffer.slice(0, idx);
      state._stdoutBuffer = state._stdoutBuffer.slice(idx + 1);
      if (line.trim() !== '') state.stdoutLines.push(line);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    state.stderrRaw += chunk;
    state._stderrBuffer += chunk;
    let idx;
    while ((idx = state._stderrBuffer.indexOf('\n')) !== -1) {
      const line = state._stderrBuffer.slice(0, idx);
      state._stderrBuffer = state._stderrBuffer.slice(idx + 1);
      if (line.trim() === '') continue;
      state.stderrLines.push(line);
      if (state.stderrLines.length > STDERR_MAX_LINES) state.stderrLines.shift();
      for (const waiter of [...state._lineWaiters]) waiter(line);
    }
  });
  child.on('error', () => {
    /* surfaced via exit / request errors */
  });
  child.stdin.on('error', () => {
    /* writing after exit in negative tests is expected */
  });

  state.exitPromise = new Promise((resolve) => {
    child.once('exit', (code, signal) => {
      state.exitInfo = { code, signal };
      resolve(state.exitInfo);
    });
  });

  const server = {
    ...state,
    get pid() {
      return child.pid;
    },
    get alive() {
      return state.exitInfo === null;
    },
    get args() {
      return argv;
    },
    /** Full command line (for evidence logs). */
    get commandLine() {
      return [process.execPath, ...argv].join(' ');
    },
    stderrText() {
      return state.stderrRaw;
    },
    stderrTail(lines = 20) {
      return state.stderrLines.slice(-lines).join('\n');
    },
    /** Wait for a stderr line matching predicate (rejects fast if the process exits first). */
    waitForStderrLine(predicate, { timeoutMs = 10_000 } = {}) {
      for (const line of state.stderrLines) {
        if (predicate(line)) return Promise.resolve(line);
      }
      if (state.exitInfo) {
        return Promise.reject(
          new Error(`server exited (code=${state.exitInfo.code} signal=${state.exitInfo.signal}) before a matching stderr line appeared\n--- stderr ---\n${server.stderrText()}`),
        );
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          state._lineWaiters.delete(waiter);
          cleanup();
          reject(new Error(`timed out after ${timeoutMs}ms waiting for stderr line\n--- stderr tail ---\n${server.stderrTail()}`));
        }, timeoutMs);
        const onExit = () => {
          cleanup();
          reject(
            new Error(`server exited (code=${state.exitInfo.code} signal=${state.exitInfo.signal}) before a matching stderr line appeared\n--- stderr ---\n${server.stderrText()}`),
          );
        };
        const waiter = (line) => {
          if (!predicate(line)) return;
          cleanup();
          resolve(line);
        };
        const cleanup = () => {
          clearTimeout(timer);
          state._lineWaiters.delete(waiter);
          child.removeListener('exit', onExit);
        };
        state._lineWaiters.add(waiter);
        child.once('exit', onExit);
      });
    },
    /** Wait for the the documented contract server_start audit event on stderr; returns parsed JSON. */
    async waitForStartup({ timeoutMs = 10_000 } = {}) {
      const line = await server.waitForStderrLine((l) => l.includes('"server_start"'), { timeoutMs });
      try {
        return JSON.parse(line);
      } catch {
        throw new Error(`server_start stderr line is not valid JSON: ${line}`);
      }
    },
    waitExit({ timeoutMs = 10_000, killOnTimeout = true } = {}) {
      if (state.exitInfo) return Promise.resolve(state.exitInfo);
      const exit = state.exitPromise;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (killOnTimeout && state.exitInfo === null) {
            try {
              child.kill('SIGKILL');
            } catch {
              /* ignore */
            }
          }
          reject(new Error(`timed out after ${timeoutMs}ms waiting for server exit\n--- stderr ---\n${server.stderrText()}`));
        }, timeoutMs);
        exit.then(
          (info) => {
            clearTimeout(timer);
            resolve(info);
          },
          (err) => {
            clearTimeout(timer);
            reject(err);
          },
        );
      });
    },
    kill(signal = 'SIGKILL') {
      if (state.exitInfo !== null) return false;
      state._killed = true;
      try {
        return child.kill(signal);
      } catch {
        return false;
      }
    },
    async killAndWait({ signal = 'SIGKILL', timeoutMs = 10_000 } = {}) {
      server.kill(signal);
      return server.waitExit({ timeoutMs });
    },
    /** Close stdin (EOF) and wait for graceful exit; the documented contract says exit 0. */
    async stopGracefully({ timeoutMs = 10_000 } = {}) {
      try {
        child.stdin.end();
      } catch {
        /* ignore */
      }
      return server.waitExit({ timeoutMs });
    },
    /** Force cleanup for test teardown; never throws. */
    async cleanup() {
      if (state.exitInfo === null) {
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
        await server.waitExit({ timeoutMs: 5000, killOnTimeout: false }).catch(() => {});
      }
    },
  };

  return server;
}

/**
 * Spawn a server and complete the MCP initialize handshake over raw JSON-RPC.
 * Returns {server, client, initializeResult, initializeResponse, close(), stop()}.
 */
export async function startServerClient(options = {}) {
  const {
    protocolVersion = PROTOCOL_VERSION,
    clientInfo = { name: 'canvas-mcp-blackbox-test', version: '0.0.0' },
    initialize = true,
    defaultTimeoutMs = 10_000,
    ...spawnOptions
  } = options;
  const server = spawnServer(spawnOptions);
  const client = new RawJsonRpcClient(server.child, {
    defaultTimeoutMs,
    stderrProvider: () => server.stderrText(),
  });
  const handle = {
    server,
    client,
    async request(method, params, requestOptions) {
      return client.request(method, params, requestOptions);
    },
    notify(method, params) {
      return client.notify(method, params);
    },
    /** Scan the the documented contract server_start line, then initialize. */
    async handshake() {
      const startup = await server.waitForStartup({ timeoutMs: options.startupTimeoutMs ?? 10_000 });
      const initParams = { capabilities: {}, clientInfo };
      if (protocolVersion !== undefined) initParams.protocolVersion = protocolVersion;
      const initializeResult = await client.request('initialize', initParams);
      client.notify('notifications/initialized', {});
      return { startup, initializeResult };
    },
    /** Graceful: close stdin (EOF), wait for exit, kill if needed. */
    async stop({ timeoutMs = 10_000 } = {}) {
      return server.stopGracefully({ timeoutMs }).catch(async () => server.cleanup());
    },
    async cleanup() {
      return server.cleanup();
    },
  };
  if (initialize) {
    handle.initializeResult = await handle.handshake().then(({ initializeResult, startup }) => {
      handle.startup = startup;
      return initializeResult;
    });
  }
  return handle;
}

/** Run any node script/argv to completion, capturing stdout/stderr/exit code. */
export function runNode(args, { cwd = REPO_ROOT, env = {}, timeoutMs = 120_000, input = null } = {}) {
  const child = spawn(process.execPath, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  child.stdin.on('error', () => {});
  if (input !== null) child.stdin.end(input);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      reject(new Error(`timed out after ${timeoutMs}ms running: ${process.execPath} ${args.join(' ')}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`));
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, commandLine: [process.execPath, ...args].join(' ') });
    });
  });
}
