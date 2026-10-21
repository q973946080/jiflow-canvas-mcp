// Test helper: build auth config files per the documented contract. Tokens are fictional demo-*-token strings.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** sha256(utf8(value)) as lowercase hex. */
export function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

/** Per the documented contract: token match = sha256(utf8 token) hex. */
export function tokenSha256(token) {
  return sha256Hex(token);
}

/**
 * One principal entry for the auth config file.
 * `token` is only used to compute tokenSha256; the token itself is never written.
 */
export function makePrincipal({
  principalId,
  token,
  mode = 'CANVAS_WRITE',
  canvasIds = ['*'],
  allowedTools = null,
  includeAllowedTools = true,
}) {
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('makePrincipal requires a non-empty token');
  }
  const entry = {
    principalId,
    tokenSha256: tokenSha256(token),
    mode,
    canvasIds: [...canvasIds],
  };
  if (includeAllowedTools) entry.allowedTools = allowedTools;
  return entry;
}

export function buildAuthConfig(principals, { version = 1 } = {}) {
  return { version, principals };
}

export function writeAuthConfig(filePath, config) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return filePath;
}

/**
 * Build {authPath, tokens, config} for a set of principal specs.
 * specs: [{principalId, token, mode?, canvasIds?, allowedTools?}]
 */
export function createAuthFixture(root, specs) {
  const tokens = {};
  const principals = specs.map((spec) => {
    tokens[spec.principalId] = spec.token;
    return makePrincipal(spec);
  });
  const config = buildAuthConfig(principals);
  const authPath = path.join(root, 'auth.json');
  writeAuthConfig(authPath, config);
  return { authPath, tokens, config };
}

export const FIXTURE_TOKENS = Object.freeze({
  writerA: 'demo-fixture-writer-a-token',
  writerB: 'demo-fixture-writer-b-token',
  reader: 'demo-fixture-reader-token',
  limited: 'demo-fixture-limited-token',
});

/**
 * Standard fictional fixture principals:
 * - agent-writer-a: CANVAS_WRITE, canvas-fixture-a only
 * - agent-writer-b: CANVAS_WRITE, canvas-fixture-b only
 * - agent-reader:  READ_ONLY, ["*"]
 * - agent-limited: CANVAS_WRITE, ["*"], allowedTools: ["canvas_list_canvases"]
 */
export function standardPrincipalSpecs({ canvasIds = null } = {}) {
  const a = canvasIds ? canvasIds : ['canvas-fixture-a'];
  return [
    {
      principalId: 'agent-writer-a',
      token: FIXTURE_TOKENS.writerA,
      mode: 'CANVAS_WRITE',
      canvasIds: a,
      allowedTools: null,
    },
    {
      principalId: 'agent-writer-b',
      token: FIXTURE_TOKENS.writerB,
      mode: 'CANVAS_WRITE',
      canvasIds: ['canvas-fixture-b'],
      allowedTools: null,
    },
    {
      principalId: 'agent-reader',
      token: FIXTURE_TOKENS.reader,
      mode: 'READ_ONLY',
      canvasIds: ['*'],
      allowedTools: null,
    },
    {
      principalId: 'agent-limited',
      token: FIXTURE_TOKENS.limited,
      mode: 'CANVAS_WRITE',
      canvasIds: ['*'],
      allowedTools: ['canvas_list_canvases'],
    },
  ];
}

export function standardAuthFixture(root, options = {}) {
  return createAuthFixture(root, standardPrincipalSpecs(options));
}
