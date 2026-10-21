/**
 * Canvas domain primitives: identifiers, node kinds, capabilities, data-field validation,
 * position validation and action-shape validation.
 *
 * This module is pure (no filesystem access); the store and operation runtime build on it.
 */
import { ERROR_CODES, canvasError } from '../errors.js';

/** Canvas ids: safe for a single file name inside `<store>/canvases/`. */
export const CANVAS_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** Node ids, edge ids and operation ids share one conservative shape. */
export const NODE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const EDGE_ID_PATTERN = NODE_ID_PATTERN;
export const OPERATION_ID_PATTERN = NODE_ID_PATTERN;
/** Principal ids are configured by the operator; keep them printable and short. */
export const PRINCIPAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;
/** `--agent-id` is an operator supplied ASCII label recorded in receipts and logs. */
export const AGENT_ID_PATTERN = /^[\x21-\x7E]{1,64}$/;

export const NODE_STATUSES = Object.freeze(['idle', 'running', 'done', 'error', 'skipped']);

/** All node kinds supported by the generic canvas model. */
export const CANVAS_NODE_KINDS = Object.freeze(['text', 'image', 'video', 'audio', 'note']);
const NODE_KINDS_SET = new Set(CANVAS_NODE_KINDS);

/** Keys of `data` that callers may write (see the documented contract). */
export const MUTABLE_NODE_DATA_FIELDS = Object.freeze([
  'label',
  'status',
  'source',
  'content',
  'prompt',
  'url',
  'mimeType',
  'width',
  'height',
  'duration',
  'errorMessage'
]);

/** Keys of `data` that callers must never write directly. */
export const PROTECTED_NODE_DATA_FIELDS = Object.freeze(['nodeType', 'assetId', 'stateId', 'id', 'type']);
const PROTECTED_FIELDS_SET = new Set(PROTECTED_NODE_DATA_FIELDS);

/** Action kinds accepted by `canvas_commit_batch`. */
export const ACTION_KINDS = Object.freeze(['node.create', 'node.patch', 'edge.connect']);
const ACTION_KINDS_SET = new Set(ACTION_KINDS);

/** Edge relation labels understood by the capability table. */
export const EDGE_RELATIONS = Object.freeze(['reference', 'context']);

const MAX_STRING_LENGTH = Object.freeze({
  label: 256,
  source: 256,
  content: 65536,
  prompt: 65536,
  url: 2048,
  mimeType: 128,
  errorMessage: 4096
});

/**
 * Node capability table. Each kind may declare outgoing relations that are allowed
 * towards another node kind. All other combinations are rejected with
 * `CANVAS_EDGE_RELATION_INVALID`.
 */
export const NODE_CAPABILITIES = Object.freeze({
  text: Object.freeze({
    kind: 'text',
    mutableDataFields: MUTABLE_NODE_DATA_FIELDS,
    relations: Object.freeze([Object.freeze({ relation: 'context', targetKind: 'note' })])
  }),
  image: Object.freeze({
    kind: 'image',
    mutableDataFields: MUTABLE_NODE_DATA_FIELDS,
    relations: Object.freeze([Object.freeze({ relation: 'reference', targetKind: 'video' })])
  }),
  video: Object.freeze({
    kind: 'video',
    mutableDataFields: MUTABLE_NODE_DATA_FIELDS,
    relations: Object.freeze([])
  }),
  audio: Object.freeze({
    kind: 'audio',
    mutableDataFields: MUTABLE_NODE_DATA_FIELDS,
    relations: Object.freeze([])
  }),
  note: Object.freeze({
    kind: 'note',
    mutableDataFields: MUTABLE_NODE_DATA_FIELDS,
    relations: Object.freeze([])
  })
});

/**
 * Internal marker attached to actions constructed by the MCP dispatcher.
 * A marked create action already contains the injected `data.nodeType`, which is an
 * invariant of stored nodes but must not be accepted from untrusted callers.
 */
const INTERNAL_ACTION = Symbol('canvas.internalAction');

/** Mark an action as safely constructed by the trusted dispatcher. */
export function markInternalAction(action) {
  Object.defineProperty(action, INTERNAL_ACTION, { value: true, enumerable: false });
  return action;
}

/** Return `true` when the action was built by the trusted dispatcher. */
export function isInternalAction(action) {
  return Boolean(action && typeof action === 'object' && action[INTERNAL_ACTION]);
}

