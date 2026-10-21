// Test helper: raw newline-delimited JSON-RPC 2.0 client over a child process stdio.
// No sockets/ports: transport is stdio only. Zero runtime deps.
import { EventEmitter } from 'node:events';

export class JsonRpcError extends Error {
  constructor(rpcError, method) {
    const code = rpcError && rpcError.code;
    const message = rpcError && rpcError.message;
    super(`JSON-RPC error ${code}: ${message}${method ? ` (method ${method})` : ''}`);
    this.name = 'JsonRpcError';
    this.code = code;
    this.rpcError = rpcError;
    this.method = method;
  }
}

export class RpcTimeoutError extends Error {
  constructor(method, timeoutMs, stderrTail) {
    super(`timeout after ${timeoutMs}ms waiting for ${method} response${stderrTail ? `\n--- server stderr tail ---\n${stderrTail}` : ''}`);
    this.name = 'RpcTimeoutError';
    this.method = method;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Raw JSON-RPC client.
 * - request(): resolves with result, rejects with JsonRpcError / RpcTimeoutError.
 * - requestResponse(): never throws on JSON-RPC errors; returns raw response message.
 * - notify(): writes a notification (no id, no response expected).
 * - sendLine(): writes an arbitrary raw line (used to test malformed input).
 * - waitForMessage(): waits for an unsolicited/unmatched message (e.g. id:null errors).
 */
export class RawJsonRpcClient {
  constructor(child, { defaultTimeoutMs = 10_000, stderrProvider = null } = {}) {
    this.child = child;
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.stderrProvider = stderrProvider;
    this.nextId = 1;
    this.pending = new Map();
    this.messages = []; // every parsed server->client message, in order
    this.invalidLines = []; // server stdout lines that were not valid JSON
    this.strayLines = []; // lines that were JSON but not JSON-RPC objects
    this.buffer = '';
    this.closed = false;
    this.emitter = new EventEmitter();
    this.emitter.setMaxListeners(50);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this._onData(chunk));
    child.on('exit', (code, signal) => {
      this.exitInfo = { code, signal };
      this._rejectAll(new Error(`server process exited unexpectedly (code=${code} signal=${signal})${this._stderrTail()}`));
    });
    child.on('error', (err) => this._rejectAll(err));
    child.stdin.on('error', () => {
      /* EPIPE after server exit is expected in negative tests */
    });
  }

  _stderrTail() {
    const text = this.stderrProvider ? this.stderrProvider() : '';
    const tail = String(text || '').trimEnd().split('\n').slice(-15).join('\n');
    return tail ? `\n--- server stderr tail ---\n${tail}` : '';
  }

  _onData(chunk) {
    this.buffer += chunk;
    for (;;) {
      const idx = this.buffer.indexOf('\n');
      if (idx === -1) break;
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (line.trim() === '') continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        this.invalidLines.push(line);
        this.emitter.emit('message');
        continue;
      }
      if (message === null || typeof message !== 'object' || Array.isArray(message)) {
        this.strayLines.push(line);
        this.emitter.emit('message');
        continue;
      }
      this.messages.push(message);
      const id = message.id;
      if (typeof id === 'number' && this.pending.has(id)) {
        const entry = this.pending.get(id);
        this.pending.delete(id);
        clearTimeout(entry.timer);
        if (message.error) entry.reject(new JsonRpcError(message.error, entry.method));
        else entry.resolve(message.result);
      }
      this.emitter.emit('message');
    }
  }

  _rejectAll(error) {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
      this.pending.delete(id);
    }
    this.emitter.emit('message');
  }

  _writeLine(line) {
    if (this.closed) throw new Error('client is closed');
    try {
      this.child.stdin.write(`${line}\n`);
    } catch (err) {
      throw new Error(`failed writing to server stdin: ${err.message}`);
    }
  }

  _write(message) {
    this._writeLine(JSON.stringify(message));
  }

  /** Send request and resolve with the JSON-RPC `result`; throws JsonRpcError on error responses. */
  request(method, params, { timeoutMs = this.defaultTimeoutMs } = {}) {
    const id = this.nextId;
    this.nextId += 1;
    const message = { jsonrpc: '2.0', id, method };
    if (params !== undefined) message.params = params;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcTimeoutError(method, timeoutMs, this._stderrTail()));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        this._write(message);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  /** Like request(), but always resolves with the full raw response message. */
  async requestResponse(method, params, options = {}) {
    const id = this.nextId;
    const message = { jsonrpc: '2.0', id, method };
    if (params !== undefined) message.params = params;
    const rawPromise = this.waitForMessage((m) => m.id === id, options);
    this.nextId += 1;
    this._write(message);
    return rawPromise;
  }

  notify(method, params) {
    const message = { jsonrpc: '2.0', method };
    if (params !== undefined) message.params = params;
    this._write(message);
  }

  /** Write a raw line verbatim (for malformed-JSON / batch tests). */
  sendLine(line) {
    this._writeLine(line);
  }

  /** Wait for a parsed server->client message matching predicate (existing or future). */
  waitForMessage(predicate, { timeoutMs = this.defaultTimeoutMs } = {}) {
    const found = this.messages.find((m, i) => i >= this._messageScanStart && predicate(m));
    this._messageScanStart = this.messages.length;
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.emitter.removeListener('message', onMessage);
        reject(new RpcTimeoutError('message', timeoutMs, this._stderrTail()));
      }, timeoutMs);
      const onMessage = () => {
        const match = this.messages.slice(this._messageScanStart).find(predicate);
        if (match) {
          clearTimeout(timer);
          this.emitter.removeListener('message', onMessage);
          this._messageScanStart = this.messages.length;
          resolve(match);
        }
      };
      this.emitter.on('message', onMessage);
    });
  }

  _messageScanStart = 0;

  /** Messages received so far that are JSON-RPC responses (have numeric id). */
  responses() {
    return this.messages.filter((m) => typeof m.id === 'number');
  }

  /** Unsolicited notifications/errors the server must not send for these methods. */
  unsolicited() {
    return this.messages.filter((m) => m.id === undefined || m.id === null);
  }

  get pendingCount() {
    return this.pending.size;
  }

  closeInput() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.child.stdin.end();
    } catch {
      /* ignore */
    }
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll a boolean predicate until true or timeout. */
export async function waitUntil(predicate, { timeoutMs = 5000, intervalMs = 20, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
    await sleep(intervalMs);
  }
}
