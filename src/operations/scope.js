/**
 * Operation scope: the audit identity attached to one operation (`{principalId, canvasId}`).
 *
 * Scopes are opaque capability objects: only scopes created by `createOperationScope` are
 * trusted by the operation runtime (tracked in a WeakSet). This prevents callers from
 * forging a scope to change the principal attribution of a receipt.
 */
import { ERROR_CODES, canvasError } from '../errors.js';
import { assertCanvasId } from '../canvas/capabilities.js';

const TRUSTED_SCOPES = new WeakSet();

/**
 * Create a frozen, trusted operation scope.
 *
 * @param {object} input
 * @param {string} input.principalId authenticated principal id
 * @param {string} input.canvasId target canvas id
 * @returns {{principalId: string, canvasId: string}}
 */
export function createOperationScope({ principalId, canvasId } = {}) {
  if (typeof principalId !== 'string' || principalId.length === 0) {
    throw canvasError(ERROR_CODES.OPERATION_REQUEST_INVALID, 'operation scope requires a principalId');
  }
  let validCanvasId;
  try {
    validCanvasId = assertCanvasId(canvasId);
  } catch {
    throw canvasError(ERROR_CODES.OPERATION_REQUEST_INVALID, 'operation scope requires a valid canvasId');
  }
  const scope = Object.freeze({ principalId, canvasId: validCanvasId });
  TRUSTED_SCOPES.add(scope);
  return scope;
}

/**
 * Assert that a scope was created by `createOperationScope`.
 *
 * @param {unknown} scope
 * @returns {true}
 * @throws {CanvasMcpError} `CANVAS_AUTH_DENIED` for forged or malformed scopes
 */
export function assertTrustedScope(scope) {
  if (scope === null || typeof scope !== 'object' || !TRUSTED_SCOPES.has(scope)) {
    throw canvasError(ERROR_CODES.AUTH_DENIED, 'operation scope is not trusted');
  }
  return true;
}

/** Return `true` when the scope is trusted (non-throwing variant). */
export function isTrustedScope(scope) {
  return scope !== null && typeof scope === 'object' && TRUSTED_SCOPES.has(scope);
}
