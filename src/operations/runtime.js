/**
 * Operation runtime: validates an operation envelope, enforces authorisation, performs the
 * compare-and-swap write inside the canvas lock and persists a durable receipt atomically
 * with the new canvas state. Replays are idempotent and byte-equivalent to the first result.
 */
import { ERROR_CODES, canvasError } from '../errors.js';
import { hashCanonicalJson } from '../canonical-json.js';
import {
  assertCanvasId,
  assertEdgeRelation,
  isPlainObject,
  validateAction
} from '../canvas/capabilities.js';
import { assertTrustedScope, createOperationScope } from './scope.js';

const ENVELOPE_KEYS = ['operationId', 'kind', 'payload'];
const PAYLOAD_KEYS = ['canvasId', 'expectedRevision', 'actions'];
const BATCH_KIND = 'canvas.batch';

function assertExactKeys(object, allowedKeys, code, label) {
  for (const key of Object.keys(object)) {
    if (!allowedKeys.includes(key)) {
      throw canvasError(code, `${label} contains unknown key "${key}"`);
    }
  }
  for (const key of allowedKeys) {
    if (!(key in object)) {
      throw canvasError(code, `${label} is missing required key "${key}"`);
    }
  }
}

const OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function assertOperationId(operationId) {
  if (
    typeof operationId !== 'string' ||
    !OPERATION_ID_PATTERN.test(operationId) ||
    operationId.includes('..')
  ) {
    throw canvasError(ERROR_CODES.OPERATION_ID_INVALID, 'invalid operationId');
  }
  return operationId;
}

function nodeIndex(state) {
  return new Map(state.data.nodes.map((node) => [node.id, node]));
}

function assertFreshNodeId(state, nodeId, operationId) {
  const conflict = () =>
    canvasError(ERROR_CODES.NODE_ID_CONFLICT, `node id "${nodeId}" is already in use`, { nodeId });
  if (nodeId === state.canvas.canvasId) {
    throw conflict();
  }
  if (nodeId === operationId) {
    throw conflict();
  }
  if (state.data.nodes.some((node) => node.id === nodeId)) {
    throw conflict();
  }
  if (state.data.edges.some((edge) => edge.id === nodeId)) {
    throw conflict();
  }
  if (state.tombstones.nodes.includes(nodeId) || state.tombstones.edges.includes(nodeId)) {
    throw conflict();
  }
  if (Object.prototype.hasOwnProperty.call(state.receipts, nodeId)) {
    throw conflict();
  }
}

/** Built-in action handlers. They mutate the cloned state only; the store persists it. */
export const DEFAULT_ACTION_HANDLERS = Object.freeze({
  'node.create'(state, action, context) {
    const { node } = action;
    assertFreshNodeId(state, node.id, context.operationId);
    state.data.nodes.push({
      id: node.id,
      type: node.type,
      position: { x: node.position.x, y: node.position.y },
      data: { ...node.data }
    });
  },

  'node.patch'(state, action) {
    const nodes = nodeIndex(state);
    const node = nodes.get(action.nodeId);
    if (!node) {
      throw canvasError(ERROR_CODES.NODE_NOT_FOUND, `node "${action.nodeId}" was not found`, {
        nodeId: action.nodeId
      });
    }
    if (action.patch.position !== undefined) {
      node.position = { x: action.patch.position.x, y: action.patch.position.y };
    }
    if (action.patch.data !== undefined) {
      node.data = { ...node.data, ...action.patch.data };
    }
  },

  'edge.connect'(state, action) {
    const { edge } = action;
    const nodes = nodeIndex(state);
    const source = nodes.get(edge.source);
    const target = nodes.get(edge.target);
    if (!source || !target) {
      const missingId = !source ? edge.source : edge.target;
      throw canvasError(ERROR_CODES.NODE_NOT_FOUND, `node "${missingId}" was not found`, {
        nodeId: missingId
      });
    }
    const duplicateId =
      state.data.edges.some((existing) => existing.id === edge.id) ||
      state.tombstones.edges.includes(edge.id);
    if (duplicateId) {
      throw canvasError(ERROR_CODES.EDGE_ID_CONFLICT, `edge id "${edge.id}" is already in use`, {
        edgeId: edge.id
      });
    }
    const duplicateTriple = state.data.edges.some(
      (existing) =>
        existing.source === edge.source &&
        existing.target === edge.target &&
        existing.relation === edge.relation
    );
    if (duplicateTriple) {
      throw canvasError(
        ERROR_CODES.EDGE_ID_CONFLICT,
        'an edge with the same source, target and relation already exists'
      );
    }
    assertEdgeRelation({
      sourceId: edge.source,
      targetId: edge.target,
      sourceKind: source.type,
      targetKind: target.type,
      relation: edge.relation
    });
    state.data.edges.push({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      relation: edge.relation
    });
  }
});

