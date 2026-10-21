# Third-Party Notices — `jiflow-canvas-mcp`

This file lists the third-party components involved in building and testing this project. It is
informational only: it does not grant any license, and it does not change the project's own license
status. The project is **MIT licensed** (see `LICENSE`) and is **not published**; the MIT license applies to
the project code only, not to third-party components listed below.

## 1. Runtime dependencies: none

The server (`src/`) and the examples (`examples/`) run on **Node.js built-in modules only**
(`node:fs`, `node:path`, `node:crypto`, `node:os`, `node:url`, `node:child_process`, `node:assert` in
tests/examples). `package.json` declares **no `dependencies`**, and no third-party package is imported by
`src/` at runtime. Installing or running the server does not download or require any third-party code.

## 2. Development-only dependencies

A single devDependency is declared, pinned exactly:

| Package | Version | License | Scope | Used by |
|---|---|---|---|---|
| `@modelcontextprotocol/sdk` | `1.30.0` | MIT | development/test only | `test/protocol/sdk-client.test.mjs` (independent protocol-client test) |

It is **not** imported by `src/`, is not needed to run the server or the examples, and is not shipped at
runtime or included in an npm tarball of the project. `npm install` / `npm ci` additionally installs the
SDK's transitive dependency closure (dev-only). Every installed entry is **permissive**; there is no
copyleft/weak-copyleft dependency and no package with an unknown/missing license.

Dependency closure statistics at the audited lockfile snapshot (`package-lock.json`, lockfileVersion 3).
Counts are by **lockfile package entry** (95 entries = 92 distinct package@version identities; three extra
entries are the duplicate physical copies of `content-type@2.1.0` noted below):

| License class | Lockfile entries |
|---|---|
| MIT | 85 |
| ISC | 7 |
| BSD-3-Clause | 2 |
| BSD-2-Clause | 1 |
| copyleft / unknown / non-permissive | **0** |
| **Total** | **95** |

## 3. Full installed tree (dev-only)

`package-lock.json` contains **95 lockfile package entries**: **92 distinct `name@version` identities** plus
**3 extra physical copies** of `content-type@2.1.0` (four copies in total, a normal npm nesting outcome).
License classes below are counted by lockfile entry; no package in the tree declares an install script at the
audited snapshot.

