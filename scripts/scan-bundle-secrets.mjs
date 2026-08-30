#!/usr/bin/env node
/**
 * Bundle secret scanner — the regression gate for Requirement 1 (Requirements 1.4, 1.5).
 *
 * Walks `.next/static` recursively and fails, naming the matched file, if any
 * `.js` / `.json` build artefact contains:
 *   - the VALUE of any `scope: 'server'` variable declared in ENV_SCHEMA, or
 *   - the literal string `NEXT_PUBLIC_OPENWEATHER_API_KEY`.
 *
 * The matched value is never printed — only the variable name and the file path.
 *
 * Node builtins only. No dependencies.
 *
 * Usage:  node scripts/scan-bundle-secrets.mjs   (run after `next build`)
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCAN_ROOT = join(REPO_ROOT, '.next', 'static');
const SCAN_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.json']);
const ENV_SCHEMA_FILE = join(REPO_ROOT, 'lib', 'env.ts');
const ENV_FILES = ['.env.local', '.env.production.local', '.env.production', '.env'];

/** A value shorter than this is treated as too generic to search for safely. */
const MIN_SECRET_LENGTH = 8;

/** Literal reference that must never appear in build output, key value or not. */
const BANNED_LITERALS = ['NEXT_PUBLIC_OPENWEATHER_API_KEY'];

function fail(message) {
  console.error(`scan-bundle-secrets: FAIL — ${message}`);
  process.exit(1);
}

/**
 * Server-scoped variable names, read straight out of ENV_SCHEMA so this script
 * and the validator cannot drift apart. Values are never read from here.
 */
function serverScopedNames() {
  let source;
  try {
    source = readFileSync(ENV_SCHEMA_FILE, 'utf8');
  } catch {
    fail(`could not read the env schema at ${relative(REPO_ROOT, ENV_SCHEMA_FILE)}`);
  }

  const names = [];
  const entry = /\{\s*name:\s*['"]([A-Z0-9_]+)['"]\s*,\s*scope:\s*['"](server|public)['"]/g;
  let match;
  while ((match = entry.exec(source)) !== null) {
    if (match[2] === 'server') names.push(match[1]);
  }

  if (names.length === 0) {
    fail('found no server-scoped entries in ENV_SCHEMA — the scanner would pass vacuously');
  }
  return names;
}

/** Minimal dotenv reader. Returns a name -> value map; values are never logged. */
function readEnvFiles() {
  const values = new Map();
  for (const file of ENV_FILES) {
    const path = join(REPO_ROOT, file);
    if (!existsSync(path)) continue;
    let text;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const name = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      // Earlier files win, matching Next.js env precedence.
      if (!values.has(name)) values.set(name, value);
    }
  }
  // Real process env takes precedence over any file (CI sets it directly).
  for (const [name, value] of Object.entries(process.env)) {
    if (typeof value === 'string' && value.length > 0) values.set(name, value);
  }
  return values;
}

function looksLikePlaceholder(value) {
  return /^(your_|changeme|placeholder|xxx+$)/i.test(value);
}

function collectFiles(dir, out) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const info = statSync(path);
    if (info.isDirectory()) collectFiles(path, out);
    else if (info.isFile() && SCAN_EXTENSIONS.has(extname(name))) out.push(path);
  }
  return out;
}

function main() {
  if (!existsSync(SCAN_ROOT)) {
    fail('.next/static does not exist — run `next build` before scanning');
  }

  const envValues = readEnvFiles();
  const names = serverScopedNames();

  /** @type {{ label: string, needle: string }[]} */
  const needles = [];
  const skipped = [];

  for (const name of names) {
    const value = envValues.get(name);
    if (!value || value.length < MIN_SECRET_LENGTH || looksLikePlaceholder(value)) {
      skipped.push(name);
      continue;
    }
    needles.push({ label: `${name} (value)`, needle: value });
  }
  for (const literal of BANNED_LITERALS) {
    needles.push({ label: `${literal} (reference)`, needle: literal });
  }

  const files = collectFiles(SCAN_ROOT, []);
  /** @type {{ label: string, file: string }[]} */
  const findings = [];

  for (const file of files) {
    let content;
    try {
      content = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const { label, needle } of needles) {
      if (content.includes(needle)) {
        findings.push({ label, file: relative(REPO_ROOT, file) });
      }
    }
  }

  console.log(
    `scan-bundle-secrets: scanned ${files.length} file(s) under ${relative(REPO_ROOT, SCAN_ROOT)} ` +
      `against ${needles.length} pattern(s) [${names.length} server-scoped variable(s), ` +
      `${BANNED_LITERALS.length} banned literal(s)]`
  );
  if (skipped.length) {
    console.log(
      `scan-bundle-secrets: no usable value configured for ${skipped.join(', ')} — value scan skipped for those names`
    );
  }

  if (findings.length) {
    for (const { label, file } of findings) {
      console.error(`scan-bundle-secrets: FAIL — ${label} found in ${file}`);
    }
    console.error(
      `scan-bundle-secrets: ${findings.length} match(es) in build output. A server-only credential is reachable from the browser.`
    );
    process.exit(1);
  }

  console.log('scan-bundle-secrets: PASS — no server-only credential and no banned reference in build output');
}

main();
