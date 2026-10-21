/**
 * Stable, machine-readable error codes and the error type used across the server.
 *
 * Every failure that can reach an MCP client or a library caller is represented as a
 * `CanvasMcpError` whose `code` is one of the frozen values in `ERROR_CODES`.
 */

/** The single frozen registry of public error codes. Keys are short names, values are wire codes. */
export const ERROR_CODES = Object.freeze({
  TOOL_NOT_WHITELISTED: 'CANVAS_TOOL_NOT_WHITELISTED',
  TOOL_DENIED: 'CANVAS_TOOL_DENIED',
  TOOL_UNKNOWN: 'CANVAS_TOOL_UNKNOWN',
  ARGUMENTS_INVALID: 'CANVAS_ARGUMENTS_INVALID',
  AUTH_REQUIRED: 'CANVAS_AUTH_REQUIRED',
  AUTH_CONFIG_INVALID: 'CANVAS_AUTH_CONFIG_INVALID',
  PRINCIPAL_UNKNOWN: 'CANVAS_PRINCIPAL_UNKNOWN',
  READ_ONLY: 'CANVAS_READ_ONLY',
  AUTH_DENIED: 'CANVAS_AUTH_DENIED',
  CANVAS_SCOPE_MISMATCH: 'CANVAS_CANVAS_SCOPE_MISMATCH',
  CANVAS_ID_INVALID: 'CANVAS_CANVAS_ID_INVALID',
  CANVAS_NOT_FOUND: 'CANVAS_CANVAS_NOT_FOUND',
  NODE_ID_INVALID: 'CANVAS_NODE_ID_INVALID',
  NODE_ID_CONFLICT: 'CANVAS_NODE_ID_CONFLICT',
  NODE_NOT_FOUND: 'CANVAS_NODE_NOT_FOUND',
  NODE_FIELD_PROTECTED: 'CANVAS_NODE_FIELD_PROTECTED',
  NODE_FIELD_UNKNOWN: 'CANVAS_NODE_FIELD_UNKNOWN',
  NODE_FIELD_INVALID: 'CANVAS_NODE_FIELD_INVALID',
  POSITION_INVALID: 'CANVAS_POSITION_INVALID',
  EDGE_ID_INVALID: 'CANVAS_EDGE_ID_INVALID',
  EDGE_ID_CONFLICT: 'CANVAS_EDGE_ID_CONFLICT',
  EDGE_NOT_FOUND: 'CANVAS_EDGE_NOT_FOUND',
  EDGE_RELATION_INVALID: 'CANVAS_EDGE_RELATION_INVALID',
  ACTION_NOT_WHITELISTED: 'CANVAS_ACTION_NOT_WHITELISTED',
  ACTION_INVALID: 'CANVAS_ACTION_INVALID',
  REVISION_REQUIRED: 'CANVAS_REVISION_REQUIRED',
  REVISION_CONFLICT: 'CANVAS_REVISION_CONFLICT',
  REVISION_EXHAUSTED: 'CANVAS_REVISION_EXHAUSTED',
  OPERATION_ID_INVALID: 'CANVAS_OPERATION_ID_INVALID',
  OPERATION_REQUEST_INVALID: 'CANVAS_OPERATION_REQUEST_INVALID',
  OPERATION_SCOPE_CONFLICT: 'CANVAS_OPERATION_SCOPE_CONFLICT',
  OPERATION_KIND_CONFLICT: 'CANVAS_OPERATION_KIND_CONFLICT',
  OPERATION_PAYLOAD_CONFLICT: 'CANVAS_OPERATION_PAYLOAD_CONFLICT',
  RECEIPT_NOT_FOUND: 'CANVAS_RECEIPT_NOT_FOUND',
  LOCK_OWNERSHIP_LOST: 'CANVAS_LOCK_OWNERSHIP_LOST',
  LOCK_UNVERIFIABLE: 'CANVAS_LOCK_UNVERIFIABLE',
  STORE_UNAVAILABLE: 'CANVAS_STORE_UNAVAILABLE',
  STORE_BUSY: 'CANVAS_STORE_BUSY',
  STORE_CORRUPT: 'CANVAS_STORE_CORRUPT',
  INTERNAL_ERROR: 'CANVAS_INTERNAL_ERROR'
});

/** Set of every known wire code, useful for validating foreign errors. */
export const ERROR_CODE_SET = Object.freeze(new Set(Object.values(ERROR_CODES)));

/**
 * Error type carrying a stable machine-readable `code` and an optional structured `detail`.
 * `detail` must never contain secrets or raw caller payloads beyond ids/revisions.
 */
export class CanvasMcpError extends Error {
  /**
   * @param {string} code one of `ERROR_CODES`
   * @param {string} message human readable, safe to return to clients
   * @param {object} [detail] optional non-secret structured context
   */
  constructor(code, message, detail) {
    super(typeof message === 'string' && message.length > 0 ? message : code);
    this.name = 'CanvasMcpError';
    this.code = typeof code === 'string' && code.length > 0 ? code : ERROR_CODES.INTERNAL_ERROR;
    if (detail !== undefined) {
      this.detail = detail;
    }
    Error.captureStackTrace?.(this, CanvasMcpError);
  }

  /** Public wire representation: `{ok:false, code, error, detail?}`. */
  toPayload() {
    const payload = { ok: false, code: this.code, error: this.message };
    if (this.detail !== undefined) {
      payload.detail = this.detail;
    }
    return payload;
  }
}

/** Return `true` when `value` is a `CanvasMcpError`. */
export function isCanvasMcpError(value) {
  return value instanceof CanvasMcpError;
}

/** Build a `CanvasMcpError` from the frozen code registry. */
export function canvasError(code, message, detail) {
  return new CanvasMcpError(code, message, detail);
}

/**
 * Convert any thrown value into a `CanvasMcpError` without leaking internal details.
 * Unknown exceptions become `CANVAS_INTERNAL_ERROR`.
 */
export function asCanvasMcpError(value) {
  if (value instanceof CanvasMcpError) {
    return value;
  }
  return new CanvasMcpError(ERROR_CODES.INTERNAL_ERROR, 'internal error');
}
