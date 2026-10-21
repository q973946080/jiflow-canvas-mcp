// Unit suite: auth config validation, token hashing/matching, authorizer semantics.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { createTempDir, rmrf } from '../helpers/fixture-store.mjs';
import {
  buildAuthConfig,
  createAuthFixture,
  makePrincipal,
  standardPrincipalSpecs,
  writeAuthConfig,
  FIXTURE_TOKENS,
  sha256Hex,
} from '../helpers/auth-config.mjs';
import { loadAuthConfig, matchPrincipal, tokenSha256, validateAuthConfig } from '../../src/auth/config.js';
import { createAuthorizer } from '../../src/auth/authorize.js';
import { TOOL_NAMES } from '../helpers/paths.mjs';

function expectAuthConfigInvalid(action, label) {
  try {
    action();
  } catch (err) {
    assert.equal(err.code, 'CANVAS_AUTH_CONFIG_INVALID', `${label}: expected CANVAS_AUTH_CONFIG_INVALID, got ${err.code || err.message}`);
    return err;
  }
  assert.fail(`${label}: expected CANVAS_AUTH_CONFIG_INVALID to be thrown`);
}

function writeJson(root, name, value) {
  const file = path.join(root, name);
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
  return file;
}

describe('tokenSha256', () => {
  test('is sha256(utf8 token) lowercase hex', () => {
    const token = 'demo-writer-a-token';
    const expected = crypto.createHash('sha256').update(token, 'utf8').digest('hex');
    assert.equal(tokenSha256(token), expected);
    assert.match(tokenSha256(token), /^[0-9a-f]{64}$/);
    assert.equal(tokenSha256(token), sha256Hex(token));
    assert.notEqual(tokenSha256(token), tokenSha256(`${token} `));
  });
});

