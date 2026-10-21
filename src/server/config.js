/**
 * CLI configuration parsing for the executable server entry point.
 * Pure: validates and normalises argv/env, but performs no filesystem or token lookups.
 */
import path from 'node:path';
import { ERROR_CODES, canvasError } from '../errors.js';
import { assertAgentId } from '../canvas/capabilities.js';

export const SERVER_VERSION = '0.1.0';

export const DEFAULT_LOCK_TIMEOUT_MS = 5000;
export const DEFAULT_STALE_LOCK_MS = 10000;

export const USAGE = `Usage: jiflow-canvas-mcp --store <dir> --auth <file.json> [options]

Standalone MCP (stdio) server for a local canvas graph with CAS concurrency control,
scoped token permissions and durable operation receipts.

Required:
  --store <dir>             Existing directory used as the canvas store.
  --auth <file.json>        Auth config containing token SHA-256 digests and scopes.
                            The raw token is read from CANVAS_MCP_TOKEN.

Options:
  --agent-id <id>           Optional ASCII agent id recorded in receipts/logs (<=64 chars).
  --lock-timeout-ms <n>     Lock acquisition timeout in ms (default: ${DEFAULT_LOCK_TIMEOUT_MS}).
  --stale-lock-ms <n>       Age in ms after which a lock is considered stale (default: ${DEFAULT_STALE_LOCK_MS}).
  --help                    Print this help and exit 0.
  --version                 Print the server version and exit 0.

Authentication is mandatory; there is no anonymous or demo bypass mode.
`;

function parseIntegerFlag(name, rawValue) {
  if (typeof rawValue !== 'string' || !/^\d+$/.test(rawValue)) {
    throw canvasError(ERROR_CODES.ARGUMENTS_INVALID, `${name} must be a non-negative integer`);
  }
  const value = Number(rawValue);
  if (!Number.isSafeInteger(value)) {
    throw canvasError(ERROR_CODES.ARGUMENTS_INVALID, `${name} must be a safe integer`);
  }
  return value;
}

/**
 * Parse CLI flags and environment into a startup config.
 *
 * @param {string[]} [argv] arguments without the node/script prefix (i.e. process.argv.slice(2))
 * @param {Record<string, string|undefined>} [env]
 */
export function parseServerConfig(argv = [], env = {}) {
  if (!Array.isArray(argv)) {
    throw canvasError(ERROR_CODES.ARGUMENTS_INVALID, 'argv must be an array');
  }
  const config = {
    help: false,
    version: false,
    storeDir: null,
    authPath: null,
    agentId: null,
    lockTimeoutMs: DEFAULT_LOCK_TIMEOUT_MS,
    staleLockMs: DEFAULT_STALE_LOCK_MS,
    token: typeof env.CANVAS_MCP_TOKEN === 'string' ? env.CANVAS_MCP_TOKEN : undefined
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case '--help':
      case '-h':
        config.help = true;
        break;
      case '--version':
      case '-v':
        config.version = true;
        break;
      case '--store':
        config.storeDir = argv[++index];
        break;
      case '--auth':
        config.authPath = argv[++index];
        break;
      case '--agent-id':
        config.agentId = argv[++index];
        break;
      case '--lock-timeout-ms':
        config.lockTimeoutMs = parseIntegerFlag('--lock-timeout-ms', argv[++index]);
        break;
      case '--stale-lock-ms':
        config.staleLockMs = parseIntegerFlag('--stale-lock-ms', argv[++index]);
        break;
      default:
        throw canvasError(ERROR_CODES.ARGUMENTS_INVALID, `unknown argument "${argument}"`);
    }
  }

  if (config.help || config.version) {
    return config;
  }
  if (typeof config.storeDir !== 'string' || config.storeDir.length === 0) {
    throw canvasError(ERROR_CODES.STORE_UNAVAILABLE, '--store is required');
  }
  if (typeof config.authPath !== 'string' || config.authPath.length === 0) {
    throw canvasError(ERROR_CODES.AUTH_CONFIG_INVALID, '--auth is required');
  }
  if (config.agentId !== null) {
    assertAgentId(config.agentId);
  }
  config.storeDir = path.resolve(config.storeDir);
  config.authPath = path.resolve(config.authPath);
  return config;
}

/**
 * Map a startup error code to a process exit code.
 * 2 = configuration/store problem, 3 = authentication problem, 1 = unexpected internal.
 */
export function exitCodeForError(code) {
  switch (code) {
    case ERROR_CODES.AUTH_REQUIRED:
    case ERROR_CODES.AUTH_CONFIG_INVALID:
    case ERROR_CODES.PRINCIPAL_UNKNOWN:
      return 3;
    case ERROR_CODES.INTERNAL_ERROR:
      return 1;
    default:
      return 2;
  }
}
