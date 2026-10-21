// Unit suite: node capabilities, data validation, positions, edges, actions.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  ACTION_KINDS,
  CANVAS_NODE_KINDS,
  EDGE_RELATIONS,
  NODE_CAPABILITIES,
  NODE_STATUSES,
  assertCanvasId,
  assertEdgeId,
  assertEdgeRelation,
  assertNodeId,
  assertNodeKind,
  assertOperationId,
  prepareCreateNodeData,
  validateAction,
  validateActions,
  validateMutableNodeData,
  validatePosition,
} from '../../src/canvas/capabilities.js';

const ERROR = {
  NODE_FIELD_PROTECTED: 'CANVAS_NODE_FIELD_PROTECTED',
  NODE_FIELD_UNKNOWN: 'CANVAS_NODE_FIELD_UNKNOWN',
  NODE_FIELD_INVALID: 'CANVAS_NODE_FIELD_INVALID',
  POSITION_INVALID: 'CANVAS_POSITION_INVALID',
  EDGE_RELATION_INVALID: 'CANVAS_EDGE_RELATION_INVALID',
  ACTION_INVALID: 'CANVAS_ACTION_INVALID',
  ACTION_NOT_WHITELISTED: 'CANVAS_ACTION_NOT_WHITELISTED',
  NODE_ID_INVALID: 'CANVAS_NODE_ID_INVALID',
  EDGE_ID_INVALID: 'CANVAS_EDGE_ID_INVALID',
  OPERATION_ID_INVALID: 'CANVAS_OPERATION_ID_INVALID',
  CANVAS_ID_INVALID: 'CANVAS_CANVAS_ID_INVALID',
  OPERATION_REQUEST_INVALID: 'CANVAS_OPERATION_REQUEST_INVALID',
};

function expectCode(action, expected, label) {
  const codes = Array.isArray(expected) ? expected : [expected];
  try {
    action();
  } catch (err) {
    assert.ok(
      codes.includes(err.code),
      `${label}: expected code one of ${codes.join(', ')}, got ${err.code || err.name}: ${err.message}`,
    );
    return err;
  }
  assert.fail(`${label}: expected an error with code ${codes.join(' or ')}`);
}

describe('node capabilities', () => {
  test('declares exactly the five node kinds and three action kinds', () => {
    assert.deepEqual([...CANVAS_NODE_KINDS], ['text', 'image', 'video', 'audio', 'note']);
    assert.deepEqual(Object.keys(NODE_CAPABILITIES).sort(), [...CANVAS_NODE_KINDS].sort());
    assert.deepEqual([...ACTION_KINDS], ['node.create', 'node.patch', 'edge.connect']);
  });

  test('allows exactly image->video reference and text->note context', () => {
    const allowedPairs = [];
    for (const [kind, capabilities] of Object.entries(NODE_CAPABILITIES)) {
      assert.ok(Array.isArray(capabilities.relations), `${kind}: relations must be an array`);
      for (const entry of capabilities.relations) {
        allowedPairs.push(`${kind}->${entry.targetKind}:${entry.relation}`);
      }
    }
    assert.deepEqual(allowedPairs.sort(), ['image->video:reference', 'text->note:context']);
    assert.deepEqual([...EDGE_RELATIONS].sort(), ['context', 'reference']);
  });

  test('node status enum is exactly the frozen set', () => {
    assert.deepEqual([...NODE_STATUSES].sort(), ['done', 'error', 'idle', 'running', 'skipped']);
  });
});

describe('position validation', () => {
  test('accepts exactly two finite numbers', () => {
    assert.deepEqual(validatePosition({ x: 0, y: 0 }), { x: 0, y: 0 });
    assert.deepEqual(validatePosition({ x: -1.5, y: 2.25 }), { x: -1.5, y: 2.25 });
  });

  test('rejects malformed positions with CANVAS_POSITION_INVALID', () => {
    for (const bad of [null, undefined, {}, { x: 1 }, { y: 1 }, { x: 1, y: 2, z: 3 }, { x: '1', y: 2 }, { x: Infinity, y: 0 }, { x: NaN, y: 0 }, [1, 2]]) {
      expectCode(() => validatePosition(bad), ERROR.POSITION_INVALID, `position ${JSON.stringify(bad)}`);
    }
  });
});

