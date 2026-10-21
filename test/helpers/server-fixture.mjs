// Test helper: one fixture store + one or more real server processes sharing it.
import { createFixtureStore } from './fixture-store.mjs';
import { createAuthFixture, standardPrincipalSpecs, FIXTURE_TOKENS } from './auth-config.mjs';
import { startServerClient, spawnServer } from './spawn-server.mjs';

/**
 * Create a temp fixture store with auth file and spawn one real server process
 * (initialize handshake completed).
 */
export async function createServerFixture(options = {}) {
  const {
    canvases,
    principals = standardPrincipalSpecs(),
    token = FIXTURE_TOKENS.writerA,
    serverOptions = {},
    clientOptions = {},
  } = options;
  const store = createFixtureStore(canvases ? { canvases } : undefined);
  const auth = createAuthFixture(store.root, principals);
  const handle = await startServerClient({
    store: store.storeDir,
    auth: auth.authPath,
    token,
    ...serverOptions,
    ...clientOptions,
  });
  return {
    store,
    auth,
    handle,
    client: handle.client,
    request: (method, params, requestOptions) => handle.request(method, params, requestOptions),
    notify: (method, params) => handle.notify(method, params),
    serverOptions,
    async close() {
      await handle.cleanup();
      store.cleanup();
    },
  };
}

/** Start an additional real server process against an existing fixture's store/auth. */
export async function attachServer(fixture, { token = FIXTURE_TOKENS.writerA, serverOptions = {}, clientOptions = {} } = {}) {
  return startServerClient({
    store: fixture.store.storeDir,
    auth: fixture.auth.authPath,
    token,
    ...serverOptions,
    ...clientOptions,
  });
}

/**
 * Spawn a server that is expected to fail during startup.
 * Returns {server, exit, stderr, commandLine}.
 */
export async function spawnStartupFailure({ args, token, env, timeoutMs = 10_000, cwd } = {}) {
  const server = spawnServer({ args, token, env, cwd });
  const exit = await server.waitExit({ timeoutMs });
  return { server, exit, stderr: server.stderrText(), stdout: server.stdoutRaw, commandLine: server.commandLine };
}