describe('loadAuthConfig validation', () => {
  let root;

  before(() => {
    root = createTempDir('canvas-mcp-auth-unit-');
  });

  after(() => rmrf(root));

  test('accepts the documented auth config shape and preserves principals', () => {
    const fixture = createAuthFixture(root, standardPrincipalSpecs());
    const config = loadAuthConfig(fixture.authPath);
    assert.equal(config.version, 1);
    assert.equal(config.principals.length, 4);
    const writer = config.principals.find((p) => p.principalId === 'agent-writer-a');
    assert.deepEqual(writer.canvasIds, ['canvas-fixture-a']);
    assert.equal(writer.mode, 'CANVAS_WRITE');
    assert.equal(writer.tokenSha256, tokenSha256(FIXTURE_TOKENS.writerA));
    assert.equal(writer.allowedTools, null);
    const reader = config.principals.find((p) => p.principalId === 'agent-reader');
    assert.deepEqual(reader.canvasIds, ['*']);
    assert.equal(reader.mode, 'READ_ONLY');
  });

  test('accepts a valid allowedTools subset and a wildcard reader', () => {
    const fixture = createAuthFixture(root, [
      {
        principalId: 'agent-limited',
        token: 'demo-fixture-limited-token',
        mode: 'CANVAS_WRITE',
        canvasIds: ['canvas-fixture-a'],
        allowedTools: ['canvas_list_canvases', 'canvas_read_canvas'],
      },
    ]);
    const config = loadAuthConfig(fixture.authPath);
    assert.deepEqual(config.principals[0].allowedTools, ['canvas_list_canvases', 'canvas_read_canvas']);
  });

  test('rejects every invalid schema with CANVAS_AUTH_CONFIG_INVALID (fail closed)', () => {
    const digest = tokenSha256('demo-valid-token');
    const principal = {
      principalId: 'p',
      tokenSha256: digest,
      mode: 'CANVAS_WRITE',
      canvasIds: ['canvas-fixture-a'],
    };
    const cases = [
      ['not-json', '{"version": 1,'],
      ['null', 'null'],
      ['array', '[]'],
      ['version-2', { version: 2, principals: [principal] }],
      ['missing-version', { principals: [principal] }],
      ['principals-not-array', { version: 1, principals: 'nope' }],
      ['bad-mode', { version: 1, principals: [{ ...principal, mode: 'ADMIN' }] }],
      ['missing-mode', { version: 1, principals: [{ principalId: 'p', tokenSha256: digest, canvasIds: ['canvas-fixture-a'] }] }],
      ['uppercase-digest', { version: 1, principals: [{ ...principal, tokenSha256: digest.toUpperCase() }] }],
      ['short-digest', { version: 1, principals: [{ ...principal, tokenSha256: digest.slice(0, 63) }] }],
      ['nonhex-digest', { version: 1, principals: [{ ...principal, tokenSha256: 'z'.repeat(64) }] }],
      [
        'duplicate-digest',
        {
          version: 1,
          principals: [principal, { ...principal, principalId: 'p2' }],
        },
      ],
      ['empty-canvas-ids', { version: 1, principals: [{ ...principal, canvasIds: [] }] }],
      ['duplicate-canvas-ids', { version: 1, principals: [{ ...principal, canvasIds: ['canvas-fixture-a', 'canvas-fixture-a'] }] }],
      ['wildcard-plus-id', { version: 1, principals: [{ ...principal, canvasIds: ['*', 'canvas-fixture-a'] }] }],
      ['invalid-canvas-id', { version: 1, principals: [{ ...principal, canvasIds: ['bad/id'] }] }],
      ['nonstring-canvas-id', { version: 1, principals: [{ ...principal, canvasIds: [123] }] }],
      ['empty-allowed-tools', { version: 1, principals: [{ ...principal, allowedTools: [] }] }],
      ['unknown-allowed-tool', { version: 1, principals: [{ ...principal, allowedTools: ['bash'] }] }],
      ['nonarray-allowed-tools', { version: 1, principals: [{ ...principal, allowedTools: 'canvas_read_canvas' }] }],
      ['mixed-allowed-tools', { version: 1, principals: [{ ...principal, allowedTools: [TOOL_NAMES[0], 'bash'] }] }],
      ['missing-principal-id', { version: 1, principals: [{ tokenSha256: digest, mode: 'CANVAS_WRITE', canvasIds: ['canvas-fixture-a'] }] }],
      ['empty-principal-id', { version: 1, principals: [{ ...principal, principalId: '' }] }],
      ['missing-token-sha', { version: 1, principals: [{ principalId: 'p', mode: 'CANVAS_WRITE', canvasIds: ['canvas-fixture-a'] }] }],
    ];
    for (const [label, content] of cases) {
      const file = writeJson(root, `invalid-${label}.json`, content);
      expectAuthConfigInvalid(() => loadAuthConfig(file), label);
    }
    expectAuthConfigInvalid(() => loadAuthConfig(path.join(root, 'does-not-exist.json')), 'missing-file');
    expectAuthConfigInvalid(() => loadAuthConfig(''), 'empty-path');
  });

  test('validateAuthConfig rejects non-objects and accepts a minimal valid config', () => {
    expectAuthConfigInvalid(() => validateAuthConfig(null), 'null-config');
    expectAuthConfigInvalid(() => validateAuthConfig(42), 'number-config');
    const minimal = validateAuthConfig({
      version: 1,
      principals: [
        { principalId: 'p', tokenSha256: tokenSha256('demo-minimal-token'), mode: 'READ_ONLY', canvasIds: ['*'] },
      ],
    });
    assert.equal(minimal.principals[0].mode, 'READ_ONLY');
    assert.equal(minimal.principals[0].allowedTools, null);
  });
});

describe('matchPrincipal (the documented contract constant-time token matching)', () => {
  let config;
  let root;

  before(() => {
    root = createTempDir('canvas-mcp-auth-match-');
    const fixture = createAuthFixture(root, standardPrincipalSpecs());
    config = loadAuthConfig(fixture.authPath);
  });

  after(() => rmrf(root));

  test('matches the unique principal for each configured token', () => {
    assert.equal(matchPrincipal(config, FIXTURE_TOKENS.writerA).principalId, 'agent-writer-a');
    assert.equal(matchPrincipal(config, FIXTURE_TOKENS.writerB).principalId, 'agent-writer-b');
    assert.equal(matchPrincipal(config, FIXTURE_TOKENS.reader).principalId, 'agent-reader');
    assert.equal(matchPrincipal(config, FIXTURE_TOKENS.limited).principalId, 'agent-limited');
  });

  test('returns no principal for unknown, empty, wrong-case or non-string tokens', () => {
    assert.equal(matchPrincipal(config, 'demo-unknown-token'), null);
    assert.equal(matchPrincipal(config, ''), null);
    assert.equal(matchPrincipal(config, `${FIXTURE_TOKENS.writerA}!`), null);
    assert.equal(matchPrincipal(config, FIXTURE_TOKENS.writerA.toUpperCase()), null);
    assert.equal(matchPrincipal(config, 42), null);
    assert.equal(matchPrincipal(null, FIXTURE_TOKENS.writerA), null);
  });

  test('does not match a token against a different principal digest', () => {
    const writerB = matchPrincipal(config, FIXTURE_TOKENS.writerB);
    assert.equal(writerB.principalId, 'agent-writer-b');
    assert.notEqual(matchPrincipal(config, FIXTURE_TOKENS.writerB).tokenSha256, tokenSha256(FIXTURE_TOKENS.writerA));
  });
});