describe('mutable node data validation', () => {
  test('accepts every documented mutable field with valid values', () => {
    const data = {
      label: 'Valid label',
      status: 'done',
      source: 'fixture-source',
      content: 'content',
      prompt: 'prompt',
      url: 'https://example.com/asset.png',
      mimeType: 'image/png',
      width: 640,
      height: 360,
      duration: 2.5,
      errorMessage: 'none',
    };
    assert.deepEqual(validateMutableNodeData(data), data);
    assert.deepEqual(validateMutableNodeData(undefined), {});
    assert.deepEqual(validateMutableNodeData(null), {});
  });

  test('rejects protected fields with CANVAS_NODE_FIELD_PROTECTED', () => {
    for (const field of ['nodeType', 'assetId', 'stateId', 'id', 'type']) {
      expectCode(() => validateMutableNodeData({ [field]: 'x' }), ERROR.NODE_FIELD_PROTECTED, field);
    }
  });

  test('rejects unknown fields with CANVAS_NODE_FIELD_UNKNOWN', () => {
    expectCode(() => validateMutableNodeData({ bogus: 1 }), ERROR.NODE_FIELD_UNKNOWN, 'unknown field');
  });

  test('enforces string constraints (label/status/source/content/prompt/url/mimeType/errorMessage)', () => {
    const invalid = [
      ['empty label', { label: '' }],
      ['whitespace label', { label: '   ' }],
      ['long label', { label: 'x'.repeat(257) }],
      ['bad status', { status: 'paused' }],
      ['long source', { source: 's'.repeat(257) }],
      ['long content', { content: 'c'.repeat(65537) }],
      ['long prompt', { prompt: 'p'.repeat(65537) }],
      ['long url', { url: `https://example.com/${'u'.repeat(2048)}` }],
      ['non-http url', { url: 'ftp://example.com/file' }],
      ['long mimeType', { mimeType: 'm'.repeat(129) }],
      ['long errorMessage', { errorMessage: 'e'.repeat(4097) }],
      ['label wrong type', { label: 42 }],
    ];
    for (const [label, data] of invalid) {
      expectCode(() => validateMutableNodeData(data), ERROR.NODE_FIELD_INVALID, label);
    }
    // Boundary values are accepted.
    assert.equal(validateMutableNodeData({ label: 'x'.repeat(256) }).label.length, 256);
    assert.equal(validateMutableNodeData({ content: 'c'.repeat(65536) }).content.length, 65536);
    assert.equal(validateMutableNodeData({ url: `https://example.com/${'u'.repeat(2028)}` }).url.length, 2048);
    assert.equal(validateMutableNodeData({ mimeType: 'm'.repeat(128) }).mimeType.length, 128);
  });

  test('enforces numeric constraints (width/height/duration)', () => {
    const invalid = [
      ['width zero', { width: 0 }],
      ['width negative', { width: -1 }],
      ['width float', { width: 1.5 }],
      ['width string', { width: '5' }],
      ['height zero', { height: 0 }],
      ['duration zero', { duration: 0 }],
      ['duration negative', { duration: -1 }],
      ['duration infinite', { duration: Infinity }],
      ['duration string', { duration: '1' }],
    ];
    for (const [label, data] of invalid) {
      expectCode(() => validateMutableNodeData(data), ERROR.NODE_FIELD_INVALID, label);
    }
    assert.deepEqual(validateMutableNodeData({ width: 1, height: 1, duration: 0.5 }), { width: 1, height: 1, duration: 0.5 });
  });

  test('prepareCreateNodeData injects nodeType and never mutates input', () => {
    const input = { label: 'Created label', status: 'idle' };
    const prepared = prepareCreateNodeData(input, 'text');
    assert.deepEqual(prepared, { label: 'Created label', status: 'idle', nodeType: 'text' });
    assert.deepEqual(input, { label: 'Created label', status: 'idle' });
    expectCode(() => prepareCreateNodeData({}, 'bogus'), [ERROR.ACTION_INVALID, ERROR.NODE_FIELD_INVALID], 'bad kind');
    expectCode(() => prepareCreateNodeData({ nodeType: 'text' }, 'text'), ERROR.NODE_FIELD_PROTECTED, 'nodeType supplied');
  });
});