/**
 * Registry of action handlers keyed by action kind. It is pre-populated with the three
 * built-in kinds and can be extended (or overridden) by embedders.
 */
export class OperationRegistry {
  /** @param {Record<string, Function>} [initialHandlers] */
  constructor(initialHandlers) {
    this.handlers = new Map();
    for (const [kind, handler] of Object.entries(DEFAULT_ACTION_HANDLERS)) {
      this.handlers.set(kind, handler);
    }
    if (initialHandlers !== undefined) {
      for (const [kind, handler] of Object.entries(initialHandlers)) {
        this.register(kind, handler);
      }
    }
  }

  register(kind, handler) {
    if (typeof kind !== 'string' || kind.length === 0) {
      throw new TypeError('action kind must be a non-empty string');
    }
    if (typeof handler !== 'function') {
      throw new TypeError('action handler must be a function');
    }
    this.handlers.set(kind, handler);
    return this;
  }

  has(kind) {
    return this.handlers.has(kind);
  }

  get(kind) {
    return this.handlers.get(kind);
  }

  kinds() {
    return [...this.handlers.keys()];
  }
}

function validateEnvelope(envelope) {
  if (!isPlainObject(envelope)) {
    throw canvasError(ERROR_CODES.OPERATION_REQUEST_INVALID, 'operation must be a plain object');
  }
  assertExactKeys(envelope, ENVELOPE_KEYS, ERROR_CODES.OPERATION_REQUEST_INVALID, 'operation');
  const operationId = assertOperationId(envelope.operationId);
  if (envelope.kind !== BATCH_KIND) {
    throw canvasError(ERROR_CODES.OPERATION_REQUEST_INVALID, `operation kind must be "${BATCH_KIND}"`);
  }
  const payload = envelope.payload;
  if (!isPlainObject(payload)) {
    throw canvasError(ERROR_CODES.OPERATION_REQUEST_INVALID, 'operation payload must be a plain object');
  }
  assertExactKeys(payload, PAYLOAD_KEYS, ERROR_CODES.OPERATION_REQUEST_INVALID, 'payload');
  const { canvasId, expectedRevision, actions } = payload;
  if (typeof canvasId !== 'string' || canvasId.length === 0) {
    throw canvasError(ERROR_CODES.CANVAS_ID_INVALID, 'payload canvasId is invalid');
  }
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw canvasError(ERROR_CODES.REVISION_REQUIRED, 'payload expectedRevision is required');
  }
  if (!Array.isArray(actions) || actions.length < 1 || actions.length > 100) {
    throw canvasError(
      ERROR_CODES.OPERATION_REQUEST_INVALID,
      'payload actions must contain between 1 and 100 entries'
    );
  }
  const validatedActions = actions.map((action) => validateAction(action));
  return { operationId, payload, validatedActions };
}

function buildReplayResult(receipt, payloadHash) {
  return {
    ok: true,
    replayed: true,
    operationId: receipt.operationId,
    kind: BATCH_KIND,
    payloadHash,
    revision: receipt.resultingRevision,
    result: receipt.result
  };
}

/**
 * Create the operation executor.
 *
 * @param {object} options
 * @param {object} options.store a store created by `createFileCanvasStore`
 * @param {OperationRegistry} [options.registry]
 * @param {(input: object) => boolean} options.authorize authorizer bound to a principal
 * @param {object} [options.principal] principal used for receipt attribution and auth
 * @param {string} [options.agentId] recorded agent id (defaults to the principal id)
 * @returns {{execute: Function, executeOperation: Function, registry: OperationRegistry}}
 */