describe('createAuthorizer (the documented contract authorization model)', () => {
  const writerPrincipal = makePrincipal({
    principalId: 'agent-writer-a',
    token: 'demo-authorizer-writer-token',
    mode: 'CANVAS_WRITE',
    canvasIds: ['canvas-fixture-a'],
  });
  const readerPrincipal = makePrincipal({
    principalId: 'agent-reader',
    token: 'demo-authorizer-reader-token',
    mode: 'READ_ONLY',
    canvasIds: ['*'],
  });
  const limitedPrincipal = makePrincipal({
    principalId: 'agent-limited',
    token: 'demo-authorizer-limited-token',
    mode: 'CANVAS_WRITE',
    canvasIds: ['*'],
    allowedTools: ['canvas_list_canvases'],
  });

  test('CANVAS_WRITE in-scope: read and write return exactly true', () => {
    const authorize = createAuthorizer({ principal: writerPrincipal });
    const write = authorize({ requiredPermission: 'canvas:write', canvasId: 'canvas-fixture-a' });
    assert.equal(typeof write, 'boolean');
    assert.equal(write, true);
    assert.equal(authorize({ requiredPermission: 'canvas:read', canvasId: 'canvas-fixture-a' }), true);
  });

  test('CANVAS_WRITE out-of-scope: read and write return exactly false', () => {
    const authorize = createAuthorizer({ principal: writerPrincipal });
    assert.equal(authorize({ requiredPermission: 'canvas:write', canvasId: 'canvas-fixture-b' }), false);
    assert.equal(authorize({ requiredPermission: 'canvas:read', canvasId: 'canvas-fixture-b' }), false);
  });

  test('READ_ONLY: reads in scope pass, writes never do', () => {
    const authorize = createAuthorizer({ principal: readerPrincipal });
    assert.equal(authorize({ requiredPermission: 'canvas:read', canvasId: 'canvas-fixture-a' }), true);
    assert.equal(authorize({ requiredPermission: 'canvas:read', canvasId: 'canvas-anything' }), true);
    assert.equal(authorize({ requiredPermission: 'canvas:write', canvasId: 'canvas-fixture-a' }), false);
  });

  test('allowedTools restriction is enforced for reads and writes', () => {
    const authorize = createAuthorizer({ principal: limitedPrincipal });
    assert.equal(authorize({ requiredPermission: 'canvas:read', canvasId: 'canvas-fixture-a', toolName: 'canvas_list_canvases' }), true);
    assert.equal(authorize({ requiredPermission: 'canvas:read', canvasId: 'canvas-fixture-a', toolName: 'canvas_read_canvas' }), false);
    assert.equal(authorize({ requiredPermission: 'canvas:write', canvasId: 'canvas-fixture-a', toolName: 'canvas_create_node' }), false);
  });

  test('fails closed on malformed input and unknown permissions/tools', () => {
    const authorize = createAuthorizer({ principal: writerPrincipal });
    assert.equal(authorize(null), false);
    assert.equal(authorize({}), false);
    assert.equal(authorize({ requiredPermission: 'canvas:admin', canvasId: 'canvas-fixture-a' }), false);
    assert.equal(authorize({ requiredPermission: 'canvas:write' }), false);
    assert.equal(authorize({ requiredPermission: 'canvas:read', canvasId: 'canvas-fixture-a', toolName: 'bash' }), false);
    assert.equal(authorize({ requiredPermission: 'canvas:read', canvasId: 42 }), false);
  });

  test('all whitelisted tools are allowed when allowedTools is null', () => {
    const authorize = createAuthorizer({ principal: writerPrincipal });
    for (const toolName of TOOL_NAMES) {
      assert.equal(authorize({ requiredPermission: 'canvas:read', canvasId: 'canvas-fixture-a', toolName }), true);
    }
  });
});
