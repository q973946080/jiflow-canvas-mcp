/**
 * Canvas domain service: read/list projections over the store plus the write entry point
 * that delegates to the operation runtime.
 *
 * Authorisation for writes is enforced twice by design: once here and once inside the
 * operation runtime (defense in depth, see the documented contract).
 */
import { ERROR_CODES, canvasError } from '../errors.js';
import {
  assertNodeId,
  assertOperationId
} from '../canvas/capabilities.js';
import { assertTrustedScope } from '../operations/scope.js';
import { OperationRegistry, createOperationExecutor } from '../operations/runtime.js';

/** Public projection of a stored receipt: no tokens, no raw args, no duration. */
export function projectReceipt(receipt) {
  return {
    operationId: receipt.operationId,
    kind: receipt.kind,
    payloadHash: receipt.payloadHash,
    scopeHash: receipt.scopeHash,
    expectedRevision: receipt.expectedRevision,
    resultingRevision: receipt.resultingRevision,
    actionKinds: Array.isArray(receipt.actionKinds) ? [...receipt.actionKinds] : [],
    principalId: receipt.principalId,
    agentId: receipt.agentId,
    committedAt: receipt.committedAt,
    result: receipt.result !== null && typeof receipt.result === 'object' ? { ...receipt.result } : receipt.result
  };
}

function summariseCanvas(state) {
  return {
    canvasId: state.canvas.canvasId,
    name: state.canvas.name,
    revision: state.revision,
    nodeCount: state.data.nodes.length,
    edgeCount: state.data.edges.length,
    updatedAt: state.updatedAt
  };
}

/**
 * Create the canvas domain.
 *
 * @param {object} options
 * @param {object} options.store store created by `createFileCanvasStore`
 * @param {(input: object) => boolean} options.authorize authorizer bound to a principal
 * @param {object} [options.executor] optional pre-built operation executor
 * @param {object} [options.principal] authenticated principal
 * @param {string} [options.agentId] recorded agent id
 * @param {OperationRegistry} [options.registry] action handler registry
 */
export function createCanvasDomain({
  store,
  authorize,
  executor,
  principal,
  agentId,
  registry = new OperationRegistry()
} = {}) {
  if (!store || typeof store.readCanvas !== 'function' || typeof store.listCanvases !== 'function') {
    throw new TypeError('createCanvasDomain requires a canvas store');
  }
  if (typeof authorize !== 'function') {
    throw new TypeError('createCanvasDomain requires an authorize function');
  }
  const operationExecutor =
    executor ?? createOperationExecutor({ store, registry, authorize, principal, agentId });

  /**
   * List readable canvases restricted to the principal's configured canvas scope.
   * @param {object} principalLike `{canvasIds: string[]}`
   */
  function listCanvases(principalLike) {
    const canvasIds = principalLike?.canvasIds;
    if (!Array.isArray(canvasIds) || canvasIds.length === 0) {
      return [];
    }
    const wildcard = canvasIds.includes('*');
    return store
      .listCanvases()
      .filter((state) => wildcard || canvasIds.includes(state.canvas.canvasId))
      .map(summariseCanvas)
      .sort((left, right) => (left.canvasId < right.canvasId ? -1 : left.canvasId > right.canvasId ? 1 : 0));
  }

  function readCanvas(canvasId) {
    const state = store.readCanvas(canvasId);
    return {
      canvasId: state.canvas.canvasId,
      name: state.canvas.name,
      revision: state.revision,
      updatedAt: state.updatedAt,
      nodes: structuredClone(state.data.nodes),
      edges: structuredClone(state.data.edges)
    };
  }

  function readNode(canvasId, nodeId) {
    assertNodeId(nodeId);
    const state = store.readCanvas(canvasId);
    const node = state.data.nodes.find((candidate) => candidate.id === nodeId);
    if (!node) {
      throw canvasError(ERROR_CODES.NODE_NOT_FOUND, `node "${nodeId}" was not found`, {
        canvasId,
        nodeId
      });
    }
    return { canvasId, revision: state.revision, node: structuredClone(node) };
  }

  function readReceipt(canvasId, operationId) {
    assertOperationId(operationId);
    const state = store.readCanvas(canvasId);
    const receipt = state.receipts[operationId];
    if (!receipt) {
      throw canvasError(
        ERROR_CODES.RECEIPT_NOT_FOUND,
        `receipt "${operationId}" was not found`,
        { canvasId, operationId }
      );
    }
    return { canvasId, receipt: projectReceipt(receipt) };
  }

  function listReceipts(canvasId, limit = 20) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw canvasError(ERROR_CODES.ARGUMENTS_INVALID, 'limit must be an integer between 1 and 100');
    }
    const state = store.readCanvas(canvasId);
    const receipts = Object.values(state.receipts).map(projectReceipt);
    receipts.sort((left, right) => {
      if (left.committedAt !== right.committedAt) {
        return left.committedAt < right.committedAt ? 1 : -1;
      }
      return left.operationId < right.operationId ? -1 : left.operationId > right.operationId ? 1 : 0;
    });
    return { canvasId, receipts: receipts.slice(0, limit) };
  }

  /**
   * Execute one write operation for a trusted scope.
   *
   * @param {{principalId: string, canvasId: string}} scope trusted operation scope
   * @param {object} request operation envelope
   */
  function execute(scope, request) {
    assertTrustedScope(scope);
    const requestCanvasId = request?.payload?.canvasId;
    if (requestCanvasId !== scope.canvasId) {
      throw canvasError(ERROR_CODES.AUTH_DENIED, 'operation scope does not match request canvas');
    }
    const authorized = authorize({
      principal,
      canvasId: requestCanvasId,
      requiredPermission: 'canvas:write'
    });
    if (authorized !== true) {
      throw canvasError(ERROR_CODES.AUTH_DENIED, 'principal is not allowed to write this canvas');
    }
    return operationExecutor.execute(scope, request);
  }

  return Object.freeze({
    listCanvases,
    readCanvas,
    readNode,
    readReceipt,
    listReceipts,
    execute,
    executor: operationExecutor
  });
}