export function createOperationExecutor({
  store,
  registry = new OperationRegistry(),
  authorize,
  principal,
  agentId
} = {}) {
  if (!store || typeof store.updateCanvas !== 'function' || typeof store.readCanvas !== 'function') {
    throw new TypeError('createOperationExecutor requires a canvas store');
  }
  if (typeof authorize !== 'function') {
    throw new TypeError('createOperationExecutor requires an authorize function');
  }
  if (!(registry instanceof OperationRegistry) && (!registry || typeof registry.get !== 'function')) {
    throw new TypeError('registry must be an OperationRegistry');
  }
  const boundPrincipal = principal ?? authorize.principal ?? null;
  const resolvedAgentId =
    typeof agentId === 'string' && agentId.length > 0
      ? agentId
      : typeof boundPrincipal?.principalId === 'string'
        ? boundPrincipal.principalId
        : undefined;

  /**
   * Execute one operation envelope. Can be called as `execute(envelope)` (the scope is
   * derived from the authenticated principal) or `execute(scope, envelope)` where `scope`
   * must be a trusted scope created by `createOperationScope`.
   */
  function execute(scopeOrEnvelope, maybeEnvelope) {
    const startedAt = Date.now();
    let trustedScope;
    let envelope;
    if (maybeEnvelope !== undefined) {
      assertTrustedScope(scopeOrEnvelope);
      trustedScope = scopeOrEnvelope;
      envelope = maybeEnvelope;
    } else {
      envelope = scopeOrEnvelope;
    }

    const { operationId, payload, validatedActions } = validateEnvelope(envelope);
    const canvasId = assertCanvasId(payload.canvasId);

    if (trustedScope !== undefined) {
      if (trustedScope.canvasId !== canvasId) {
        throw canvasError(ERROR_CODES.AUTH_DENIED, 'operation scope does not match payload canvasId');
      }
      if (
        boundPrincipal !== null &&
        typeof boundPrincipal?.principalId === 'string' &&
        boundPrincipal.principalId !== trustedScope.principalId
      ) {
        throw canvasError(ERROR_CODES.AUTH_DENIED, 'operation scope does not match principal');
      }
    } else {
      const principalId = boundPrincipal?.principalId;
      if (typeof principalId !== 'string' || principalId.length === 0) {
        throw canvasError(ERROR_CODES.AUTH_DENIED, 'authenticated principal is required');
      }
      trustedScope = createOperationScope({ principalId, canvasId });
    }

    const payloadHash = hashCanonicalJson(payload);
    const scopeHash = hashCanonicalJson(trustedScope);

    const authorized = authorize({
      principal: boundPrincipal,
      canvasId,
      requiredPermission: 'canvas:write'
    });
    if (authorized !== true) {
      throw canvasError(ERROR_CODES.AUTH_DENIED, 'principal is not allowed to write this canvas');
    }

    const outcome = store.updateCanvas(canvasId, (current) => {
      const existingReceipt = current.receipts[operationId];
      if (existingReceipt !== undefined) {
        if (existingReceipt.scopeHash !== scopeHash) {
          throw canvasError(
            ERROR_CODES.OPERATION_SCOPE_CONFLICT,
            'operationId was already used by a different scope'
          );
        }
        if (existingReceipt.kind !== BATCH_KIND) {
          throw canvasError(
            ERROR_CODES.OPERATION_KIND_CONFLICT,
            'operationId was already used by a different operation kind'
          );
        }
        if (existingReceipt.payloadHash !== payloadHash) {
          throw canvasError(
            ERROR_CODES.OPERATION_PAYLOAD_CONFLICT,
            'operationId was already used with a different payload'
          );
        }
        return { value: buildReplayResult(existingReceipt, payloadHash), nextState: undefined };
      }

      if (current.revision !== payload.expectedRevision) {
        throw canvasError(
          ERROR_CODES.REVISION_CONFLICT,
          'canvas revision does not match expectedRevision',
          { expectedRevision: payload.expectedRevision, actualRevision: current.revision }
        );
      }
      const newRevision = current.revision + 1;
      if (!Number.isSafeInteger(newRevision)) {
        throw canvasError(ERROR_CODES.REVISION_EXHAUSTED, 'canvas revision space is exhausted');
      }

      const nextState = structuredClone(current);
      for (const action of validatedActions) {
        const handler = registry.get(action.kind);
        if (typeof handler !== 'function') {
          throw canvasError(
            ERROR_CODES.ACTION_NOT_WHITELISTED,
            `action kind "${action.kind}" is not registered`
          );
        }
        handler(nextState, action, { operationId });
      }

      const committedAt = new Date().toISOString();
      nextState.revision = newRevision;
      nextState.updatedAt = committedAt;
      const result = {
        canvasId,
        revision: newRevision,
        nodes: nextState.data.nodes.length,
        edges: nextState.data.edges.length
      };
      const receipt = {
        operationId,
        kind: BATCH_KIND,
        payloadHash,
        scopeHash,
        scope: { principalId: trustedScope.principalId, canvasId },
        expectedRevision: payload.expectedRevision,
        resultingRevision: newRevision,
        actionKinds: validatedActions.map((action) => action.kind),
        principalId: trustedScope.principalId,
        agentId: resolvedAgentId ?? trustedScope.principalId,
        committedAt,
        durationMs: Math.max(0, Date.now() - startedAt),
        result
      };
      nextState.receipts[operationId] = receipt;

      return {
        value: {
          ok: true,
          replayed: false,
          operationId,
          kind: BATCH_KIND,
          payloadHash,
          revision: newRevision,
          result
        },
        nextState
      };
    });

    return outcome;
  }

  return {
    execute,
    executeOperation: execute,
    registry,
    principal: boundPrincipal,
    agentId: resolvedAgentId
  };
}
