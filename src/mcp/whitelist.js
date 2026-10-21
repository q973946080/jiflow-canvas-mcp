/**
 * MCP tool whitelist: exactly nine `canvas_*` tools with strict JSON-Schema-subset input
 * schemas. The whitelist is the single source of truth for tool names, permissions and
 * argument shapes; both the dispatcher and `tools/list` read from it.
 */
import { CANVAS_NODE_KINDS, NODE_STATUSES } from '../canvas/capabilities.js';

const CANVAS_ID = {
  type: 'string',
  description: 'Canvas identifier.'
};
const NODE_ID = {
  type: 'string',
  description: 'Node identifier.'
};
const EDGE_ID = {
  type: 'string',
  description: 'Edge identifier.'
};
const OPERATION_ID = {
  type: 'string',
  description: 'Client supplied idempotency key. Replaying the same operationId with the same payload returns the stored receipt.'
};
const EXPECTED_REVISION = {
  type: 'integer',
  description: 'Revision the caller believes is current. Omit to let the server read the current revision before writing.'
};

/**
 * Position schema: exactly two finite numbers.
 * `additionalProperties:false` keeps the shape strict.
 */
const POSITION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    x: { type: 'number', description: 'Horizontal coordinate.' },
    y: { type: 'number', description: 'Vertical coordinate.' }
  },
  required: ['x', 'y'],
  description: 'Canvas position with numeric x and y.'
};

/**
 * Node `data` schema. Mutable fields are validated by the domain layer (lengths, enums,
 * URL prefixes); protected fields are declared here so the domain can reject them with a
 * precise `CANVAS_NODE_FIELD_PROTECTED` code instead of a generic schema error.
 */
const NODE_DATA_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    label: { type: 'string', description: 'Human readable node label.' },
    status: { type: 'string', description: 'Node status.', enum: [...NODE_STATUSES] },
    source: { type: 'string', description: 'Optional source label.' },
    content: { type: 'string', description: 'Text content.' },
    prompt: { type: 'string', description: 'Prompt text.' },
    url: { type: 'string', description: 'HTTP(S) URL.' },
    mimeType: { type: 'string', description: 'IANA media type.' },
    width: { type: 'integer', description: 'Pixel width.' },
    height: { type: 'integer', description: 'Pixel height.' },
    duration: { type: 'number', description: 'Duration in seconds.' },
    errorMessage: { type: 'string', description: 'Last error message.' },
    nodeType: { description: 'Protected: injected by the server.' },
    assetId: { description: 'Protected: managed by asset tooling.' },
    stateId: { description: 'Protected: managed by the server.' },
    id: { description: 'Protected: node ids live at the node level.' },
    type: { description: 'Protected: node kinds live at the node level.' }
  },
  description: 'Mutable node data fields.'
};

const NODE_CREATE_NODE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: NODE_ID,
    type: { type: 'string', enum: [...CANVAS_NODE_KINDS], description: 'Node kind.' },
    position: POSITION_SCHEMA,
    data: NODE_DATA_SCHEMA
  },
  required: ['id', 'type']
};

const PATCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    data: NODE_DATA_SCHEMA,
    position: POSITION_SCHEMA
  },
  description: 'Node fields to update; at least one of data or position is required.'
};

const EDGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: EDGE_ID,
    source: NODE_ID,
    target: NODE_ID,
    relation: { type: 'string', description: 'Relation label.', default: 'reference' }
  },
  required: ['id', 'source', 'target']
};

const ACTION_SCHEMAS = [
  {
    type: 'object',
    additionalProperties: false,
    properties: {
      kind: { const: 'node.create' },
      node: NODE_CREATE_NODE_SCHEMA
    },
    required: ['kind', 'node']
  },
  {
    type: 'object',
    additionalProperties: false,
    properties: {
      kind: { const: 'node.patch' },
      nodeId: NODE_ID,
      patch: PATCH_SCHEMA
    },
    required: ['kind', 'nodeId', 'patch']
  },
  {
    type: 'object',
    additionalProperties: false,
    properties: {
      kind: { const: 'edge.connect' },
      edge: EDGE_SCHEMA
    },
    required: ['kind', 'edge']
  }
];

const ACTIONS_SCHEMA = {
  type: 'array',
  items: { oneOf: ACTION_SCHEMAS },
  description: 'Between 1 and 100 ordered actions.'
};