/** Return `true` for JSON-like plain objects only. */
export function isPlainObject(value) {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function assertSafeId(value, pattern, code, label) {
  if (
    typeof value !== 'string' ||
    !pattern.test(value) ||
    value.includes('..') ||
    value.includes('/') ||
    value.includes('\\')
  ) {
    throw canvasError(code, `invalid ${label}`);
  }
  return value;
}

export function assertCanvasId(canvasId) {
  return assertSafeId(canvasId, CANVAS_ID_PATTERN, ERROR_CODES.CANVAS_ID_INVALID, 'canvasId');
}

export function assertNodeId(nodeId) {
  return assertSafeId(nodeId, NODE_ID_PATTERN, ERROR_CODES.NODE_ID_INVALID, 'nodeId');
}

export function assertEdgeId(edgeId) {
  return assertSafeId(edgeId, EDGE_ID_PATTERN, ERROR_CODES.EDGE_ID_INVALID, 'edgeId');
}

export function assertOperationId(operationId) {
  return assertSafeId(operationId, OPERATION_ID_PATTERN, ERROR_CODES.OPERATION_ID_INVALID, 'operationId');
}

export function assertPrincipalId(principalId) {
  if (typeof principalId !== 'string' || !PRINCIPAL_ID_PATTERN.test(principalId) || principalId.includes('..')) {
    throw canvasError(ERROR_CODES.AUTH_CONFIG_INVALID, 'invalid principalId');
  }
  return principalId;
}

export function assertAgentId(agentId) {
  if (typeof agentId !== 'string' || !AGENT_ID_PATTERN.test(agentId)) {
    throw canvasError(ERROR_CODES.ARGUMENTS_INVALID, 'invalid agentId');
  }
  return agentId;
}

/** Assert that a node kind is one of `CANVAS_NODE_KINDS`. */
export function assertNodeKind(kind) {
  if (typeof kind !== 'string' || !NODE_KINDS_SET.has(kind)) {
    throw canvasError(ERROR_CODES.ACTION_INVALID, `node type must be one of: ${CANVAS_NODE_KINDS.join(', ')}`);
  }
  return kind;
}

/**
 * Validate a position object: exactly two finite numbers `x` and `y`.
 *
 * @param {unknown} position
 * @returns {{x: number, y: number}}
 */
export function validatePosition(position) {
  if (!isPlainObject(position)) {
    throw canvasError(ERROR_CODES.POSITION_INVALID, 'position must be an object with numeric x and y');
  }
  const keys = Object.keys(position);
  if (keys.length !== 2 || !('x' in position) || !('y' in position)) {
    throw canvasError(ERROR_CODES.POSITION_INVALID, 'position must contain exactly x and y');
  }
  if (typeof position.x !== 'number' || !Number.isFinite(position.x)) {
    throw canvasError(ERROR_CODES.POSITION_INVALID, 'position.x must be a finite number');
  }
  if (typeof position.y !== 'number' || !Number.isFinite(position.y)) {
    throw canvasError(ERROR_CODES.POSITION_INVALID, 'position.y must be a finite number');
  }
  return { x: position.x, y: position.y };
}

function invalidField(field, message) {
  return canvasError(ERROR_CODES.NODE_FIELD_INVALID, `invalid node data field "${field}": ${message}`);
}

function validateStringField(field, value, maxLength) {
  if (typeof value !== 'string') {
    throw invalidField(field, 'expected a string');
  }
  if (value.length > maxLength) {
    throw invalidField(field, `must be at most ${maxLength} characters`);
  }
  return value;
}

/** Field-specific validators for caller-writable node `data`. */
const DATA_FIELD_VALIDATORS = Object.freeze({
  label(value) {
    if (typeof value !== 'string') {
      throw invalidField('label', 'expected a string');
    }
    if (value.trim().length === 0) {
      throw invalidField('label', 'must not be empty');
    }
    if (value.length > MAX_STRING_LENGTH.label) {
      throw invalidField('label', `must be at most ${MAX_STRING_LENGTH.label} characters`);
    }
    return value;
  },
  status(value) {
    if (typeof value !== 'string' || !NODE_STATUSES.includes(value)) {
      throw invalidField('status', `must be one of: ${NODE_STATUSES.join(', ')}`);
    }
    return value;
  },
  source(value) {
    return validateStringField('source', value, MAX_STRING_LENGTH.source);
  },
  content(value) {
    return validateStringField('content', value, MAX_STRING_LENGTH.content);
  },
  prompt(value) {
    return validateStringField('prompt', value, MAX_STRING_LENGTH.prompt);
  },
  url(value) {
    validateStringField('url', value, MAX_STRING_LENGTH.url);
    if (!value.startsWith('https://') && !value.startsWith('http://')) {
      throw invalidField('url', 'must start with https:// or http://');
    }
    return value;
  },
  mimeType(value) {
    return validateStringField('mimeType', value, MAX_STRING_LENGTH.mimeType);
  },
  width(value) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw invalidField('width', 'must be a positive integer');
    }
    return value;
  },
  height(value) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw invalidField('height', 'must be a positive integer');
    }
    return value;
  },
  duration(value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw invalidField('duration', 'must be a positive finite number');
    }
    return value;
  },
  errorMessage(value) {
    return validateStringField('errorMessage', value, MAX_STRING_LENGTH.errorMessage);
  }
});

