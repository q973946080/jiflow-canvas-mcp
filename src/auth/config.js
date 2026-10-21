/**
 * Authentication config loading and constant-time token matching.
 *
 * The auth file contains only SHA-256 digests of tokens; raw tokens are supplied at
 * runtime through the `CANVAS_MCP_TOKEN` environment variable and are never persisted.
 */
import { readFileSync } from 'node:fs';
import { createHash, timingSafeEqual } from 'node:crypto';
import { ERROR_CODES, canvasError } from '../errors.js';
import { assertCanvasId, assertPrincipalId, isPlainObject } from '../canvas/capabilities.js';
import { WHITELISTED_TOOL_NAMES, isWhitelistedTool } from '../mcp/whitelist.js';

/** Modes understood by the authorisation layer. */
export const AUTH_MODES = Object.freeze(['READ_ONLY', 'CANVAS_WRITE']);

const TOKEN_SHA256_PATTERN = /^[0-9a-f]{64}$/;
const CONFIG_KEYS = ['version', 'principals'];
const PRINCIPAL_KEYS = ['principalId', 'tokenSha256', 'mode', 'canvasIds', 'allowedTools'];

/** Compute the lowercase hex SHA-256 digest of a UTF-8 token. */
export function tokenSha256(token) {
  if (typeof token !== 'string') {
    throw new TypeError('token must be a string');
  }
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function invalidConfig(message) {
  return canvasError(ERROR_CODES.AUTH_CONFIG_INVALID, message);
}

function assertKnownKeys(object, allowedKeys, label) {
  for (const key of Object.keys(object)) {
    if (!allowedKeys.includes(key)) {
      throw invalidConfig(`${label} contains unknown key "${key}"`);
    }
  }
}

function normaliseCanvasIds(raw, principalId) {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw invalidConfig(`principal "${principalId}" must declare a non-empty canvasIds array`);
  }
  const seen = new Set();
  const ids = [];
  for (const value of raw) {
    if (typeof value !== 'string') {
      throw invalidConfig(`principal "${principalId}" has a non-string canvasIds entry`);
    }
    if (value === '*') {
      ids.push('*');
      seen.add('*');
      continue;
    }
    try {
      assertCanvasId(value);
    } catch {
      throw invalidConfig(`principal "${principalId}" has an invalid canvasId "${value}"`);
    }
    if (seen.has(value)) {
      throw invalidConfig(`principal "${principalId}" has duplicate canvasId "${value}"`);
    }
    seen.add(value);
    ids.push(value);
  }
  if (seen.has('*') && ids.length !== 1) {
    throw invalidConfig(`principal "${principalId}" may only use "*" as the sole canvasId`);
  }
  return Object.freeze(ids);
}

function normaliseAllowedTools(raw, principalId) {
  if (raw === undefined || raw === null) {
    return null;
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    throw invalidConfig(`principal "${principalId}" allowedTools must be a non-empty array or null`);
  }
  const tools = [];
  const seen = new Set();
  for (const value of raw) {
    if (typeof value !== 'string' || !isWhitelistedTool(value)) {
      throw invalidConfig(`principal "${principalId}" allowedTools contains an unknown tool`);
    }
    if (!seen.has(value)) {
      seen.add(value);
      tools.push(value);
    }
  }
  return Object.freeze(tools);
}

/**
 * Validate an already parsed auth config object. Throws `CANVAS_AUTH_CONFIG_INVALID`
 * for any schema violation (fail closed).
 *
 * @param {unknown} raw
 * @returns {{version: 1, principals: ReadonlyArray<object>}}
 */
export function validateAuthConfig(raw) {
  if (!isPlainObject(raw)) {
    throw invalidConfig('auth config must be a JSON object');
  }
  assertKnownKeys(raw, CONFIG_KEYS, 'auth config');
  if (raw.version !== 1) {
    throw invalidConfig('auth config version must be 1');
  }
  if (!Array.isArray(raw.principals)) {
    throw invalidConfig('auth config principals must be an array');
  }
  const principals = [];
  const tokenDigests = new Set();
  for (const entry of raw.principals) {
    if (!isPlainObject(entry)) {
      throw invalidConfig('each principal must be an object');
    }
    assertKnownKeys(entry, PRINCIPAL_KEYS, 'principal');
    if (!('principalId' in entry)) {
      throw invalidConfig('principal is missing principalId');
    }
    let principalId;
    try {
      principalId = assertPrincipalId(entry.principalId);
    } catch {
      throw invalidConfig('principalId is invalid');
    }
    if (typeof entry.tokenSha256 !== 'string' || !TOKEN_SHA256_PATTERN.test(entry.tokenSha256)) {
      throw invalidConfig(`principal "${principalId}" tokenSha256 must be 64 lowercase hex characters`);
    }
    if (tokenDigests.has(entry.tokenSha256)) {
      throw invalidConfig('duplicate tokenSha256 across principals');
    }
    tokenDigests.add(entry.tokenSha256);
    if (!AUTH_MODES.includes(entry.mode)) {
      throw invalidConfig(`principal "${principalId}" mode must be ${AUTH_MODES.join(' or ')}`);
    }
    const canvasIds = normaliseCanvasIds(entry.canvasIds, principalId);
    const allowedTools = normaliseAllowedTools(entry.allowedTools, principalId);
    principals.push(
      Object.freeze({
        principalId,
        tokenSha256: entry.tokenSha256,
        mode: entry.mode,
        canvasIds,
        allowedTools
      })
    );
  }
  return Object.freeze({ version: 1, principals: Object.freeze(principals) });
}

/**
 * Read and validate the auth config file.
 *
 * @param {string} path filesystem path to a JSON auth config
 * @returns {{version: 1, principals: ReadonlyArray<object>}}
 */
export function loadAuthConfig(path) {
  if (typeof path !== 'string' || path.length === 0) {
    throw invalidConfig('auth config path is required');
  }
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw invalidConfig('auth config file is unavailable or unreadable');
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw invalidConfig('auth config file is not valid JSON');
  }
  return validateAuthConfig(parsed);
}

/**
 * Match a raw token against the configured principals in constant time.
 *
 * @param {{principals: ReadonlyArray<object>}} config validated auth config
 * @param {unknown} token raw token from the environment
 * @returns {object|null} the matching principal, or `null` when there is no unique match
 */
export function matchPrincipal(config, token) {
  if (!config || !Array.isArray(config.principals) || typeof token !== 'string' || token.length === 0) {
    return null;
  }
  const candidate = Buffer.from(tokenSha256(token), 'utf8');
  let match = null;
  let matches = 0;
  for (const principal of config.principals) {
    const expected = Buffer.from(principal.tokenSha256, 'utf8');
    // Both buffers are always 64 bytes (validated at load time), so timingSafeEqual is safe.
    const equal = expected.length === candidate.length && timingSafeEqual(expected, candidate);
    if (equal) {
      matches += 1;
      match = principal;
    }
  }
  return matches === 1 ? match : null;
}

/** List every whitelisted tool name (re-exported for config validation diagnostics). */
export { WHITELISTED_TOOL_NAMES };
