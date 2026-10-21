#!/usr/bin/env node
/**
 * Secret / PII / private-reference scanner for the publishable tree.
 *
 * Scans src/, examples/, test/, docs/, scripts/, package.json, README*, ARCHITECTURE.md,
 * SECURITY.md, LICENSE and .gitignore for secret patterns, absolute developer paths, private
 * URLs, PII (emails), real asset references and generic business/confidential material.
 *
 * Fictional demo credentials of the documented form `demo-*-token` are
 * allowlisted and reported as OK. Everything else is a finding and makes the script
 * exit nonzero.
 *
 * Optional local-only restricted-term policy
 * ------------------------------------------
 * This file is PUBLIC and intentionally contains no proprietary literals. Environments that
 * need an additional private/proprietary detection policy can drop a local-only
 * `scripts/verify/restricted-terms.local.json` next to this script. That file is gitignored,
 * NEVER part of the public package, and is loaded automatically when present:
 *   - internal audit runs get the strict private/business-material policy (C10 stays strong),
 *   - a checkout without the file gets a clearly reported generic-only (degraded) scan.
 * A malformed local policy file fails closed (nonzero exit) rather than silently weakening.
 *
 * Usage:
 *   node scripts/verify/scan-secrets.mjs [--json] [--root <dir>] [--require-restricted]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const SCAN_DIRS = ['src', 'examples', 'test', 'docs', 'scripts'];
export const SCAN_FILES = [
  'package.json',
  'README.md',
  'README.zh-CN.md',
  'ARCHITECTURE.md',
  'SECURITY.md',
  'LICENSE',
  '.gitignore',
];

const TEXT_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.json', '.md', '.txt', '.yml', '.yaml', '.sh', '.ts',
  '.css', '.html', '.example', '.env', '.map', '.toml', '.ini',
]);
const SKIP_DIR_NAMES = new Set(['node_modules', '.git', 'evidence', 'audit', 'demo-store', '.cache']);
/** Local-only term policy files are never scanned (they are internal evidence, not release text). */
const LOCAL_ONLY_SUFFIX = '.local.json';
export const RESTRICTED_TERMS_BASENAME = 'restricted-terms.local.json';
export const RESTRICTED_TERMS_RELATIVE_PATH = `scripts/verify/${RESTRICTED_TERMS_BASENAME}`;

