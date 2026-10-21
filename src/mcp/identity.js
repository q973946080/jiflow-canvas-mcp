/**
 * Identity asserters.
 *
 * These run in the dispatcher *before* JSON-Schema validation, so path-traversal attempts
 * and malformed identifiers are rejected with precise `CANVAS_*_ID_INVALID` codes rather
 * than a generic argument error.
 */
import {
  assertAgentId,
  assertCanvasId,
  assertEdgeId,
  assertNodeId,
  assertOperationId,
  assertPrincipalId,
  isPlainObject
} from '../canvas/capabilities.js';

export { assertAgentId, assertCanvasId, assertEdgeId, assertNodeId, assertOperationId, assertPrincipalId };

function assertStringIdentity(value, assertFn) {
  if (typeof value === 'string') {
    assertFn(value);
  }
}

/**
 * Validate the identity-bearing arguments of one tool call, in a fixed order
 * (canvasId first, as required by the spec). Non-string values are left for the JSON-Schema
 * validator so they produce `CANVAS_ARGUMENTS_INVALID`.
 *
 * @param {unknown} args tool arguments
 */
export function assertArgumentIdentities(args) {
  if (!isPlainObject(args)) {
    return;
  }
  assertStringIdentity(args.canvasId, assertCanvasId);
  assertStringIdentity(args.nodeId, assertNodeId);
  assertStringIdentity(args.edgeId, assertEdgeId);
  assertStringIdentity(args.operationId, assertOperationId);
  assertStringIdentity(args.source, assertNodeId);
  assertStringIdentity(args.target, assertNodeId);
}
