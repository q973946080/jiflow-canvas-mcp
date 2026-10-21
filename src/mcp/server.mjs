/**
 * MCP JSON-RPC 2.0 stdio server.
 *
 * Transport: newline-delimited UTF-8 JSON-RPC (one JSON object per line) on stdin/stdout.
 * stdout is a pure protocol channel; every log or diagnostic goes to stderr through the
 * audit logger. Messages are processed one at a time, in arrival order.
 */
import { CanvasMcpError, ERROR_CODES, canvasError } from '../errors.js';
import { listToolDefinitions } from './whitelist.js';

export const SERVER_NAME = 'jiflow-canvas-mcp';
export const SERVER_VERSION = '0.1.0';

/** Protocol versions this server can negotiate (v1.1: includes the SDK 1.30 latest). */
export const PROTOCOL_VERSIONS = Object.freeze([
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
  '2024-10-07'
]);
export const DEFAULT_PROTOCOL_VERSION = '2025-11-25';

/** Echo a supported client protocol version, otherwise fall back to the newest supported one. */
export function negotiateProtocolVersion(requested) {
  return PROTOCOL_VERSIONS.includes(requested) ? requested : DEFAULT_PROTOCOL_VERSION;
}

const JSONRPC_VERSION = '2.0';

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function jsonRpcResponse(id, result) {
  return { jsonrpc: JSONRPC_VERSION, id, result };
}

function jsonRpcError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) {
    error.data = data;
  }
  return { jsonrpc: JSONRPC_VERSION, id, error };
}

function toolErrorResult(error) {
  const payload =
    error instanceof CanvasMcpError
      ? error.toPayload()
      : { ok: false, code: ERROR_CODES.INTERNAL_ERROR, error: 'internal error' };
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    isError: true
  };
}

function toolSuccessResult(payload) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload
  };
}

/**
 * Create a protocol handler around a dispatcher.
 *
 * @param {object} options
 * @param {object} options.dispatcher dispatcher created by `createDispatcher`
 * @param {Function} [options.logger] audit logger (used only for transport level events)
 * @param {object} [options.serverInfo] `{name, version}` override
 */
export function createMcpServer({ dispatcher, logger, serverInfo } = {}) {
  if (!dispatcher || typeof dispatcher.call !== 'function') {
    throw new TypeError('createMcpServer requires a dispatcher');
  }
  const log = typeof logger === 'function' ? logger : () => {};
  const name = typeof serverInfo?.name === 'string' ? serverInfo.name : SERVER_NAME;
  const version = typeof serverInfo?.version === 'string' ? serverInfo.version : SERVER_VERSION;

  function handleToolsCall(id, params) {
    if (params !== undefined && params !== null && !isPlainObject(params)) {
      return jsonRpcResponse(
        id,
        toolErrorResult(canvasError(ERROR_CODES.ARGUMENTS_INVALID, 'invalid tool call parameters'))
      );
    }
    try {
      const result = dispatcher.call(params ?? {});
      return jsonRpcResponse(id, toolSuccessResult(result));
    } catch (error) {
      const mcpError =
        error instanceof CanvasMcpError
          ? error
          : canvasError(ERROR_CODES.INTERNAL_ERROR, 'internal error');
      return jsonRpcResponse(id, toolErrorResult(mcpError));
    }
  }

  function handleRequest(message, id) {
    const method = message.method;
    switch (method) {
      case 'initialize': {
        const requested = message.params?.protocolVersion;
        return jsonRpcResponse(id, {
          protocolVersion: negotiateProtocolVersion(requested),
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name, version }
        });
      }
      case 'ping':
        return jsonRpcResponse(id, {});
      case 'tools/list':
        return jsonRpcResponse(id, { tools: listToolDefinitions() });
      case 'tools/call':
        return handleToolsCall(id, message.params);
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return null;
      default:
        return jsonRpcError(id, -32601, 'Method not found');
    }
  }

  /**
   * Handle one already-parsed JSON-RPC message.
   * @returns {object|null} response object, or `null` when no response is allowed
   */
  function handleMessage(message) {
    if (Array.isArray(message)) {
      return jsonRpcError(null, -32600, 'Invalid Request');
    }
    if (!isPlainObject(message)) {
      return jsonRpcError(null, -32600, 'Invalid Request');
    }
    const hasId = Object.prototype.hasOwnProperty.call(message, 'id');
    if (message.jsonrpc !== JSONRPC_VERSION || typeof message.method !== 'string') {
      return hasId ? jsonRpcError(message.id ?? null, -32600, 'Invalid Request') : null;
    }
    const id = hasId ? message.id : undefined;
    try {
      if (hasId) {
        return handleRequest(message, id ?? null);
      }
      // Notifications never receive a response.
      if (message.method === 'notifications/initialized' || message.method === 'notifications/cancelled') {
        return null;
      }
      if (message.method === 'tools/call' || message.method === 'initialize' || message.method === 'ping' || message.method === 'tools/list') {
        // Requests without an id are malformed notifications; ignore them safely.
        return null;
      }
      log({ event: 'server_error', ok: false, code: ERROR_CODES.TOOL_UNKNOWN });
      return null;
    } catch {
      return hasId ? jsonRpcError(id ?? null, -32603, 'Internal error') : null;
    }
  }

  /**
   * Handle one raw line from stdin. Returns the response object to serialise, or `null`.
   */
  function handleLine(line) {
    const text = typeof line === 'string' ? line.trim() : '';
    if (text.length === 0) {
      return null;
    }
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return jsonRpcError(null, -32700, 'Parse error');
    }
    return handleMessage(message);
  }

  return Object.freeze({
    handleLine,
    handleMessage,
    serverInfo: Object.freeze({ name, version })
  });
}

/**
 * Serve a dispatcher over newline-delimited JSON-RPC on the given streams.
 * Resolves when the input stream ends (the caller decides the process exit code).
 *
 * @param {object} options
 * @param {object} options.dispatcher
 * @param {object} [options.input=process.stdin]
 * @param {object} [options.output=process.stdout]
 * @param {Function} [options.logger]
 * @param {object} [options.serverInfo]
 * @returns {Promise<void>}
 */
export function runStdioServer({
  dispatcher,
  input = process.stdin,
  output = process.stdout,
  logger,
  serverInfo
} = {}) {
  const server = createMcpServer({ dispatcher, logger, serverInfo });
  let buffer = '';
  let finished = false;

  const writeResponse = (response) => {
    if (response === null || response === undefined) {
      return;
    }
    try {
      output.write(`${JSON.stringify(response)}\n`);
    } catch {
      // A closed pipe is not fatal: the client went away and the process will exit on EOF.
    }
  };

  const processLine = (line) => {
    writeResponse(server.handleLine(line));
  };

  return new Promise((resolve) => {
    const finish = () => {
      if (finished) {
        return;
      }
      finished = true;
      input.off?.('data', onData);
      resolve();
    };
    const onData = (chunk) => {
      buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).replace(/\r$/, '');
        buffer = buffer.slice(newlineIndex + 1);
        processLine(line);
        newlineIndex = buffer.indexOf('\n');
      }
    };
    input.setEncoding?.('utf8');
    input.on('data', onData);
    input.on('end', () => {
      if (buffer.length > 0) {
        processLine(buffer.replace(/\r$/, ''));
        buffer = '';
      }
      finish();
    });
    input.on('error', () => finish());
    input.resume?.();
  });
}

/**
 * Convenience `main` for embedding: serve until EOF and return the exit code (0).
 */
export async function main(options = {}) {
  await runStdioServer(options);
  return 0;
}
