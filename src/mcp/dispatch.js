/**
 * Tool call dispatcher.
 *
 * Pipeline order (fixed by the spec, do not reorder):
 *   1. tool whitelist
 *   2. identity validation of identifier arguments
 *   3. JSON-Schema argument validation & narrowing
 *   4. principal authorisation (allowed tool + mode + canvas scope)
 *   5. domain operation (CAS / receipts)
 *   6. success metadata merge, or a stable machine-readable error
 */
import { randomUUID } from 'node:crypto';
import { CanvasMcpError, ERROR_CODES, canvasError } from '../errors.js';
import { hashCanonicalJson } from '../canonical-json.js';
import {
  ACTION_KINDS,
  markInternalAction,
  prepareCreateNodeData
} from '../canvas/capabilities.js';
import { createOperationScope } from '../operations/scope.js';
import { getToolByName, isWhitelistedTool } from './whitelist.js';
import { validateArguments } from './validate.js';
import { assertArgumentIdentities } from './identity.js';

export const SERVER_NAME = 'jiflow-canvas-mcp';

const AUTH_DENIAL_CODES = new Set([
  ERROR_CODES.AUTH_DENIED,
  ERROR_CODES.AUTH_REQUIRED,
  ERROR_CODES.READ_ONLY,
  ERROR_CODES.TOOL_DENIED,
  ERROR_CODES.CANVAS_SCOPE_MISMATCH
]);

const CONFLICT_CODES = new Set([
  ERROR_CODES.REVISION_CONFLICT,
  ERROR_CODES.STORE_BUSY,
  ERROR_CODES.OPERATION_SCOPE_CONFLICT,
  ERROR_CODES.OPERATION_KIND_CONFLICT,
  ERROR_CODES.OPERATION_PAYLOAD_CONFLICT
]);

