// Test helper: canonical repository paths. Derived from the frozen public contract only.
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const REPO_ROOT = path.resolve(HERE, '..', '..');
export const SRC_DIR = path.join(REPO_ROOT, 'src');
export const EXAMPLES_DIR = path.join(REPO_ROOT, 'examples');
export const TEST_DIR = path.join(REPO_ROOT, 'test');
export const PKG_PATH = path.join(REPO_ROOT, 'package.json');
export const SERVER_ENTRY = path.join(SRC_DIR, 'server', 'main.mjs');

// Scratch roots end up in a real temp directory, never in the repository.
export const TMP_BASE = os.tmpdir();

export const SERVER_NAME = 'jiflow-canvas-mcp';
export const SERVER_VERSION = '0.1.0';
export const PROTOCOL_VERSION = '2025-11-25';
export const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07']);

export const TOOL_NAMES = Object.freeze([
  'canvas_list_canvases',
  'canvas_read_canvas',
  'canvas_read_node',
  'canvas_read_receipt',
  'canvas_list_receipts',
  'canvas_create_node',
  'canvas_patch_node',
  'canvas_connect_nodes',
  'canvas_commit_batch',
]);

export const READ_TOOL_NAMES = Object.freeze(TOOL_NAMES.slice(0, 5));
export const WRITE_TOOL_NAMES = Object.freeze(TOOL_NAMES.slice(5));

export const ERROR_CODES = Object.freeze([
  'CANVAS_TOOL_NOT_WHITELISTED', 'CANVAS_TOOL_DENIED', 'CANVAS_TOOL_UNKNOWN',
  'CANVAS_ARGUMENTS_INVALID', 'CANVAS_AUTH_REQUIRED', 'CANVAS_AUTH_CONFIG_INVALID', 'CANVAS_PRINCIPAL_UNKNOWN',
  'CANVAS_READ_ONLY', 'CANVAS_AUTH_DENIED', 'CANVAS_CANVAS_SCOPE_MISMATCH',
  'CANVAS_CANVAS_ID_INVALID', 'CANVAS_CANVAS_NOT_FOUND',
  'CANVAS_NODE_ID_INVALID', 'CANVAS_NODE_ID_CONFLICT', 'CANVAS_NODE_NOT_FOUND', 'CANVAS_NODE_FIELD_PROTECTED',
  'CANVAS_NODE_FIELD_UNKNOWN', 'CANVAS_NODE_FIELD_INVALID', 'CANVAS_POSITION_INVALID',
  'CANVAS_EDGE_ID_INVALID', 'CANVAS_EDGE_ID_CONFLICT', 'CANVAS_EDGE_NOT_FOUND', 'CANVAS_EDGE_RELATION_INVALID',
  'CANVAS_ACTION_NOT_WHITELISTED', 'CANVAS_ACTION_INVALID',
  'CANVAS_REVISION_REQUIRED', 'CANVAS_REVISION_CONFLICT', 'CANVAS_REVISION_EXHAUSTED',
  'CANVAS_OPERATION_ID_INVALID', 'CANVAS_OPERATION_REQUEST_INVALID', 'CANVAS_OPERATION_SCOPE_CONFLICT',
  'CANVAS_OPERATION_KIND_CONFLICT', 'CANVAS_OPERATION_PAYLOAD_CONFLICT',
  'CANVAS_RECEIPT_NOT_FOUND', 'CANVAS_STORE_UNAVAILABLE', 'CANVAS_STORE_BUSY', 'CANVAS_STORE_CORRUPT',
  'CANVAS_INTERNAL_ERROR',
]);