describe('identifier validation', () => {
  test('canvas ids follow the frozen pattern and never allow path separators', () => {
    for (const ok of ['canvas-fixture-a', 'A', 'a.b_c-1', 'x'.repeat(64)]) assert.equal(assertCanvasId(ok), ok);
    for (const bad of ['', '../escape', '..', 'a/b', 'a\\b', '.hidden', 'a..b', 'x'.repeat(65), 42, null]) {
      expectCode(() => assertCanvasId(bad), ERROR.CANVAS_ID_INVALID, `canvasId ${String(bad)}`);
    }
  });

  test('node/edge/operation ids allow the documented characters and reject traversal', () => {
    for (const id of ['node-1', 'n:1', 'a.b_c:d', 'x'.repeat(128)]) {
      assert.equal(assertNodeId(id), id);
      assert.equal(assertOperationId(id), id);
    }
    for (const bad of ['', '../escape', 'a/b', 'a\\b', '.hidden', 'x'.repeat(129), 'has space']) {
      expectCode(() => assertNodeId(bad), ERROR.NODE_ID_INVALID, `nodeId ${String(bad)}`);
      expectCode(() => assertEdgeId(bad), ERROR.EDGE_ID_INVALID, `edgeId ${String(bad)}`);
      expectCode(() => assertOperationId(bad), ERROR.OPERATION_ID_INVALID, `operationId ${String(bad)}`);
    }
    assert.equal(assertNodeKind('video'), 'video');
    expectCode(() => assertNodeKind('gif'), [ERROR.ACTION_INVALID, ERROR.NODE_FIELD_INVALID], 'bad kind');
  });
});

describe('edge relation rules', () => {
  const relation = (overrides) =>
    assertEdgeRelation({ sourceId: 'node-a', targetId: 'node-b', sourceKind: 'image', targetKind: 'video', relation: 'reference', ...overrides });

  test('accepts image->video reference and text->note context', () => {
    assert.doesNotThrow(() => relation({}));
    assert.doesNotThrow(() => relation({ sourceKind: 'text', targetKind: 'note', relation: 'context' }));
  });

  test('rejects any other kind/relation pair', () => {
    for (const pair of [
      { sourceKind: 'text', targetKind: 'video', relation: 'reference' },
      { sourceKind: 'image', targetKind: 'video', relation: 'context' },
      { sourceKind: 'video', targetKind: 'image', relation: 'reference' },
      { sourceKind: 'text', targetKind: 'note', relation: 'reference' },
      { sourceKind: 'audio', targetKind: 'note', relation: 'context' },
      { sourceKind: 'unknown-kind', targetKind: 'video', relation: 'reference' },
    ]) {
      expectCode(() => relation(pair), ERROR.EDGE_RELATION_INVALID, JSON.stringify(pair));
    }
  });

  test('rejects self edges even when kinds are compatible', () => {
    expectCode(() => relation({ targetId: 'node-a' }), ERROR.EDGE_RELATION_INVALID, 'self edge');
  });
});