/** Fictional demo tokens documented as fictional in the README. */
const DEMO_TOKEN_PATTERN = /demo-[A-Za-z0-9._-]*-token/;
/** Reserved documentation domains: fictional, not real network assets. */
const RESERVED_DOMAIN_PATTERN = /(?:^|[/@.])(?:example\.(?:com|org|net)|localhost|127\.0\.0\.1|0\.0\.0\.0|example\.[a-z.]+)(?::\d+)?(?:[/:?#]|$)/i;

const SECRET_RULES = [
  {
    id: 'aws-access-key',
    description: 'AWS access key id',
    pattern: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA)[0-9A-Z]{16}\b/g,
  },
  {
    id: 'github-token',
    description: 'GitHub token',
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  },
  {
    id: 'openai-key',
    description: 'OpenAI-style API key',
    pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    id: 'google-api-key',
    description: 'Google API key',
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g,
  },
  {
    id: 'slack-token',
    description: 'Slack token',
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  },
  {
    id: 'stripe-live-key',
    description: 'Stripe live key',
    pattern: /\b[sr]k_live_[A-Za-z0-9]{10,}\b/g,
  },
  {
    id: 'private-key-block',
    description: 'PEM private key',
    pattern: /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/g,
  },
  {
    id: 'jwt-token',
    description: 'JSON Web Token',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  },
  {
    id: 'bearer-token-literal',
    description: 'Literal bearer token',
    pattern: /\bBearer\s+(?!\$|\{|<)[A-Za-z0-9._~+/=-]{16,}/g,
  },
  {
    id: 'hardcoded-credential',
    description: 'Hardcoded credential-like assignment',
    pattern: /\b(?:password|passwd|secret|api[_-]?key|apikey|client[_-]?secret|access[_-]?token|refresh[_-]?token|auth[_-]?token)\b\s*[:=]\s*["'`][^"'`\n]{6,}["'`]/gi,
    matchGroup: 0,
  },
];

// Generic, non-proprietary business-material detector: a generic business-logic policy with no
// private vocabulary. It flags internal business artifacts whose marker words indicate
// restricted distribution (for example a notice of restricted distribution on a brief).
const GENERIC_BUSINESS_PATTERN =
  /\b(?:confidential|proprietary|internal[- ]only|do[- ]not[- ]publish|trade[- ]secret)\b[-_ /]*(?:prompts?|briefs?|scripts?|treatments?|episodes?|production|campaigns?|monetization|storyboards?|assets?)\b|\b(?:monetization|campaign|launch|commercial)[-_ ](?:plan|brief|strategy)\b/gi;

const REAL_IDENTIFIER_PATTERNS = [
  {
    id: 'real-run-identifier',
    description: 'Real-looking project/run UUID (not a fictional placeholder)',
    pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
  },
];
const BINARY_ASSET_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.tiff',
  '.mp4', '.mov', '.webm', '.avi', '.mkv',
  '.mp3', '.wav', '.m4a', '.aac', '.flac',
  '.pdf', '.zip', '.tar', '.gz', '.7z',
]);

const REFERENCE_RULES = [
  {
    id: 'absolute-user-path',
    description: 'Absolute developer/home path',
    pattern: /(?:\/Users\/[A-Za-z0-9._-]+|\/home\/[A-Za-z0-9._-]+|\/private\/var\/folders\/)/g,
  },
  {
    id: 'private-url',
    description: 'IP-literal / credentialed / private-network URL',
    pattern: /\bhttps?:\/\/[^\s"'`<>)]*/g,
    hostOnly: true,
  },
  {
    id: 'email-address',
    description: 'Email address (PII)',
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  },
  {
    id: 'real-asset-reference',
    description: 'Real (non-fictional) media asset URL',
    pattern: /\bhttps?:\/\/[^\s"'`<>)]+\.(?:png|jpe?g|gif|webp|svg|mp4|mov|webm|mp3|wav|m4a|aac)(?:[?#][^\s"'`<>)]*)?/gi,
  },
  {
    id: 'generic-business-material',
    description: 'Generic confidential/internal business-material reference',
    pattern: GENERIC_BUSINESS_PATTERN,
  },
  ...REAL_IDENTIFIER_PATTERNS,
];

/**
 * Read and compile the optional local-only restricted-term policy.
 * Missing file => available:false, generic-only scan. Malformed file => throw (fail closed).
 *
 * @returns {{
 *   loaded: boolean,
 *   path: string,
 *   ruleIds: string[],
 *   rules: object[],
 *   provenanceReferenceFiles: string[],
 *   provenanceEnumerationFiles: string[]
 * }}
 */
export function loadRestrictedTerms() {
  const filePath = path.join(path.dirname(fileURLToPath(import.meta.url)), RESTRICTED_TERMS_BASENAME);
  const empty = {
    loaded: false,
    path: RESTRICTED_TERMS_RELATIVE_PATH,
    ruleIds: [],
    rules: [],
    provenanceReferenceFiles: [],
    provenanceEnumerationFiles: [],
  };
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return empty;
    throw new Error(`restricted-terms.local.json could not be read: ${error?.message ?? error}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('restricted-terms.local.json is not valid JSON (fail closed)');
  }
  if (!parsed || typeof parsed !== 'object' || parsed.version !== 1 || !Array.isArray(parsed.rules)) {
    throw new Error('restricted-terms.local.json has an unsupported shape (fail closed)');
  }
  const rules = parsed.rules.map((rule, index) => {
    if (
      !rule ||
      typeof rule.id !== 'string' ||
      rule.id.length === 0 ||
      typeof rule.description !== 'string' ||
      typeof rule.pattern !== 'string' ||
      rule.pattern.length === 0
    ) {
      throw new Error(`restricted-terms.local.json rule #${index} is invalid (fail closed)`);
    }
    let pattern;
    try {
      pattern = new RegExp(rule.pattern, typeof rule.flags === 'string' ? rule.flags : 'g');
    } catch (error) {
      throw new Error(`restricted-terms.local.json rule ${rule.id} has an invalid pattern: ${error.message}`);
    }
    return {
      id: rule.id,
      description: rule.description,
      pattern,
      provenanceReferenceAllowlist: rule.provenanceReferenceAllowlist === true,
      provenanceEnumerationAllowlist: rule.provenanceEnumerationAllowlist === true,
      restricted: true,
    };
  });
  return {
    loaded: true,
    path: RESTRICTED_TERMS_RELATIVE_PATH,
    ruleIds: rules.map((rule) => rule.id),
    rules,
    provenanceReferenceFiles: Array.isArray(parsed.provenanceReferenceFiles) ? parsed.provenanceReferenceFiles : [],
    provenanceEnumerationFiles: Array.isArray(parsed.provenanceEnumerationFiles) ? parsed.provenanceEnumerationFiles : [],
  };
}

