/**
 * Structured audit logger writing one JSON object per line to stderr.
 *
 * The logger is intentionally allow-list based: only the documented audit fields are
 * emitted, so tokens, raw tool arguments or file contents can never leak by accident.
 * Callers pass an `argsDigest` (hash of canonical args) instead of the arguments.
 */

/** Fields allowed in an audit record (everything else is dropped). */
const ALLOWED_FIELDS = new Set([
  'ts',
  'event',
  'principalId',
  'agentId',
  'tool',
  'ok',
  'code',
  'ms',
  'argsDigest',
  'operationId',
  'revision',
  'store',
  'tools',
  'version'
]);

/** Events understood by the logging schema. */
export const AUDIT_EVENTS = Object.freeze([
  'server_start',
  'server_error',
  'tool_call',
  'tool_error',
  'store_conflict',
  'auth_denied'
]);

const defaultSink = (line) => {
  process.stderr.write(line);
};

/**
 * Create an audit logger.
 *
 * @param {object} [options]
 * @param {(line: string) => void} [options.sink] receives a single serialised line ending in `\n`
 * @param {() => Date} [options.now] injectable clock (tests)
 * @returns {((fields: object) => void) & {log: (fields: object) => void}}
 *   a callable logger; the same function is also exposed under `.log`
 */
export function createAuditLogger({ sink, now } = {}) {
  const writeLine = typeof sink === 'function' ? sink : defaultSink;
  const clock = typeof now === 'function' ? now : () => new Date();

  const log = (fields) => {
    const record = { ts: clock().toISOString() };
    if (fields !== null && typeof fields === 'object') {
      for (const key of Object.keys(fields)) {
        if (!ALLOWED_FIELDS.has(key)) {
          continue;
        }
        const value = fields[key];
        if (value === undefined) {
          continue;
        }
        record[key] = value;
      }
    }
    let line;
    try {
      line = `${JSON.stringify(record)}\n`;
    } catch {
      line = `${JSON.stringify({ ts: record.ts, event: 'server_error', ok: false })}\n`;
    }
    try {
      writeLine(line);
    } catch {
      // Logging must never take the server down.
    }
  };

  return Object.assign(log, { log });
}