describe('batch action validation', () => {
  test('rejects non-whitelisted action kinds', () => {
    expectCode(() => validateAction({ kind: 'shell.exec', command: 'id' }), ERROR.ACTION_NOT_WHITELISTED, 'shell action');
    expectCode(() => validateAction({ kind: 'node.delete', nodeId: 'n' }), ERROR.ACTION_NOT_WHITELISTED, 'delete action');
    expectCode(() => validateAction({ kind: undefined }), ERROR.ACTION_NOT_WHITELISTED, 'missing kind');
    expectCode(() => validateAction('not-an-object'), ERROR.ACTION_INVALID, 'non-object action');
  });

  test('normalises a valid node.create action (nodeType injected, default position)', () => {
    const action = validateAction({ kind: 'node.create', node: { id: 'node-new', type: 'note', data: { label: 'New note' } } });
    assert.deepEqual(action, {
      kind: 'node.create',
      node: {
        id: 'node-new',
        type: 'note',
        position: { x: 0, y: 0 },
        data: { label: 'New note', nodeType: 'note' },
      },
    });
  });

  test('rejects malformed node.create shapes', () => {
    expectCode(() => validateAction({ kind: 'node.create', node: { type: 'text', data: {} } }), ERROR.NODE_ID_INVALID, 'missing node id');
    expectCode(() => validateAction({ kind: 'node.create', node: { id: 'n1', type: 'bogus', data: {} } }), ERROR.ACTION_INVALID, 'bad node type');
    expectCode(() => validateAction({ kind: 'node.create', node: { id: 'n1', type: 'text', data: {}, extra: 1 } }), ERROR.ACTION_INVALID, 'extra node key');
    expectCode(() => validateAction({ kind: 'node.create', node: { id: 'n1', type: 'text', data: { nodeType: 'text' } } }), ERROR.NODE_FIELD_PROTECTED, 'protected data in create');
    expectCode(() => validateAction({ kind: 'node.create', node: { id: 'n1', type: 'text', data: { bogus: 1 } } }), ERROR.NODE_FIELD_UNKNOWN, 'unknown data field');
  });

  test('validates node.patch actions (at least one of data/position, shallow patch shape)', () => {
    const action = validateAction({ kind: 'node.patch', nodeId: 'node-text-1', patch: { data: { label: 'Patched' } } });
    assert.deepEqual(action, { kind: 'node.patch', nodeId: 'node-text-1', patch: { data: { label: 'Patched' } } });
    expectCode(() => validateAction({ kind: 'node.patch', nodeId: 'n1', patch: {} }), ERROR.ACTION_INVALID, 'empty patch');
    expectCode(
      () => validateAction({ kind: 'node.patch', patch: { data: { label: 'x' } } }),
      [ERROR.ACTION_INVALID, ERROR.NODE_ID_INVALID],
      'missing nodeId',
    );
    expectCode(() => validateAction({ kind: 'node.patch', nodeId: 'n1', patch: { data: { assetId: 'x' } } }), ERROR.NODE_FIELD_PROTECTED, 'protected patch field');
  });

  test('normalises edge.connect actions with default relation reference', () => {
    const action = validateAction({ kind: 'edge.connect', edge: { id: 'edge-new', source: 'node-image-1', target: 'node-video-1' } });
    assert.deepEqual(action, {
      kind: 'edge.connect',
      edge: { id: 'edge-new', source: 'node-image-1', target: 'node-video-1', relation: 'reference' },
    });
    expectCode(
      () => validateAction({ kind: 'edge.connect', edge: { id: 'e1', source: 'a', target: 'b', extra: 1 } }),
      ERROR.ACTION_INVALID,
      'extra edge key',
    );
  });

  test('validateActions enforces the 1..100 action bounds', () => {
    const action = (i) => ({ kind: 'node.create', node: { id: `node-bulk-${i}`, type: 'text', data: { label: `Bulk ${i}` } } });
    assert.equal(validateActions([action(0)]).length, 1);
    assert.equal(validateActions(Array.from({ length: 100 }, (_, i) => action(i))).length, 100);
    expectCode(() => validateActions([]), ERROR.OPERATION_REQUEST_INVALID, 'empty actions');
    expectCode(() => validateActions(Array.from({ length: 101 }, (_, i) => action(i))), ERROR.OPERATION_REQUEST_INVALID, 'too many actions');
    expectCode(() => validateActions('nope'), ERROR.OPERATION_REQUEST_INVALID, 'non-array actions');
  });
});