function isTextFile(filePath) {
  const base = path.basename(filePath);
  const ext = path.extname(filePath).toLowerCase();
  if (TEXT_EXTENSIONS.has(ext)) return true;
  if (base.startsWith('.env')) return true;
  if (['.gitignore', 'LICENSE', 'README', 'Dockerfile', 'Makefile'].includes(base)) return true;
  return false;
}

function walkFiles(root, relativeDir, out) {
  const absoluteDir = path.join(root, relativeDir);
  let entries;
  try {
    entries = fs.readdirSync(absoluteDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIR_NAMES.has(entry.name)) continue;
    if (entry.isDirectory()) {
      walkFiles(root, path.join(relativeDir, entry.name), out);
    } else if (entry.isFile()) {
      if (entry.name.endsWith(LOCAL_ONLY_SUFFIX)) continue; // internal local policy/evidence files
      out.push(path.join(relativeDir, entry.name));
    }
  }
}

function lineNumberFor(text, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

function lineTextFor(text, index) {
  const start = text.lastIndexOf('\n', index - 1) + 1;
  const end = text.indexOf('\n', index);
  return text.slice(start, end === -1 ? text.length : end).trim();
}

function mask(value) {
  const text = String(value);
  if (text.length <= 8) return '*'.repeat(text.length);
  return `${text.slice(0, 6)}…${text.slice(-2)}`;
}

function allowlistReason(ruleId, matchText, contextText, relativeFile, rule, restrictedTerms) {
  if (DEMO_TOKEN_PATTERN.test(matchText) || (contextText && DEMO_TOKEN_PATTERN.test(contextText))) {
    return 'fictional demo-*-token documented in README';
  }
  if (ruleId === 'email-address' && RESERVED_DOMAIN_PATTERN.test(matchText)) {
    return 'reserved documentation domain (fictional)';
  }
  if (ruleId === 'private-url') {
    if (RESERVED_DOMAIN_PATTERN.test(matchText)) return 'reserved documentation domain / loopback address';
    return null;
  }
  if (ruleId === 'real-asset-reference' && RESERVED_DOMAIN_PATTERN.test(matchText)) {
    return 'reserved documentation domain (fictional fixture asset)';
  }
  if (ruleId === 'hardcoded-credential') {
    if (/\b(?:your[-_]|changeme|placeholder|todo|example|fake|dummy|test|x{3,})/i.test(matchText)) {
      return 'placeholder value, not a real credential';
    }
    if (/\$\{|\$[A-Z_]+|<[^>]+>/.test(matchText)) return 'environment variable placeholder';
  }
  if (rule && rule.provenanceReferenceAllowlist && restrictedTerms.provenanceReferenceFiles.includes(relativeFile)) {
    return `explicit provenance reference in provenance document ${relativeFile}`;
  }
  if (rule && rule.provenanceEnumerationAllowlist && restrictedTerms.provenanceEnumerationFiles.includes(relativeFile)) {
    return `removed/omitted upstream structure enumerated in provenance document ${relativeFile}`;
  }
  return null;
}

function scanFile(root, relativeFile, allRules, restrictedTerms) {
  const absolute = path.join(root, relativeFile);
  const findings = [];
  let text;
  try {
    const stat = fs.statSync(absolute);
    if (stat.size > 2 * 1024 * 1024) return findings;
    text = fs.readFileSync(absolute, 'utf8');
    if (text.includes('\u0000')) return findings; // binary
  } catch {
    return findings;
  }

  const base = path.basename(relativeFile);
  if (base.startsWith('.env') && !base.endsWith('.example') && !base.endsWith('.sample')) {
    findings.push({
      file: relativeFile,
      line: 1,
      ruleId: 'env-file',
      description: 'committed .env file',
      match: base,
      allowlisted: false,
      reason: null,
    });
  }

  for (const rule of allRules) {
    const regex = new RegExp(rule.pattern.source, rule.pattern.flags);
    let match;
    while ((match = regex.exec(text)) !== null) {
      const matchText = match[0];
      if (matchText.length === 0) {
        regex.lastIndex += 1;
        continue;
      }
      if (rule.hostOnly) {
        // Only report URLs that embed credentials, IP literals or private-network hosts.
        const url = matchText;
        const isCredentialed = /^https?:\/\/[^/\s:@]+:[^/\s@]+@/i.test(url);
        const hasIpLiteral = /^https?:\/\/\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?(?:[/?#]|$)/i.test(url);
        const isPrivateNetwork = /^https?:\/\/[^/\s]*(?:\.internal|\.local|\.lan|\.corp)(?::\d+)?(?:[/?#]|$)/i.test(url);
        if (!isCredentialed && !hasIpLiteral && !isPrivateNetwork) continue;
      }
      const line = lineNumberFor(text, match.index);
      const context = lineTextFor(text, match.index);
      const reason = allowlistReason(rule.id, matchText, context, relativeFile, rule, restrictedTerms);
      findings.push({
        file: relativeFile,
        line,
        ruleId: rule.id,
        description: rule.description,
        match: mask(matchText),
        allowlisted: reason !== null,
        reason,
        context: context.length > 160 ? `${context.slice(0, 160)}…` : context,
      });
    }
  }
  return findings;
}

/**
 * Scan the publishable tree of `root`. Returns a structured, JSON-serialisable report.
 *
 * @param {string} [root] directory to scan
 * @param {object} [options]
 * @param {object} [options.restrictedTerms] pre-loaded restricted terms (tests); default loads
 *   the optional local-only policy file next to this script
 */
export function scanRepository(root = process.cwd(), options = {}) {
  const absoluteRoot = path.resolve(root);
  const restrictedTerms = options.restrictedTerms ?? loadRestrictedTerms();
  const allRules = [...SECRET_RULES, ...REFERENCE_RULES, ...(restrictedTerms.rules ?? [])];
  const files = [];
  for (const dir of SCAN_DIRS) walkFiles(absoluteRoot, dir, files);
  for (const file of SCAN_FILES) {
    if (fs.existsSync(path.join(absoluteRoot, file))) files.push(file);
  }
  for (const file of fs.readdirSync(absoluteRoot)) {
    if (/^README/i.test(file) && !files.includes(file)) files.push(file);
  }
  const textFiles = [...new Set(files)].filter((file) => isTextFile(path.join(absoluteRoot, file))).sort();

  const findings = [];
  for (const file of textFiles) findings.push(...scanFile(absoluteRoot, file, allRules, restrictedTerms));

  // Binary/real asset files are never acceptable in the release surface.
  for (const file of files) {
    const extension = path.extname(file).toLowerCase();
    if (BINARY_ASSET_EXTENSIONS.has(extension)) {
      findings.push({
        file,
        line: 1,
        ruleId: 'binary-asset',
        description: 'binary/real asset file in the release surface',
        match: path.basename(file),
        allowlisted: false,
        reason: null,
      });
    }
  }

  const failures = findings.filter((finding) => !finding.allowlisted);
  const allowlisted = findings.filter((finding) => finding.allowlisted);
  return {
    generatedAt: new Date().toISOString(),
    root: absoluteRoot,
    filesScanned: textFiles.length,
    restrictedTerms: {
      loaded: restrictedTerms.loaded === true,
      path: restrictedTerms.path ?? RESTRICTED_TERMS_RELATIVE_PATH,
      ruleIds: [...(restrictedTerms.ruleIds ?? [])],
    },
    scannedPaths: SCAN_DIRS.filter((dir) => fs.existsSync(path.join(absoluteRoot, dir))).concat(
      SCAN_FILES.filter((file) => fs.existsSync(path.join(absoluteRoot, file))),
    ),
    findings,
    allowlisted,
    counts: {
      total: findings.length,
      failures: failures.length,
      allowlisted: allowlisted.length,
    },
    result: failures.length === 0 ? 'CLEAN' : 'FINDINGS',
  };
}

function printHumanReport(report) {
  console.log(`# scan-secrets: ${report.root}`);
  console.log(`# scanned ${report.filesScanned} text files in: ${report.scannedPaths.join(', ')}`);
  if (report.restrictedTerms.loaded) {
    console.log(
      `# restricted terms: loaded ${report.restrictedTerms.ruleIds.length} local-only rules from ${report.restrictedTerms.path} (strict internal policy)`,
    );
  } else {
    console.log(
      `# restricted terms: ${report.restrictedTerms.path} absent — GENERIC-ONLY scan (degraded mode: local-only private/business rules not active)`,
    );
  }
  if (report.findings.length === 0) {
    console.log('OK   no secret/PII/private-reference/generic-business findings');
  } else {
    const rows = report.findings.map((finding) => ({
      status: finding.allowlisted ? 'OK  ' : 'FAIL',
      location: `${finding.file}:${finding.line}`,
      rule: finding.ruleId,
      match: finding.match,
      note: finding.allowlisted ? finding.reason : finding.description,
    }));
    const widths = {
      status: 4,
      location: Math.max(8, ...rows.map((row) => row.location.length)),
      rule: Math.max(4, ...rows.map((row) => row.rule.length)),
      match: Math.max(5, ...rows.map((row) => row.match.length)),
    };
    console.log(`${'STATUS'.padEnd(widths.status)}  ${'LOCATION'.padEnd(widths.location)}  ${'RULE'.padEnd(widths.rule)}  ${'MATCH'.padEnd(widths.match)}  NOTE`);
    for (const row of rows) {
      console.log(
        `${row.status.padEnd(widths.status)}  ${row.location.padEnd(widths.location)}  ${row.rule.padEnd(widths.rule)}  ${row.match.padEnd(widths.match)}  ${row.note}`,
      );
    }
  }
  const { total, failures, allowlisted } = report.counts;
  console.log(`SUMMARY files=${report.filesScanned} findings=${total} failures=${failures} allowlisted=${allowlisted}`);
  console.log(`RESULT ${report.result}`);
}

function parseArgs(argv) {
  const options = { json: false, root: process.cwd(), requireRestricted: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') options.json = true;
    else if (arg === '--root') options.root = argv[++i];
    else if (arg === '--require-restricted') options.requireRestricted = true;
    else if (arg === '--help' || arg === '-h') {
      console.log('usage: node scripts/verify/scan-secrets.mjs [--json] [--root <dir>] [--require-restricted]');
      process.exit(0);
    } else {
      console.error(`unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const root = options.root ? path.resolve(options.root) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  let report;
  try {
    report = scanRepository(root);
  } catch (error) {
    console.error(`scan-secrets: ${error.message}`);
    process.exit(3);
    return;
  }
  if (options.requireRestricted && !report.restrictedTerms.loaded) {
    console.error(
      `scan-secrets: --require-restricted used but ${report.restrictedTerms.path} is absent (fail closed)`,
    );
    process.exit(3);
    return;
  }
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    printHumanReport(report);
  }
  process.exit(report.counts.failures === 0 ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
