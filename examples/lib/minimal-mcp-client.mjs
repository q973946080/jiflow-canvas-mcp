#!/usr/bin/env node
/**
 * Minimal zero-dependency MCP JSON-RPC stdio client used by the examples.
 *
 * It spawns a child server process, performs the initialize/initialized handshake, sends
 * requests with monotonically increasing ids, routes responses by id, and surfaces stderr
 * from the server for diagnostics. Timeouts reject pending requests instead of hanging.
 */
import { spawn } from 'node:child_process';

export class McpClientError extends Error {
  constructor(message, { code, data, stderr } = {}) {
    super(message);
    this.name = 'McpClientError';
    if (code !== undefined) {
      this.code = code;
    }
    if (data !== undefined) {
      this.data = data;
    }
    if (stderr !== undefined) {
      this.stderr = stderr;
    }
  }
}

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_CLOSE_TIMEOUT_MS = 3000;
const MAX_STDERR_CHARS = 65536;

export class MinimalMcpClient {
  /**
   * @param {object} options
   * @param {string} [options.command] executable (default: current node binary)
   * @param {string[]} [options.args] argv for the server
   * @param {string} [options.cwd] working directory
   * @param {Record<string,string>} [options.env] environment overrides
   * @param {number} [options.requestTimeoutMs]
   */
  constructor({
    command = process.execPath,
    args = [],
    cwd = process.cwd(),
    env = {},
    requestTimeoutMs = DEFAULT_TIMEOUT_MS
  } = {}) {
    this.command = command;
    this.args = args;
    this.cwd = cwd;
    this.env = env;
    this.requestTimeoutMs = requestTimeoutMs;
    this.child = null;
    this.nextId = 1;
    this.pending = new Map();
    this.stdoutBuffer = '';
    this.stderrBuffer = '';
    this.exitInfo = null;
    this.started = false;
  }

  /** Spawn the server process and resolve once the OS process exists. */
  async start() {
    if (this.started) {
      return this;
    }
    this.started = true;
    this.child = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: { ...process.env, ...this.env },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this.onStdout(chunk));
    this.child.stderr.on('data', (chunk) => {
      this.stderrBuffer = (this.stderrBuffer + chunk).slice(-MAX_STDERR_CHARS);
    });
    this.child.stdin.on('error', () => {
      // Ignore EPIPE; pending requests fail when the process exits.
    });
    this.child.on('exit', (code, signal) => {
      this.exitInfo = { code, signal };
      this.failPending(
        new McpClientError(`server process exited (code=${code}, signal=${signal})`, {
          stderr: this.stderrBuffer
        })
      );
    });
    await new Promise((resolve, reject) => {
      this.child.once('spawn', resolve);
      this.child.once('error', (error) => {
        this.started = false;
        reject(new McpClientError(`failed to spawn server: ${error.message}`));
      });
    });
    return this;
  }

  onStdout(chunk) {
    this.stdoutBuffer += chunk;
    let newlineIndex = this.stdoutBuffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      newlineIndex = this.stdoutBuffer.indexOf('\n');
      if (line.length === 0) {
        continue;
      }
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message === null || typeof message !== 'object' || message.id === undefined) {
        continue;
      }
      const pending = this.pending.get(String(message.id));
      if (!pending) {
        continue;
      }
      this.pending.delete(String(message.id));
      clearTimeout(pending.timer);
      if (message.error !== undefined) {
        pending.reject(
          new McpClientError(`JSON-RPC error ${message.error.code}: ${message.error.message}`, {
            code: message.error.code,
            data: message.error.data,
            stderr: this.stderrBuffer
          })
        );
      } else {
        pending.resolve(message.result);
      }
    }
  }

  failPending(error) {
    for (const [key, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.pending.delete(key);
      pending.reject(error);
    }
  }

  writeMessage(message) {
    if (!this.child || this.child.exitCode !== null) {
      throw new McpClientError('server process is not running', { stderr: this.stderrBuffer });
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  /**
   * Send one request and resolve with its `result` (JSON-RPC errors reject).
   * @param {string} method
   * @param {object} [params]
   */
  request(method, params = {}) {
    const id = this.nextId;
    this.nextId += 1;
    const message = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        reject(
          new McpClientError(`request timed out after ${this.requestTimeoutMs}ms: ${method}`, {
            stderr: this.stderrBuffer
          })
        );
      }, this.requestTimeoutMs);
      this.pending.set(String(id), { resolve, reject, timer, method });
      try {
        this.writeMessage(message);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(String(id));
        reject(error);
      }
    });
  }

  /** Send a JSON-RPC notification (no response expected). */
  notify(method, params = {}) {
    this.writeMessage({ jsonrpc: '2.0', method, params });
  }

  /** Perform the MCP initialize + notifications/initialized handshake. */
  async initialize({ protocolVersion = '2025-11-25', clientInfo } = {}) {
    const result = await this.request('initialize', {
      protocolVersion,
      capabilities: {},
      clientInfo: clientInfo ?? { name: 'minimal-mcp-client', version: '0.1.0' }
    });
    this.notify('notifications/initialized', {});
    return result;
  }

  /** List tools (returns the raw definitions array). */
  async listTools() {
    const result = await this.request('tools/list', {});
    return result.tools;
  }

  /** Call a tool and return the raw MCP tool result (`content`/`structuredContent`/`isError`). */
  async callTool(name, args = {}) {
    return this.request('tools/call', { name, arguments: args });
  }

  /** Server stderr captured so far (diagnostics only; the server never logs tokens). */
  getStderr() {
    return this.stderrBuffer;
  }

  /**
   * Terminate the server: SIGTERM, wait up to `timeoutMs`, then SIGKILL.
   * @param {number} [timeoutMs]
   */
  async close(timeoutMs = DEFAULT_CLOSE_TIMEOUT_MS) {
    const child = this.child;
    if (!child) {
      return;
    }
    this.failPending(new McpClientError('client closed', { stderr: this.stderrBuffer }));
    if (child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    const exited = new Promise((resolve) => child.once('exit', resolve));
    try {
      child.kill('SIGTERM');
    } catch {
      // already gone
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
    }, timeoutMs);
    await exited;
    clearTimeout(timer);
    if (child.stdin && !child.stdin.destroyed) {
      child.stdin.destroy();
    }
  }
}

/** Convenience factory. */
export function createMinimalMcpClient(options = {}) {
  return new MinimalMcpClient(options);
}

export default MinimalMcpClient;
