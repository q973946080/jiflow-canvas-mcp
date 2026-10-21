// Test helper: normalize MCP tool-call results (the documented contract result envelopes).
import assert from 'node:assert/strict';

/** Decode the JSON payload carried in content[0].text. */
export function parseToolContent(toolResult) {
  assert.ok(toolResult && Array.isArray(toolResult.content), `expected tool result with content array, got: ${JSON.stringify(toolResult)}`);
  assert.equal(toolResult.content.length >= 1, true, 'expected at least one content item');
  const first = toolResult.content[0];
  assert.equal(first.type, 'text');
  assert.equal(typeof first.text, 'string');
  return JSON.parse(first.text);
}

/** Pretty context for assertion failures. */
export function describeResult(toolResult) {
  try {
    return JSON.stringify(parseToolContent(toolResult));
  } catch {
    return JSON.stringify(toolResult);
  }
}

/** Parse and assert the success envelope; returns the decoded JSON payload. */
export function expectToolOk(toolResult, { tool, permission } = {}) {
  const payload = parseToolContent(toolResult);
  assert.equal(toolResult.isError, undefined, `expected success result, got isError: ${describeResult(toolResult)}`);
  assert.equal(payload.ok, true, `expected ok:true, got ${describeResult(toolResult)}`);
  if (tool !== undefined) assert.equal(payload.tool, tool);
  if (permission !== undefined) assert.equal(payload.permission, permission);
  return payload;
}

/** Parse and assert an MCP tool-level error; returns {code, payload}. */
export function expectToolError(toolResult, expectedCode, { allowedCodes = null } = {}) {
  assert.equal(toolResult.isError, true, `expected isError:true, got: ${describeResult(toolResult)}`);
  const payload = parseToolContent(toolResult);
  assert.equal(payload.ok, false, `expected ok:false, got ${describeResult(toolResult)}`);
  assert.equal(typeof payload.code, 'string', `expected machine error code, got ${describeResult(toolResult)}`);
  assert.equal(typeof payload.error, 'string', 'expected error message string');
  const accepted = allowedCodes ?? (Array.isArray(expectedCode) ? expectedCode : [expectedCode]);
  assert.ok(
    accepted.includes(payload.code),
    `expected error code one of ${accepted.join(', ')}, got ${payload.code} (${describeResult(toolResult)})`,
  );
  if (expectedCode && !Array.isArray(expectedCode)) {
    assert.equal(payload.code, expectedCode, `expected error code ${expectedCode}, got ${payload.code}`);
  }
  return { code: payload.code, payload };
}

/** Call a tool via the raw client and return the raw MCP result (never throws on isError). */
export async function callTool(client, name, args = {}, options = {}) {
  return client.request('tools/call', { name, arguments: args }, options);
}

/** Call a tool, assert success, return payload. */
export async function callToolOk(client, name, args = {}, options = {}) {
  const raw = await callTool(client, name, args, options);
  return expectToolOk(raw, { tool: name });
}

/** Call a tool, assert an MCP tool-level error, return {code, payload}. */
export async function callToolError(client, name, args = {}, expectedCode, options = {}) {
  const raw = await callTool(client, name, args, options);
  return expectToolError(raw, expectedCode);
}

/** Assert structuredContent mirrors content[0].text (same fields/values). */
export function assertStructuredMirrorsContent(toolResult) {
  const payload = parseToolContent(toolResult);
  assert.ok(toolResult.structuredContent, 'expected structuredContent on success result');
  assert.deepEqual(toolResult.structuredContent, payload);
  return payload;
}
