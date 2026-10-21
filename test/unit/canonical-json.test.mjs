// Unit suite: canonical JSON determinism and hashing (src/canonical-json.js).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { canonicalJson, hashCanonicalJson } from '../../src/canonical-json.js';
import { independentCanonicalJson, independentHash } from '../helpers/canonical-independent.mjs';

const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

describe('canonicalJson: deterministic canonical serialisation', () => {
  test('sorts object keys recursively and emits compact JSON', () => {
    assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
    assert.equal(canonicalJson({ b: { d: 4, c: 3 }, a: [3, 1, 2] }), '{"a":[3,1,2],"b":{"c":3,"d":4}}');
    assert.equal(canonicalJson([{ b: 1, a: 2 }]), '[{"a":2,"b":1}]');
    assert.equal(canonicalJson({ z: { y: { x: 1 } }, a: true }), '{"a":true,"z":{"y":{"x":1}}}');
  });

  test('is independent of object key insertion order', () => {
    const first = { alpha: 1, beta: { zeta: 2, eta: 3 }, gamma: [1, 2] };
    const second = { gamma: [1, 2], beta: { eta: 3, zeta: 2 }, alpha: 1 };
    assert.equal(canonicalJson(first), canonicalJson(second));
    assert.equal(hashCanonicalJson(first), hashCanonicalJson(second));
  });

  test('preserves array element order', () => {
    assert.equal(canonicalJson([3, 1, 2]), '[3,1,2]');
    assert.equal(canonicalJson(['b', 'a']), '["b","a"]');
    assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]));
  });

  test('serialises primitives like JSON.stringify', () => {
    assert.equal(canonicalJson(null), 'null');
    assert.equal(canonicalJson(true), 'true');
    assert.equal(canonicalJson(false), 'false');
    assert.equal(canonicalJson(0), '0');
    assert.equal(canonicalJson(1.5), '1.5');
    assert.equal(canonicalJson(-3), '-3');
    const tricky = 'quote " backslash \\ newline \n unicode ✓ tab \t';
    assert.equal(canonicalJson(tricky), JSON.stringify(tricky));
    assert.equal(canonicalJson({ s: tricky }), JSON.stringify({ s: tricky }));
  });

  test('omits undefined object properties (recursively)', () => {
    assert.equal(canonicalJson({ a: undefined, b: 1 }), '{"b":1}');
    assert.equal(canonicalJson({ a: { x: undefined, y: 2 } }), '{"a":{"y":2}}');
    assert.equal(canonicalJson({ a: undefined }), '{}');
  });

  test('normalises -0 to 0', () => {
    assert.equal(canonicalJson(-0), '0');
    assert.equal(canonicalJson({ n: -0 }), '{"n":0}');
    assert.equal(canonicalJson([-0]), '[0]');
  });

  test('rejects non-finite numbers (top level and nested)', () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      assert.throws(() => canonicalJson(bad), TypeError);
      assert.throws(() => canonicalJson({ n: bad }), TypeError);
      assert.throws(() => canonicalJson({ nested: [{ deep: bad }] }), TypeError);
      assert.throws(() => hashCanonicalJson({ n: bad }), TypeError);
    }
  });

  test('matches an independent canonical-JSON implementation on operation-shaped data', () => {
    const payload = {
      canvasId: 'canvas-fixture-a',
      expectedRevision: 0,
      actions: [
        { kind: 'node.patch', nodeId: 'node-text-1', patch: { data: { label: 'L', width: 128 } } },
        { kind: 'node.create', node: { id: 'node-new', type: 'note', position: { x: 1, y: 2 }, data: { nodeType: 'note' } } },
      ],
    };
    assert.equal(canonicalJson(payload), independentCanonicalJson(payload));
  });
});

describe('hashCanonicalJson: stable sha256 of canonical JSON', () => {
  test('returns the sha256 of the canonical JSON text', () => {
    assert.equal(hashCanonicalJson({ b: 1, a: 2 }), sha256('{"a":2,"b":1}'));
    assert.equal(hashCanonicalJson({ b: 1, a: 2 }), independentHash({ b: 1, a: 2 }));
  });

  test('returns 64 lowercase hex characters and is stable/deterministic', () => {
    const value = { z: 1, a: [true, null, 'x'], m: { y: 2, b: 3 } };
    const first = hashCanonicalJson(value);
    const second = hashCanonicalJson(value);
    assert.match(first, /^[0-9a-f]{64}$/);
    assert.equal(first, second);
    assert.equal(first, independentHash(value));
  });

  test('different logical values hash differently; key order does not change the hash', () => {
    assert.notEqual(hashCanonicalJson({ a: 1 }), hashCanonicalJson({ a: 2 }));
    assert.notEqual(hashCanonicalJson({ a: 1 }), hashCanonicalJson({ b: 1 }));
    assert.notEqual(hashCanonicalJson([1, 2]), hashCanonicalJson([2, 1]));
    assert.equal(hashCanonicalJson({ a: 1, b: 2 }), hashCanonicalJson({ b: 2, a: 1 }));
  });
});