| Package | Version | Declared license | Installed copies |
|---|---|---|---|
| `@hono/node-server` | 2.1.5 | MIT | 1 |
| `@modelcontextprotocol/sdk` | 1.30.0 | MIT | 1 |
| `accepts` | 2.0.0 | MIT | 1 |
| `ajv-formats` | 3.0.1 | MIT | 1 |
| `ajv` | 8.20.0 | MIT | 1 |
| `body-parser` | 2.3.0 | MIT | 1 |
| `bytes` | 3.1.2 | MIT | 1 |
| `call-bind-apply-helpers` | 1.0.2 | MIT | 1 |
| `call-bound` | 1.0.4 | MIT | 1 |
| `content-disposition` | 2.0.1 | MIT | 1 |
| `content-type` | 1.0.5 | MIT | 1 |
| `content-type` | 2.1.0 | MIT | 4 |
| `cookie-signature` | 1.2.2 | MIT | 1 |
| `cookie` | 0.7.2 | MIT | 1 |
| `cors` | 2.8.6 | MIT | 1 |
| `cross-spawn` | 7.0.6 | MIT | 1 |
| `debug` | 4.4.3 | MIT | 1 |
| `depd` | 2.0.0 | MIT | 1 |
| `dunder-proto` | 1.0.1 | MIT | 1 |
| `ee-first` | 1.1.1 | MIT | 1 |
| `encodeurl` | 2.0.0 | MIT | 1 |
| `es-define-property` | 1.0.1 | MIT | 1 |
| `es-errors` | 1.3.0 | MIT | 1 |
| `es-object-atoms` | 1.1.2 | MIT | 1 |
| `escape-html` | 1.0.3 | MIT | 1 |
| `etag` | 1.8.1 | MIT | 1 |
| `eventsource-parser` | 3.1.1 | MIT | 1 |
| `eventsource` | 3.0.7 | MIT | 1 |
| `express-rate-limit` | 8.7.1 | MIT | 1 |
| `express` | 5.3.0 | MIT | 1 |
| `fast-deep-equal` | 3.1.3 | MIT | 1 |
| `fast-uri` | 3.1.9 | BSD-3-Clause | 1 |
| `finalhandler` | 2.1.1 | MIT | 1 |
| `forwarded` | 0.2.0 | MIT | 1 |
| `fresh` | 2.0.0 | MIT | 1 |
| `function-bind` | 1.1.2 | MIT | 1 |
| `get-intrinsic` | 1.3.0 | MIT | 1 |
| `get-proto` | 1.0.1 | MIT | 1 |
| `gopd` | 1.2.0 | MIT | 1 |
| `has-symbols` | 1.1.0 | MIT | 1 |
| `hasown` | 2.0.4 | MIT | 1 |
| `hono` | 4.13.13 | MIT | 1 |
| `http-errors` | 2.0.1 | MIT | 1 |
| `iconv-lite` | 0.7.3 | MIT | 1 |
| `inherits` | 2.0.4 | ISC | 1 |
| `ip-address` | 10.7.4 | MIT | 1 |
| `ipaddr.js` | 1.9.1 | MIT | 1 |
| `is-promise` | 4.0.0 | MIT | 1 |
| `isexe` | 2.0.0 | ISC | 1 |
| `jose` | 6.2.13 | MIT | 1 |
| `json-schema-traverse` | 1.0.0 | MIT | 1 |
| `json-schema-typed` | 8.0.2 | BSD-2-Clause | 1 |
| `math-intrinsics` | 1.1.0 | MIT | 1 |
| `media-typer` | 1.1.1 | MIT | 1 |
| `merge-descriptors` | 2.0.0 | MIT | 1 |
| `mime-db` | 1.54.0 | MIT | 1 |
| `mime-types` | 3.0.2 | MIT | 1 |
| `ms` | 2.1.3 | MIT | 1 |
| `negotiator` | 1.1.0 | MIT | 1 |
| `object-assign` | 4.1.1 | MIT | 1 |
| `object-inspect` | 1.13.4 | MIT | 1 |
| `on-finished` | 2.4.1 | MIT | 1 |
| `once` | 1.4.0 | ISC | 1 |
| `parseurl` | 1.3.3 | MIT | 1 |
| `path-key` | 3.1.1 | MIT | 1 |
| `path-to-regexp` | 8.4.2 | MIT | 1 |
| `pkce-challenge` | 5.0.1 | MIT | 1 |
| `proxy-addr` | 2.0.8 | MIT | 1 |
| `qs` | 6.16.1 | BSD-3-Clause | 1 |
| `range-parser` | 1.3.0 | MIT | 1 |
| `raw-body` | 3.0.2 | MIT | 1 |
| `require-from-string` | 2.0.2 | MIT | 1 |
| `router` | 2.2.0 | MIT | 1 |
| `safer-buffer` | 2.1.2 | MIT | 1 |
| `send` | 1.2.1 | MIT | 1 |
| `serve-static` | 2.2.1 | MIT | 1 |
| `setprototypeof` | 1.2.0 | ISC | 1 |
| `shebang-command` | 2.0.0 | MIT | 1 |
| `shebang-regex` | 3.0.0 | MIT | 1 |
| `side-channel-list` | 1.0.1 | MIT | 1 |
| `side-channel-map` | 1.0.1 | MIT | 1 |
| `side-channel-weakmap` | 1.0.2 | MIT | 1 |
| `side-channel` | 1.1.1 | MIT | 1 |
| `statuses` | 2.0.2 | MIT | 1 |
| `toidentifier` | 1.0.1 | MIT | 1 |
| `type-is` | 2.1.0 | MIT | 1 |
| `unpipe` | 1.0.0 | MIT | 1 |
| `vary` | 1.1.2 | MIT | 1 |
| `which` | 2.0.2 | ISC | 1 |
| `wrappy` | 1.0.2 | ISC | 1 |
| `zod-to-json-schema` | 3.25.2 | ISC | 1 |
| `zod` | 4.6.7 | MIT | 1 |

## 4. No vendored third-party code or assets

No third-party source code, generated code, media asset, font, or other protected work is copied into
`src/`, `examples/`, `test/`, `scripts/`, or the documentation of this project. The only third-party
code used is the npm-managed development dependency listed above, installed under `node_modules/` (never
committed; excluded by `.gitignore`) and never redistributed with the project.

## 5. License texts

Each installed package ships its own license text inside
`node_modules/<package>/LICENSE` (or `LICENSE.md`/`license`) when development dependencies are installed.
Those texts are not duplicated in this repository; they remain the property of their respective authors
and are distributed with the packages by their publishers under the terms shown above.

## 6. Node.js

Node.js is a prerequisite (>= 20), not bundled or redistributed. Node.js is distributed under the MIT
license by the OpenJS Foundation and its contributors; see <https://nodejs.org/en/about/previous-releases>
for the license text shipped with the runtime.
