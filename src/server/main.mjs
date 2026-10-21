#!/usr/bin/env node
/**
 * Executable MCP server entry point.
 *
 * Startup order is fail-closed:
 *   CLI config -> store directory -> auth config file -> token (CANVAS_MCP_TOKEN) ->
 *   principal match -> store init -> stdio JSON-RPC loop.
 *
 * Exit codes: 2 for store/config problems, 3 for authentication problems, 1 for unexpected
 * internal errors, 0 for `--help`, `--version`, EOF and SIGINT/SIGTERM.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CanvasMcpError, ERROR_CODES, canvasError } from '../errors.js';
import { createAuditLogger } from '../logger.js';
import { createAuthorizer } from '../auth/authorize.js';
import { loadAuthConfig, matchPrincipal } from '../auth/config.js';
import { createFileCanvasStore } from '../store/store.js';
import { createOperationExecutor, OperationRegistry } from '../operations/runtime.js';
import { createCanvasDomain } from '../canvas/domain.js';
import { createDispatcher } from '../mcp/dispatch.js';
import { runStdioServer } from '../mcp/server.mjs';
import { TOOL_WHITELIST } from '../mcp/whitelist.js';
import { SERVER_VERSION, USAGE, exitCodeForError, parseServerConfig } from './config.js';

/**
 * Start the server and serve until EOF. Returns the intended exit code.
 *
 * @param {object} [options]
 * @param {string[]} [options.argv] CLI args without the node/script prefix
 * @param {Record<string, string|undefined>} [options.env]
 * @param {object} [options.stdin]
 * @param {object} [options.stdout]
 * @param {object} [options.stderr]
 * @returns {Promise<number>}
 */
export async function startServer({
  argv = process.argv.slice(2),
  env = process.env,
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr
} = {}) {
  const config = parseServerConfig(argv, env);
  if (config.help) {
    stdout.write(USAGE);
    return 0;
  }
  if (config.version) {
    stdout.write(`${SERVER_VERSION}\n`);
    return 0;
  }

  // 1. store directory must already exist (may be empty).
  let storeStats;
  try {
    storeStats = fs.statSync(config.storeDir);
  } catch {
    throw canvasError(ERROR_CODES.STORE_UNAVAILABLE, 'store directory is unavailable');
  }
  if (!storeStats.isDirectory()) {
    throw canvasError(ERROR_CODES.STORE_UNAVAILABLE, 'store path is not a directory');
  }

  // 2. auth config file must load and validate.
  const authConfig = loadAuthConfig(config.authPath);

  // 3. the token must be present and match exactly one configured principal.
  const token = env.CANVAS_MCP_TOKEN;
  if (typeof token !== 'string' || token.length === 0) {
    throw canvasError(ERROR_CODES.AUTH_REQUIRED, 'CANVAS_MCP_TOKEN is required');
  }
  const principal = matchPrincipal(authConfig, token);
  if (principal === null) {
    throw canvasError(ERROR_CODES.PRINCIPAL_UNKNOWN, 'token does not match any configured principal');
  }
  const agentId = config.agentId ?? principal.principalId;

  // 4. store + services.
  const store = createFileCanvasStore({
    dir: config.storeDir,
    lockTimeoutMs: config.lockTimeoutMs,
    staleLockMs: config.staleLockMs
  });
  store.init();
  const logger = createAuditLogger({ sink: (line) => stderr.write(line) });
  const authorize = createAuthorizer({ principal });
  const registry = new OperationRegistry();
  const executor = createOperationExecutor({ store, registry, authorize, principal, agentId });
  const domain = createCanvasDomain({ store, authorize, executor, principal, agentId, registry });
  const dispatcher = createDispatcher({ domain, authorize, logger, principal, agentId });

  // 5. one structured startup log line (never includes the token).
  logger({
    event: 'server_start',
    principalId: principal.principalId,
    agentId,
    store: config.storeDir,
    tools: TOOL_WHITELIST.length,
    version: SERVER_VERSION
  });

  const shutdown = () => {
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  await runStdioServer({ dispatcher, logger, input: stdin, output: stdout });
  process.removeListener('SIGINT', shutdown);
  process.removeListener('SIGTERM', shutdown);
  return 0;
}

/** Executable wrapper: print startup failures as one stderr JSON line and exit non-zero. */
export async function runMain() {
  process.stdout.on('error', () => {
    // Ignore EPIPE from a client that closed the pipe.
  });
  try {
    process.exitCode = await startServer();
  } catch (error) {
    const mcpError =
      error instanceof CanvasMcpError
        ? error
        : new CanvasMcpError(ERROR_CODES.INTERNAL_ERROR, 'internal error');
    const exitCode = exitCodeForError(mcpError.code);
    try {
      process.stderr.write(
        `${JSON.stringify({
          ts: new Date().toISOString(),
          event: 'server_error',
          ok: false,
          code: mcpError.code,
          error: mcpError.message
        })}\n`
      );
    } catch {
      // stderr unavailable: still exit with the correct code
    }
    process.exit(exitCode);
  }
}

/**
 * Return `true` when this module is the process entry point.
 * Compares real paths so the check also works through symlinks (`npm bin`, `/tmp` on macOS).
 */
function isEntryPoint() {
  const entry = process.argv[1];
  if (typeof entry !== 'string' || entry.length === 0) {
    return false;
  }
  try {
    return fs.realpathSync(entry) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  runMain();
}

export { SERVER_VERSION };