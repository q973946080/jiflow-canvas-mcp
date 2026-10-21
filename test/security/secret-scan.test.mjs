// Public-release scanner tests: the sanitized public `scripts/verify/scan-secrets.mjs` must keep
// detecting generic secrets / PII / private paths / generic business material WITHOUT the optional
// local-only restricted-term policy, and must not itself contain proprietary literals.
//
// Fixtures in this file are assembled at runtime from string fragments so that the planted
// pseudo-secrets do not themselves trip the scanner on this source file (the scanner scans test/).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  scanRepository,
  loadRestrictedTerms,
  RESTRICTED_TERMS_RELATIVE_PATH,
} from '../../scripts/verify/scan-secrets.mjs';
import { REPO_ROOT } from '../helpers/paths.mjs';
import { createTempDir, rmrf } from '../helpers/fixture-store.mjs';

/** Explicitly generic-only mode, as a public checkout without the local-only policy file. */
const GENERIC_ONLY = Object.freeze({
  loaded: false,
  path: RESTRICTED_TERMS_RELATIVE_PATH,
  ruleIds: [],
  rules: [],
  provenanceReferenceFiles: [],
  provenanceEnumerationFiles: [],
});

function writeFixtureFile(root, relativePath, contents) {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents, 'utf8');
  return target;
}

/** Build the planted fixture tree using runtime fragments (keeps this source file scan-clean). */
function createPlantedReleaseTree() {
  const root = createTempDir('canvas-mcp-scan-fixture-');
  writeFixtureFile(
    root,
    'src/leaky.mjs',
    [
      `export const accessKey = "${['AK', 'IA', 'ABCDEFGHIJKLMNOP'].join('')}";`,
      `export const mail = "${['person', '@', 'real-domain.test'].join('')}";`,
      `export const home = "${['', 'Users', 'someuser', 'project', 'file.txt'].join('/')}";`,
      `export const endpoint = "${['http', '://', ['10', '1', '2', '3'].join('.'), '/admin'].join('')}";`,
      `export const marker = "${['confidential', 'prompt'].join(' ')}";`,
      '',
    ].join('\n'),
  );
  // A binary asset in the release surface is always a finding.
  fs.writeFileSync(path.join(root, 'src', 'cover.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return root;
}

describe('sanitized public secret/PII scanner', () => {
  test('generic-only mode (public checkout) still catches secrets, PII, private paths, generic business material and binary assets', () => {
    const root = createPlantedReleaseTree();
    try {
      const report = scanRepository(root, { restrictedTerms: GENERIC_ONLY });
      assert.equal(report.restrictedTerms.loaded, false);
      assert.equal(report.result, 'FINDINGS');
      assert.ok(report.counts.failures >= 5, `expected multiple failures, got ${JSON.stringify(report.counts)}`);
      const failedRuleIds = new Set(report.findings.filter((finding) => !finding.allowlisted).map((finding) => finding.ruleId));
      for (const ruleId of [
        'aws-access-key',
        'email-address',
        'absolute-user-path',
        'private-url',
        'generic-business-material',
        'binary-asset',
      ]) {
        assert.equal(failedRuleIds.has(ruleId), true, `generic scanner must still detect ${ruleId}; got ${[...failedRuleIds].join(',')}`);
      }
      // Nothing in this fixture is fictional-demo/allowlisted material.
      assert.equal(report.counts.allowlisted, 0);
    } finally {
      rmrf(root);
    }
  });

  test('generic-only mode is CLEAN on the actual release tree (public-checkout simulation)', () => {
    const report = scanRepository(REPO_ROOT, { restrictedTerms: GENERIC_ONLY });
    assert.equal(report.restrictedTerms.loaded, false, 'generic-only mode must be reported as degraded when the local policy is absent');
    assert.equal(report.result, 'CLEAN', `unexpected generic findings: ${JSON.stringify(report.findings.filter((finding) => !finding.allowlisted))}`);
    assert.equal(report.counts.failures, 0);
    assert.ok(report.filesScanned > 0);
  });

  test('clean tree passes generic-only mode', () => {
    const root = createTempDir('canvas-mcp-scan-clean-');
    try {
      writeFixtureFile(root, 'src/clean.mjs', 'export const answer = 42;\n');
      const report = scanRepository(root, { restrictedTerms: GENERIC_ONLY });
      assert.equal(report.result, 'CLEAN');
      assert.equal(report.counts.failures, 0);
    } finally {
      rmrf(root);
    }
  });

  test('internal strict mode loads the local-only restricted policy; public scripts contain none of its literals', () => {
    const restricted = loadRestrictedTerms();
    if (!restricted.loaded) {
      // Public checkout: the gitignored local policy is absent by design. Nothing strict to check.
      return;
    }
    assert.ok(restricted.ruleIds.length >= 10, `local policy must keep the full internal rule set, got ${restricted.ruleIds.length}`);
    const report = scanRepository(REPO_ROOT);
    assert.equal(report.restrictedTerms.loaded, true);
    assert.deepEqual(report.restrictedTerms.ruleIds, restricted.ruleIds);
    assert.equal(report.result, 'CLEAN', `unexpected strict-mode findings: ${JSON.stringify(report.findings.filter((finding) => !finding.allowlisted))}`);

    const publicScripts = [
      path.join(REPO_ROOT, 'scripts', 'verify', 'scan-secrets.mjs'),
      path.join(REPO_ROOT, 'scripts', 'verify', 'run-acceptance.mjs'),
    ];
    // The public verify scripts must not match any of the local-only detection rules themselves.
    const localPolicy = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'verify', 'restricted-terms.local.json'), 'utf8'));
    for (const scriptPath of publicScripts) {
      const scriptText = fs.readFileSync(scriptPath, 'utf8');
      assert.equal(scriptText.includes('.join(\'\')'), false, 'public scripts must not use literal-conflation tricks');
      assert.equal(scriptText.includes('\u7b2c'), false, 'public scripts must not contain CJK episode wording');
      for (const rule of localPolicy.rules) {
        const regex = new RegExp(rule.pattern, rule.flags ?? 'g');
        assert.equal(
          regex.test(scriptText),
          false,
          `public verify script ${path.basename(scriptPath)} matches the local-only restricted rule ${rule.id}`,
        );
      }
    }
  });

  test('scan-secrets --require-restricted matches the environment: strict internal mode exits 0, public checkout fails closed', () => {
    const restricted = loadRestrictedTerms();
    const result = spawnSync(
      process.execPath,
      [path.join('scripts', 'verify', 'scan-secrets.mjs'), '--require-restricted'],
      { cwd: REPO_ROOT, encoding: 'utf8', timeout: 120_000 },
    );
    if (restricted.loaded) {
      assert.equal(result.status, 0, `scan-secrets failed: ${result.stderr}\n${result.stdout}`);
      assert.match(result.stdout, /restricted terms: loaded \d+ local-only rules/);
    } else {
      // Public checkout: --require-restricted must fail closed rather than silently weaken.
      assert.equal(result.status, 3, `expected fail-closed exit 3, got ${result.status}: ${result.stderr}`);
      assert.match(result.stderr, /--require-restricted used but .* is absent \(fail closed\)/);
    }
  });
});
