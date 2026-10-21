#!/usr/bin/env node
/**
 * Seed the example demo store with fictional canvases and a fictional auth config.
 *
 * Everything written here is synthetic demo data: canvas ids `canvas-demo-a`/`canvas-demo-b`,
 * `example.invalid` URLs and `demo-*` tokens. No real user data or assets are involved.
 *
 * Idempotent: only `examples/demo-store/` is removed and rewritten. Exit code 0 on success.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tokenSha256 } from '../src/auth/config.js';

const examplesDir = path.dirname(fileURLToPath(import.meta.url));
const storeDir = path.join(examplesDir, 'demo-store');
const canvasesDir = path.join(storeDir, 'canvases');
const locksDir = path.join(storeDir, '.locks');
const authPath = path.join(examplesDir, 'auth.demo.json');

/** Fictional tokens used by the examples (also documented in examples/README.md). */
export const DEMO_TOKENS = Object.freeze({
  'agent-writer-a': 'demo-writer-a-token',
  'agent-writer-b': 'demo-writer-b-token',
  'agent-reader': 'demo-reader-token'
});

const CREATED_AT = '2026-01-01T00:00:00.000Z';

function node(id, type, label, data, position) {
  return { id, type, position, data: { nodeType: type, label, ...data } };
}

function canvasState(canvasId, name, nodes, edges) {
  return {
    storeVersion: 1,
    canvas: { canvasId, name, createdAt: CREATED_AT },
    revision: 0,
    data: { nodes, edges },
    tombstones: { nodes: [], edges: [] },
    receipts: {},
    updatedAt: CREATED_AT
  };
}

const canvasA = canvasState(
  'canvas-demo-a',
  'Demo canvas A',
  [
    node(
      'node-welcome',
      'text',
      'Welcome to the demo canvas',
      { content: 'This is fictional demo data generated for the example.', status: 'idle' },
      { x: 40, y: 80 }
    ),
    node(
      'node-hero-image',
      'image',
      'Demo hero image',
      {
        url: 'https://example.invalid/assets/hero.png',
        status: 'idle',
        width: 1280,
        height: 720,
        mimeType: 'image/png'
      },
      { x: 360, y: 80 }
    ),
    node(
      'node-demo-video',
      'video',
      'Demo video',
      {
        url: 'https://example.invalid/assets/clip.mp4',
        status: 'idle',
        width: 1920,
        height: 1080,
        duration: 12.5,
        mimeType: 'video/mp4'
      },
      { x: 360, y: 320 }
    ),
    node(
      'node-demo-note',
      'note',
      'Demo note',
      { content: 'A fictional note connected from the welcome text node.', status: 'idle' },
      { x: 680, y: 80 }
    )
  ],
  [{ id: 'edge-welcome-note', source: 'node-welcome', target: 'node-demo-note', relation: 'context' }]
);

const canvasB = canvasState(
  'canvas-demo-b',
  'Demo canvas B',
  [
    node(
      'node-b-text',
      'text',
      'Second canvas text',
      { content: 'A second fictional canvas used to demonstrate scope isolation.', status: 'idle' },
      { x: 60, y: 60 }
    ),
    node(
      'node-b-image',
      'image',
      'Second canvas image',
      { url: 'https://example.invalid/assets/second.png', status: 'idle', width: 640, height: 480 },
      { x: 60, y: 240 }
    )
  ],
  []
);

const authConfig = {
  version: 1,
  principals: [
    {
      principalId: 'agent-writer-a',
      tokenSha256: tokenSha256(DEMO_TOKENS['agent-writer-a']),
      mode: 'CANVAS_WRITE',
      canvasIds: ['canvas-demo-a'],
      allowedTools: null
    },
    {
      principalId: 'agent-writer-b',
      tokenSha256: tokenSha256(DEMO_TOKENS['agent-writer-b']),
      mode: 'CANVAS_WRITE',
      canvasIds: ['canvas-demo-b'],
      allowedTools: null
    },
    {
      principalId: 'agent-reader',
      tokenSha256: tokenSha256(DEMO_TOKENS['agent-reader']),
      mode: 'READ_ONLY',
      canvasIds: ['*'],
      allowedTools: null
    }
  ]
};

function main() {
  rmSync(storeDir, { recursive: true, force: true });
  mkdirSync(canvasesDir, { recursive: true });
  mkdirSync(locksDir, { recursive: true });

  writeFileSync(path.join(canvasesDir, 'canvas-demo-a.json'), `${JSON.stringify(canvasA, null, 2)}\n`, 'utf8');
  writeFileSync(path.join(canvasesDir, 'canvas-demo-b.json'), `${JSON.stringify(canvasB, null, 2)}\n`, 'utf8');
  writeFileSync(authPath, `${JSON.stringify(authConfig, null, 2)}\n`, 'utf8');

  console.log('Seeded fictional demo data:');
  console.log(`  store:  ${path.relative(process.cwd(), storeDir) || storeDir}`);
  console.log(`  auth:   ${path.relative(process.cwd(), authPath) || authPath}`);
  console.log('  canvases: canvas-demo-a (revision 0, 4 nodes, 1 edge), canvas-demo-b (revision 0, 2 nodes)');
  console.log('  principals: agent-writer-a (CANVAS_WRITE, canvas-demo-a), agent-writer-b (CANVAS_WRITE, canvas-demo-b), agent-reader (READ_ONLY, *)');
  console.log('  tokens are documented in examples/README.md and stored only as SHA-256 digests.');
}

try {
  main();
} catch (error) {
  console.error(`seed-demo failed: ${error.message}`);
  process.exitCode = 1;
}
