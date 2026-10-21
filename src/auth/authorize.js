/**
 * Principal authorisation.
 *
 * `createAuthorizer` binds an immutable principal to a single `authorize(input)`
 * predicate. The predicate returns exactly `true` or `false` (never a truthy object),
 * and fails closed on unknown permissions or malformed input.
 */
import { isWhitelistedTool } from '../mcp/whitelist.js';

function normalisePermission(permission) {
  if (permission === 'canvas:write' || permission === 'write' || permission === 'WRITE') {
    return 'write';
  }
  if (permission === 'canvas:read' || permission === 'read' || permission === 'READ') {
    return 'read';
  }
  return null;
}

function toolAllowed(principal, toolName) {
  if (principal.allowedTools === null || principal.allowedTools === undefined) {
    return true;
  }
  return principal.allowedTools.includes(toolName);
}

function canvasInScope(principal, canvasId) {
  return principal.canvasIds.includes('*') || principal.canvasIds.includes(canvasId);
}

/**
 * Create the authorisation predicate for one principal.
 *
 * @param {object} options
 * @param {object} options.principal principal record from the validated auth config
 * @returns {((input: object) => boolean) & object} predicate with inspection helpers
 */
export function createAuthorizer({ principal } = {}) {
  if (principal === null || typeof principal !== 'object') {
    throw new TypeError('createAuthorizer requires a principal');
  }
  if (typeof principal.mode !== 'string' || !Array.isArray(principal.canvasIds) || typeof principal.principalId !== 'string') {
    throw new TypeError('principal is missing required fields');
  }

  const authorizer = (input) => {
    if (input === null || typeof input !== 'object') {
      return false;
    }
    const permission = normalisePermission(input.requiredPermission ?? input.permission);
    if (permission === null) {
      return false;
    }
    const canvasId = input.canvasId;
    const toolName = input.toolName ?? input.tool ?? input.name;
    if (toolName !== undefined) {
      if (typeof toolName !== 'string' || !isWhitelistedTool(toolName)) {
        return false;
      }
      if (!toolAllowed(principal, toolName)) {
        return false;
      }
    }
    if (permission === 'write') {
      if (principal.mode !== 'CANVAS_WRITE') {
        return false;
      }
      if (typeof canvasId !== 'string' || !canvasInScope(principal, canvasId)) {
        return false;
      }
      return true;
    }
    if (canvasId !== undefined) {
      if (typeof canvasId !== 'string' || !canvasInScope(principal, canvasId)) {
        return false;
      }
    }
    return true;
  };

  Object.defineProperties(authorizer, {
    principal: { value: principal, enumerable: false },
    principalId: { value: principal.principalId, enumerable: false },
    mode: { value: principal.mode, enumerable: false },
    isToolAllowed: {
      value: (toolName) =>
        typeof toolName === 'string' && isWhitelistedTool(toolName) && toolAllowed(principal, toolName),
      enumerable: false
    },
    isCanvasInScope: {
      value: (canvasId) => typeof canvasId === 'string' && canvasInScope(principal, canvasId),
      enumerable: false
    },
    isReadOnly: { value: principal.mode !== 'CANVAS_WRITE', enumerable: false }
  });

  return authorizer;
}