/**
 * Validate caller supplied `data` for a create/patch operation.
 * Protected and unknown fields are rejected before any value validation.
 *
 * @param {unknown} rawData
 * @returns {object} normalised mutable fields (protected fields never included)
 */
export function validateMutableNodeData(rawData) {
  if (rawData === undefined || rawData === null) {
    return {};
  }
  if (!isPlainObject(rawData)) {
    throw canvasError(ERROR_CODES.NODE_FIELD_INVALID, 'node data must be a plain object');
  }
  const result = {};
  for (const field of Object.keys(rawData)) {
    if (PROTECTED_FIELDS_SET.has(field)) {
      throw canvasError(ERROR_CODES.NODE_FIELD_PROTECTED, `node data field "${field}" is protected`);
    }
    const validator = DATA_FIELD_VALIDATORS[field];
    if (!validator) {
      throw canvasError(ERROR_CODES.NODE_FIELD_UNKNOWN, `unknown node data field "${field}"`);
    }
    result[field] = validator(rawData[field]);
  }
  return result;
}

/**
 * Prepare caller data for a `node.create` action: validate mutable fields and inject
 * `data.nodeType = kind` (the invariant every stored node must satisfy).
 *
 * @param {unknown} rawData
 * @param {string} kind
 * @returns {object}
 */
export function prepareCreateNodeData(rawData, kind) {
  assertNodeKind(kind);
  return { ...validateMutableNodeData(rawData), nodeType: kind };
}

/**
 * Validate `data` of a node.create action that was already prepared by the trusted
 * dispatcher (it contains the injected `nodeType`).
 *
 * @param {unknown} data
 * @param {string} nodeType
 * @returns {object}
 */
export function validatePreparedNodeData(data, nodeType) {
  if (!isPlainObject(data)) {
    throw canvasError(ERROR_CODES.NODE_FIELD_INVALID, 'node data must be a plain object');
  }
  const result = {};
  for (const field of Object.keys(data)) {
    if (field === 'nodeType') {
      if (data[field] !== nodeType) {
        throw canvasError(ERROR_CODES.NODE_FIELD_PROTECTED, 'node data field "nodeType" is protected');
      }
      continue;
    }
    if (PROTECTED_FIELDS_SET.has(field)) {
      throw canvasError(ERROR_CODES.NODE_FIELD_PROTECTED, `node data field "${field}" is protected`);
    }
    const validator = DATA_FIELD_VALIDATORS[field];
    if (!validator) {
      throw canvasError(ERROR_CODES.NODE_FIELD_UNKNOWN, `unknown node data field "${field}"`);
    }
    result[field] = validator(data[field]);
  }
  result.nodeType = nodeType;
  return result;
}

function assertNoUnknownKeys(object, allowedKeys, code, label) {
  for (const key of Object.keys(object)) {
    if (!allowedKeys.includes(key)) {
      throw canvasError(code, `${label} contains unknown key "${key}"`);
    }
  }
}

function assertExactKeys(object, allowedKeys, code, label) {
  assertNoUnknownKeys(object, allowedKeys, code, label);
  for (const key of allowedKeys) {
    if (!(key in object)) {
      throw canvasError(code, `${label} is missing required key "${key}"`);
    }
  }
}

/**
 * Validate the relation between a source node and a target node against the capability
 * table, including the self-edge rule.
 */
export function assertEdgeRelation({ sourceId, targetId, sourceKind, targetKind, relation }) {
  if (sourceId === targetId) {
    throw canvasError(ERROR_CODES.EDGE_RELATION_INVALID, 'self references are not allowed');
  }
  const sourceCaps = NODE_CAPABILITIES[sourceKind];
  const allowed = sourceCaps?.relations.some(
    (entry) => entry.relation === relation && entry.targetKind === targetKind
  );
  if (!allowed) {
    throw canvasError(
      ERROR_CODES.EDGE_RELATION_INVALID,
      `relation "${relation}" from ${sourceKind} to ${targetKind} is not allowed`
    );
  }
}

