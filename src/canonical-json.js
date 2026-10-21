/**
 * Deterministic JSON canonicalisation used for operation payload/scope hashes.
 *
 * Rules:
 * - object keys are sorted by UTF-16 code unit order (JavaScript default string order);
 * - properties whose value is `undefined` are omitted;
 * - array element order is preserved;
 * - non-finite numbers are rejected;
 * - `-0` is normalised to `0`;
 * - cycles and non-JSON values (functions, symbols, bigints, class instances) are rejected.
 */
import { createHash } from 'node:crypto';

/**
 * Serialise `value` into a canonical JSON string.
 *
 * @param {unknown} value JSON-compatible value (plain objects, arrays, primitives)
 * @returns {string} canonical JSON text
 * @throws {TypeError} when the value cannot be represented deterministically
 */
export function canonicalJson(value) {
  const seen = new Set();
  return serialise(value, seen, '$');
}

/**
 * Hash the canonical JSON representation of `value` with SHA-256 (lowercase hex).
 *
 * @param {unknown} value JSON-compatible value
 * @returns {string} 64 character lowercase hex digest
 */
export function hashCanonicalJson(value) {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function serialise(value, seen, path) {
  if (value === null) {
    return 'null';
  }
  const type = typeof value;
  if (type === 'string') {
    return JSON.stringify(value);
  }
  if (type === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (type === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(`canonicalJson: non-finite number at ${path}`);
    }
    return Object.is(value, -0) ? '0' : JSON.stringify(value);
  }
  if (type === 'undefined') {
    throw new TypeError(`canonicalJson: undefined value at ${path}`);
  }
  if (type === 'bigint' || type === 'symbol' || type === 'function') {
    throw new TypeError(`canonicalJson: unsupported ${type} at ${path}`);
  }
  if (seen.has(value)) {
    throw new TypeError(`canonicalJson: circular reference at ${path}`);
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const parts = value.map((item, index) => {
        if (item === undefined) {
          throw new TypeError(`canonicalJson: undefined array element at ${path}[${index}]`);
        }
        return serialise(item, seen, `${path}[${index}]`);
      });
      return `[${parts.join(',')}]`;
    }
    if (isPlainObject(value)) {
      const keys = Object.keys(value).sort();
      const parts = [];
      for (const key of keys) {
        const item = value[key];
        if (item === undefined) {
          continue;
        }
        parts.push(`${JSON.stringify(key)}:${serialise(item, seen, `${path}.${key}`)}`);
      }
      return `{${parts.join(',')}}`;
    }
    throw new TypeError(`canonicalJson: unsupported object at ${path}`);
  } finally {
    seen.delete(value);
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