function safeArgsDigest(args) {
  try {
    return hashCanonicalJson(args ?? {});
  } catch {
    return null;
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function principalAllowsTool(principal, toolName) {
  if (!principal || typeof principal !== 'object') {
    return false;
  }
  if (principal.allowedTools === null || principal.allowedTools === undefined) {
    return true;
  }
  return Array.isArray(principal.allowedTools) && principal.allowedTools.includes(toolName);
}

function principalCanAccessCanvas(principal, canvasId) {
  if (!principal || !Array.isArray(principal.canvasIds)) {
    return false;
  }
  return principal.canvasIds.includes('*') || principal.canvasIds.includes(canvasId);
}

/**
 * Map a JSON-Schema validation failure to the most precise stable domain code.
 * Path-sensitive mapping keeps the documented contract node data error codes reachable over MCP while the
 * structural schema remains strict (`additionalProperties:false` everywhere).
 */
function mapSchemaError(errors, args) {
  const first = errors[0] ?? { path: '$', keyword: 'unknown', message: 'invalid arguments' };
  const path = typeof first.path === 'string' ? first.path : '$';
  const detail = { path, message: String(first.message ?? 'invalid arguments') };
  if (path.includes('data')) {
    const code =
      first.keyword === 'additionalProperties'
        ? ERROR_CODES.NODE_FIELD_UNKNOWN
        : ERROR_CODES.NODE_FIELD_INVALID;
    return canvasError(code, `invalid node data: ${first.message}`, detail);
  }
  if (path.includes('position')) {
    return canvasError(ERROR_CODES.POSITION_INVALID, 'invalid node position', detail);
  }
  if (path.includes('actions')) {
    const kindsInvalid =
      Array.isArray(args?.actions) &&
      args.actions.some(
        (action) =>
          !isPlainObject(action) ||
          typeof action.kind !== 'string' ||
          !ACTION_KINDS.includes(action.kind)
      );
    return canvasError(
      kindsInvalid ? ERROR_CODES.ACTION_NOT_WHITELISTED : ERROR_CODES.ACTION_INVALID,
      kindsInvalid ? 'action kind is not whitelisted' : 'invalid action',
      detail
    );
  }
  return canvasError(ERROR_CODES.ARGUMENTS_INVALID, 'invalid tool arguments', detail);
}

/**
 * Create the tool dispatcher for one authenticated principal.
 *
 * @param {object} options
 * @param {object} options.domain canvas domain created by `createCanvasDomain`
 * @param {(input: object) => boolean} options.authorize authorizer bound to the principal
 * @param {Function} [options.logger] audit logger from `createAuditLogger`
 * @param {object} [options.principal] authenticated principal
 * @param {string} [options.agentId] recorded agent id (defaults to the principal id)
 */
export function createDispatcher({ domain, authorize, logger, principal, agentId } = {}) {
  if (!domain || typeof domain.execute !== 'function' || typeof domain.readCanvas !== 'function') {
    throw new TypeError('createDispatcher requires a canvas domain');
  }
  if (typeof authorize !== 'function') {
    throw new TypeError('createDispatcher requires an authorize function');
  }
  const log = typeof logger === 'function' ? logger : () => {};
  const resolvedAgentId =
    typeof agentId === 'string' && agentId.length > 0
      ? agentId
      : typeof principal?.principalId === 'string'
        ? principal.principalId
        : undefined;

  function readOperations(toolDef, args) {
    const metadata = {
      ok: true,
      tool: toolDef.name,
      permission: 'READ',
      server: SERVER_NAME,
      principalId: principal?.principalId,
      agentId: resolvedAgentId
    };
    switch (toolDef.name) {
      case 'canvas_list_canvases':
        return { ...metadata, canvases: domain.listCanvases(principal) };
      case 'canvas_read_canvas':
        return { ...metadata, ...domain.readCanvas(args.canvasId) };
      case 'canvas_read_node':
        return { ...metadata, ...domain.readNode(args.canvasId, args.nodeId) };
      case 'canvas_read_receipt':
        return { ...metadata, ...domain.readReceipt(args.canvasId, args.operationId) };
      case 'canvas_list_receipts':
        return {
          ...metadata,
          ...domain.listReceipts(args.canvasId, args.limit === undefined ? 20 : args.limit)
        };
      default:
        throw canvasError(ERROR_CODES.TOOL_NOT_WHITELISTED, 'tool is not whitelisted');
    }
  }

  function buildCreateNodeAction(args) {
    const kind = args.kind;
    const nodeId = args.nodeId ?? `node-${randomUUID()}`;
    // Validate caller data before injecting the protected nodeType invariant.
    const preparedData = prepareCreateNodeData(args.data, kind);
    const action = {
      kind: 'node.create',
      node: {
        id: nodeId,
        type: kind,
        position: args.position === undefined ? { x: 0, y: 0 } : args.position,
        data: { ...preparedData, label: args.label }
      }
    };
    return markInternalAction(action);
  }

  function buildPatchNodeAction(args) {
    const patch = {};
    if (args.data !== undefined) {
      patch.data = args.data;
    }
    if (args.position !== undefined) {
      patch.position = args.position;
    }
    return { kind: 'node.patch', nodeId: args.nodeId, patch };
  }

  function buildConnectAction(args) {
    return {
      kind: 'edge.connect',
      edge: {
        id: args.edgeId ?? `edge-${randomUUID()}`,
        source: args.source,
        target: args.target,
        relation: args.relation ?? 'reference'
      }
    };
  }

  function buildWriteActions(toolDef, args) {
    switch (toolDef.name) {
      case 'canvas_create_node':
        return [buildCreateNodeAction(args)];
      case 'canvas_patch_node':
        return [buildPatchNodeAction(args)];
      case 'canvas_connect_nodes':
        return [buildConnectAction(args)];
      case 'canvas_commit_batch':
        return args.actions;
      default:
        throw canvasError(ERROR_CODES.TOOL_NOT_WHITELISTED, 'tool is not whitelisted');
    }
  }

  function writeOperation(toolDef, args) {
    const canvasId = args.canvasId;
    const actions = buildWriteActions(toolDef, args);
    const operationId = args.operationId ?? `op-${randomUUID()}`;

    let expectedRevision = args.expectedRevision;
    let revisionSource = 'provided';
    if (expectedRevision === undefined) {
      revisionSource = 'read';
      try {
        expectedRevision = domain.readCanvas(canvasId).revision;
      } catch {
        throw canvasError(
          ERROR_CODES.REVISION_REQUIRED,
          'expectedRevision is required because the current revision could not be read'
        );
      }
    }

    const scope = createOperationScope({
      principalId: principal.principalId,
      canvasId
    });
    const envelope = {
      operationId,
      kind: 'canvas.batch',
      payload: { canvasId, expectedRevision, actions }
    };
    const outcome = domain.execute(scope, envelope);
    const metadata = {
      ok: true,
      tool: toolDef.name,
      permission: 'WRITE',
      server: SERVER_NAME,
      principalId: principal.principalId,
      agentId: resolvedAgentId
    };
    const result = {
      ...metadata,
      operationId: outcome.operationId,
      kind: outcome.kind,
      replayed: outcome.replayed,
      payloadHash: outcome.payloadHash,
      revision: outcome.revision,
      result: outcome.result,
      source: revisionSource
    };
    if (toolDef.name === 'canvas_commit_batch') {
      result.actionKinds = actions.map((action) => action.kind);
    } else {
      result.actionKind = actions[0].kind;
      if (actions[0].kind === 'node.create' || actions[0].kind === 'node.patch') {
        result.nodeId = actions[0].kind === 'node.create' ? actions[0].node.id : actions[0].nodeId;
      } else {
        result.edgeId = actions[0].edge.id;
      }
    }
    return result;
  }

  /**
   * Dispatch one tool call.
   *
   * @param {unknown} toolName raw MCP tool name
   * @param {unknown} rawArgs raw MCP tool arguments
   * @returns {object} success payload (errors are thrown as `CanvasMcpError`)
   */
  function dispatch(toolName) {
    const startedAt = Date.now();
    const argsDigest = safeArgsDigest(arguments[1]);
    let tool = typeof toolName === 'string' ? toolName : null;
    try {
      // 1. whitelist
      if (!isWhitelistedTool(toolName)) {
        throw canvasError(
          typeof toolName === 'string'
            ? ERROR_CODES.TOOL_NOT_WHITELISTED
            : ERROR_CODES.TOOL_UNKNOWN,
          typeof toolName === 'string' ? 'tool is not whitelisted' : 'tool name is missing or invalid'
        );
      }
      const toolDef = getToolByName(toolName);
      tool = toolDef.name;
      const rawArgs = arguments[1] === undefined || arguments[1] === null ? {} : arguments[1];
      if (!isPlainObject(rawArgs)) {
        throw canvasError(ERROR_CODES.ARGUMENTS_INVALID, 'tool arguments must be an object');
      }

      // 2. identity validation
      assertArgumentIdentities(rawArgs);

      // 3. argument schema validation & narrowing
      const validation = validateArguments(toolDef.inputSchema, rawArgs);
      if (!validation.ok) {
        throw mapSchemaError(validation.errors, rawArgs);
      }
      const args = validation.value;
      if (toolDef.name === 'canvas_patch_node' && args.data === undefined && args.position === undefined) {
        throw canvasError(
          ERROR_CODES.ARGUMENTS_INVALID,
          'canvas_patch_node requires at least one of data or position'
        );
      }
      if (toolDef.name === 'canvas_list_receipts' && args.limit !== undefined) {
        if (!Number.isSafeInteger(args.limit) || args.limit < 1 || args.limit > 100) {
          throw canvasError(ERROR_CODES.ARGUMENTS_INVALID, 'limit must be an integer between 1 and 100');
        }
      }
      if (toolDef.name === 'canvas_commit_batch') {
        if (!Array.isArray(args.actions) || args.actions.length < 1 || args.actions.length > 100) {
          throw canvasError(ERROR_CODES.ARGUMENTS_INVALID, 'actions must contain between 1 and 100 entries');
        }
      }

      // 4. principal authorisation
      if (!principal || typeof principal !== 'object') {
        throw canvasError(ERROR_CODES.AUTH_DENIED, 'authenticated principal is required');
      }
      if (!principalAllowsTool(principal, toolDef.name)) {
        throw canvasError(ERROR_CODES.TOOL_DENIED, 'tool is not allowed for this principal');
      }
      const isWrite = toolDef.permission === 'WRITE';
      if (isWrite && principal.mode !== 'CANVAS_WRITE') {
        throw canvasError(ERROR_CODES.READ_ONLY, 'principal has read-only access');
      }
      if (args.canvasId !== undefined && !principalCanAccessCanvas(principal, args.canvasId)) {
        throw canvasError(ERROR_CODES.CANVAS_SCOPE_MISMATCH, 'canvas is outside the principal scope', {
          canvasId: args.canvasId
        });
      }
      const authorized = authorize({
        principal,
        toolName: toolDef.name,
        canvasId: args.canvasId,
        requiredPermission: isWrite ? 'canvas:write' : 'canvas:read'
      });
      if (authorized !== true) {
        throw canvasError(ERROR_CODES.AUTH_DENIED, 'operation is not allowed for this principal');
      }

      // 5. domain operation
      const result = isWrite ? writeOperation(toolDef, args) : readOperations(toolDef, args);

      // 6. audit success
      log({
        event: 'tool_call',
        tool: toolDef.name,
        ok: true,
        principalId: principal.principalId,
        agentId: resolvedAgentId,
        ms: Date.now() - startedAt,
        argsDigest,
        operationId: result.operationId,
        revision: result.revision
      });
      return result;
    } catch (error) {
      const mcpError =
        error instanceof CanvasMcpError
          ? error
          : canvasError(ERROR_CODES.INTERNAL_ERROR, 'internal error');
      const base = {
        tool,
        ok: false,
        code: mcpError.code,
        principalId: principal?.principalId,
        agentId: resolvedAgentId,
        ms: Date.now() - startedAt,
        argsDigest
      };
      log({ event: 'tool_error', ...base });
      if (AUTH_DENIAL_CODES.has(mcpError.code)) {
        log({ event: 'auth_denied', ...base });
      }
      if (CONFLICT_CODES.has(mcpError.code)) {
        log({ event: 'store_conflict', ...base });
      }
      throw mcpError;
    }
  }

  return Object.freeze({
    dispatch,
    /** MCP-shaped entry point: `call({name, arguments})`. */
    call(params) {
      if (params === undefined || params === null) {
        return dispatch(undefined, {});
      }
      if (!isPlainObject(params)) {
        throw canvasError(ERROR_CODES.ARGUMENTS_INVALID, 'invalid tool call parameters');
      }
      return dispatch(params.name, params.arguments);
    },
    serverName: SERVER_NAME,
    principal,
    agentId: resolvedAgentId
  });
}