function validateNodeCreateAction(action) {
  assertExactKeys(action, ['kind', 'node'], ERROR_CODES.ACTION_INVALID, 'node.create action');
  const node = action.node;
  if (!isPlainObject(node)) {
    throw canvasError(ERROR_CODES.ACTION_INVALID, 'node.create requires a node object');
  }
  assertNoUnknownKeys(node, ['id', 'type', 'position', 'data'], ERROR_CODES.ACTION_INVALID, 'node');
  const id = assertNodeId(node.id);
  if (typeof node.type !== 'string' || !NODE_KINDS_SET.has(node.type)) {
    throw canvasError(ERROR_CODES.ACTION_INVALID, `node type must be one of: ${CANVAS_NODE_KINDS.join(', ')}`);
  }
  const position = node.position === undefined ? { x: 0, y: 0 } : validatePosition(node.position);
  const data = isInternalAction(action)
    ? validatePreparedNodeData(node.data, node.type)
    : prepareCreateNodeData(node.data, node.type);
  return { kind: 'node.create', node: { id, type: node.type, position, data } };
}

function validateNodePatchAction(action) {
  assertExactKeys(action, ['kind', 'nodeId', 'patch'], ERROR_CODES.ACTION_INVALID, 'node.patch action');
  const nodeId = assertNodeId(action.nodeId);
  const patch = action.patch;
  if (!isPlainObject(patch)) {
    throw canvasError(ERROR_CODES.ACTION_INVALID, 'node.patch requires a patch object');
  }
  assertNoUnknownKeys(patch, ['data', 'position'], ERROR_CODES.ACTION_INVALID, 'patch');
  if (patch.data === undefined && patch.position === undefined) {
    throw canvasError(ERROR_CODES.ACTION_INVALID, 'node.patch requires at least one of data or position');
  }
  const normalised = {};
  if (patch.data !== undefined) {
    normalised.data = validateMutableNodeData(patch.data);
  }
  if (patch.position !== undefined) {
    normalised.position = validatePosition(patch.position);
  }
  return { kind: 'node.patch', nodeId, patch: normalised };
}

function validateEdgeConnectAction(action) {
  assertExactKeys(action, ['kind', 'edge'], ERROR_CODES.ACTION_INVALID, 'edge.connect action');
  const edge = action.edge;
  if (!isPlainObject(edge)) {
    throw canvasError(ERROR_CODES.ACTION_INVALID, 'edge.connect requires an edge object');
  }
  assertNoUnknownKeys(edge, ['id', 'source', 'target', 'relation'], ERROR_CODES.ACTION_INVALID, 'edge');
  const id = assertEdgeId(edge.id);
  const source = assertNodeId(edge.source);
  const target = assertNodeId(edge.target);
  const relation = edge.relation === undefined ? 'reference' : edge.relation;
  if (typeof relation !== 'string' || relation.length === 0) {
    throw canvasError(ERROR_CODES.EDGE_RELATION_INVALID, 'edge relation must be a non-empty string');
  }
  return { kind: 'edge.connect', edge: { id, source, target, relation } };
}

/**
 * Validate one operation action and return a normalised copy.
 * Unknown action kinds are reported as `CANVAS_ACTION_NOT_WHITELISTED`; malformed shapes
 * as `CANVAS_ACTION_INVALID`.
 *
 * @param {unknown} action
 * @returns {{kind: string} & object}
 */
export function validateAction(action) {
  if (!isPlainObject(action)) {
    throw canvasError(ERROR_CODES.ACTION_INVALID, 'action must be a plain object');
  }
  const kind = action.kind;
  if (typeof kind !== 'string' || !ACTION_KINDS_SET.has(kind)) {
    throw canvasError(
      ERROR_CODES.ACTION_NOT_WHITELISTED,
      `action kind must be one of: ${ACTION_KINDS.join(', ')}`
    );
  }
  switch (kind) {
    case 'node.create':
      return validateNodeCreateAction(action);
    case 'node.patch':
      return validateNodePatchAction(action);
    case 'edge.connect':
      return validateEdgeConnectAction(action);
    default:
      throw canvasError(ERROR_CODES.ACTION_NOT_WHITELISTED, 'action kind is not whitelisted');
  }
}

/** Normalise and validate an actions array (shape only, not state-dependent conflicts). */
export function validateActions(actions) {
  if (!Array.isArray(actions)) {
    throw canvasError(ERROR_CODES.OPERATION_REQUEST_INVALID, 'actions must be an array');
  }
  if (actions.length < 1 || actions.length > 100) {
    throw canvasError(ERROR_CODES.OPERATION_REQUEST_INVALID, 'actions must contain between 1 and 100 entries');
  }
  return actions.map((action) => validateAction(action));
}