/** Full definitions, in the order required by the spec. */
export const TOOL_WHITELIST = Object.freeze(
  [
    {
      name: 'canvas_list_canvases',
      title: 'List canvases',
      description:
        'List canvases visible to the authenticated principal with their current revision and node/edge counts.',
      permission: 'READ',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {},
        required: []
      }
    },
    {
      name: 'canvas_read_canvas',
      title: 'Read canvas',
      description: 'Read a canvas with all of its nodes and edges.',
      permission: 'READ',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: { canvasId: CANVAS_ID },
        required: ['canvasId']
      }
    },
    {
      name: 'canvas_read_node',
      title: 'Read node',
      description: 'Read one node of a canvas.',
      permission: 'READ',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: { canvasId: CANVAS_ID, nodeId: NODE_ID },
        required: ['canvasId', 'nodeId']
      }
    },
    {
      name: 'canvas_read_receipt',
      title: 'Read operation receipt',
      description: 'Read the durable receipt of one applied operation.',
      permission: 'READ',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: { canvasId: CANVAS_ID, operationId: OPERATION_ID },
        required: ['canvasId', 'operationId']
      }
    },
    {
      name: 'canvas_list_receipts',
      title: 'List operation receipts',
      description: 'List the most recent operation receipts of a canvas, newest first.',
      permission: 'READ',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          canvasId: CANVAS_ID,
          limit: { type: 'integer', default: 20, description: 'Maximum number of receipts (1-100).' }
        },
        required: ['canvasId']
      }
    },
    {
      name: 'canvas_create_node',
      title: 'Create node',
      description:
        'Create a node on a canvas. Fails with CANVAS_REVISION_CONFLICT when expectedRevision is stale.',
      permission: 'WRITE',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          canvasId: CANVAS_ID,
          kind: { type: 'string', enum: [...CANVAS_NODE_KINDS], description: 'Node kind.' },
          label: { type: 'string', description: 'Human readable label.' },
          position: POSITION_SCHEMA,
          data: NODE_DATA_SCHEMA,
          nodeId: NODE_ID,
          expectedRevision: EXPECTED_REVISION,
          operationId: OPERATION_ID
        },
        required: ['canvasId', 'kind', 'label']
      }
    },
    {
      name: 'canvas_patch_node',
      title: 'Patch node',
      description: 'Update the data and/or position of an existing node.',
      permission: 'WRITE',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          canvasId: CANVAS_ID,
          nodeId: NODE_ID,
          data: NODE_DATA_SCHEMA,
          position: POSITION_SCHEMA,
          expectedRevision: EXPECTED_REVISION,
          operationId: OPERATION_ID
        },
        required: ['canvasId', 'nodeId']
      }
    },
    {
      name: 'canvas_connect_nodes',
      title: 'Connect nodes',
      description: 'Connect a source node to a target node with a capability-valid relation.',
      permission: 'WRITE',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          canvasId: CANVAS_ID,
          source: NODE_ID,
          target: NODE_ID,
          relation: { type: 'string', default: 'reference', description: 'Relation label.' },
          edgeId: EDGE_ID,
          expectedRevision: EXPECTED_REVISION,
          operationId: OPERATION_ID
        },
        required: ['canvasId', 'source', 'target']
      }
    },
    {
      name: 'canvas_commit_batch',
      title: 'Commit action batch',
      description:
        'Apply an ordered batch of node.create/node.patch/edge.connect actions as one atomic revision.',
      permission: 'WRITE',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          canvasId: CANVAS_ID,
          actions: ACTIONS_SCHEMA,
          expectedRevision: EXPECTED_REVISION,
          operationId: OPERATION_ID
        },
        required: ['canvasId', 'actions']
      }
    }
  ].map((tool) => Object.freeze(tool))
);

/** Tool names in whitelist order. */
export const TOOL_NAMES = Object.freeze(TOOL_WHITELIST.map((tool) => tool.name));
export const WHITELISTED_TOOL_NAMES = TOOL_NAMES;
const TOOL_NAMES_SET = new Set(TOOL_NAMES);

/** Map of tool name to permission (`READ` or `WRITE`). */
export const TOOL_PERMISSIONS = Object.freeze(
  Object.fromEntries(TOOL_WHITELIST.map((tool) => [tool.name, tool.permission]))
);

/** Look up a whitelisted tool definition; returns `null` for unknown names. */
export function getToolByName(name) {
  if (typeof name !== 'string') {
    return null;
  }
  return TOOL_WHITELIST.find((tool) => tool.name === name) ?? null;
}

export const getTool = getToolByName;
export const lookupTool = getToolByName;

/** Return `true` when `name` is a whitelisted tool. */
export function isWhitelistedTool(name) {
  return typeof name === 'string' && TOOL_NAMES_SET.has(name);
}

/** Public `tools/list` projection (name/title/description/inputSchema only). */
export function listToolDefinitions() {
  return TOOL_WHITELIST.map(({ name, title, description, inputSchema }) => ({
    name,
    title,
    description,
    inputSchema
  }));
}
