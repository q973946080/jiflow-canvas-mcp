// Test helper: an INDEPENDENT canonical-JSON implementation (the documented contract rules), used to verify
// payloadHash values without trusting src/canonical-json.js.
import { createHash } from 'node:crypto';

export function independentCanonicalJson(value) {
  const seen = new Set();

  function serialise(node) {
    if (node === null) return 'null';
    const type = typeof node;
    if (type === 'string' || type === 'boolean') return JSON.stringify(node);
    if (type === 'number') {
      if (!Number.isFinite(node)) throw new TypeError('non-finite number');
      return Object.is(node, -0) ? '0' : JSON.stringify(node);
    }
    if (type === 'undefined') throw new TypeError('undefined value');
    if (type !== 'object') throw new TypeError(`unsupported ${type}`);
    if (seen.has(node)) throw new TypeError('cycle');
    seen.add(node);
    try {
      if (Array.isArray(node)) {
        return `[${node.map((item) => serialise(item)).join(',')}]`;
      }
      const keys = Object.keys(node).sort();
      const parts = [];
      for (const key of keys) {
        const item = node[key];
        if (item === undefined) continue;
        parts.push(`${JSON.stringify(key)}:${serialise(item)}`);
      }
      return `{${parts.join(',')}}`;
    } finally {
      seen.delete(node);
    }
  }

  return serialise(value);
}

export function independentHash(value) {
  return createHash('sha256').update(independentCanonicalJson(value), 'utf8').digest('hex');
}
