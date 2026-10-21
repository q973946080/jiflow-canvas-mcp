/**
 * Public library surface for jiflow-canvas-mcp.
 *
 * The package is zero-runtime-dependency ESM: every module imports only Node built-ins.
 * Consumers can embed the store/domain/MCP server or drive the operation runtime directly.
 */
export { CanvasMcpError, ERROR_CODES, isCanvasMcpError, canvasError, asCanvasMcpError } from './errors.js';
export { canonicalJson, hashCanonicalJson } from './canonical-json.js';
export { createAuditLogger, AUDIT_EVENTS } from './logger.js';

export {
  AUTH_MODES,
  loadAuthConfig,
  matchPrincipal,
  tokenSha256,
  validateAuthConfig
} from './auth/config.js';
export { createAuthorizer } from './auth/authorize.js';

export {
  DEFAULT_LOCK_TIMEOUT_MS,
  DEFAULT_STALE_LOCK_MS,
  canvasLockPath,
  canvasFencePath,
  acquireCanvasLock,
  releaseCanvasLock,
  verifyCanvasLock,
  inspectCanvasLock
} from './store/lock.js';
export { createFileCanvasStore, validateCanvasState, STORE_VERSION } from './store/store.js';

export {
  AGENT_ID_PATTERN,
  ACTION_KINDS,
  CANVAS_ID_PATTERN,
  CANVAS_NODE_KINDS,
  EDGE_ID_PATTERN,
  EDGE_RELATIONS,
  MUTABLE_NODE_DATA_FIELDS,
  NODE_CAPABILITIES,
  NODE_ID_PATTERN,
  NODE_STATUSES,
  OPERATION_ID_PATTERN,
  PRINCIPAL_ID_PATTERN,
  PROTECTED_NODE_DATA_FIELDS,
  assertAgentId,
  assertCanvasId,
  assertEdgeId,
  assertEdgeRelation,
  assertNodeId,
  assertNodeKind,
  assertOperationId,
  assertPrincipalId,
  isPlainObject,
  prepareCreateNodeData,
  validateAction,
  validateActions,
  validateMutableNodeData,
  validatePosition,
  validatePreparedNodeData
} from './canvas/capabilities.js';
export { createCanvasDomain, projectReceipt } from './canvas/domain.js';

export { createOperationScope, assertTrustedScope as assertOperationScopeTrusted, isTrustedScope } from './operations/scope.js';
export {
  OperationRegistry,
  DEFAULT_ACTION_HANDLERS,
  createOperationExecutor
} from './operations/runtime.js';

export {
  TOOL_WHITELIST,
  TOOL_NAMES,
  TOOL_PERMISSIONS,
  WHITELISTED_TOOL_NAMES,
  getTool,
  getToolByName,
  isWhitelistedTool,
  listToolDefinitions,
  lookupTool
} from './mcp/whitelist.js';
export {
  assertAgentId as assertIdentityAgentId,
  assertArgumentIdentities,
  assertCanvasId as assertIdentityCanvasId,
  assertEdgeId as assertIdentityEdgeId,
  assertNodeId as assertIdentityNodeId,
  assertOperationId as assertIdentityOperationId
} from './mcp/identity.js';
export { assertSchemaSubset, validateArguments } from './mcp/validate.js';
export { createDispatcher, SERVER_NAME as DISPATCHER_SERVER_NAME } from './mcp/dispatch.js';
export {
  DEFAULT_PROTOCOL_VERSION,
  PROTOCOL_VERSIONS,
  SERVER_NAME,
  SERVER_VERSION,
  createMcpServer,
  main as runMcpMain,
  negotiateProtocolVersion,
  runStdioServer
} from './mcp/server.mjs';
export { parseServerConfig, exitCodeForError, USAGE } from './server/config.js';
export { startServer, runMain } from './server/main.mjs';
