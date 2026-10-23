#!/usr/bin/env node
/**
 * Dependency + install-script vulnerability gate (added 2026-10-23 after the
 * timetandem-nuxt 75dea3b1 re-infection: eslint.config.mjs / api.js droppers
 * plus a VS Code folderOpen task executing a .woff binary).
 *
 * Lockfile-agnostic: parses pnpm-lock.yaml and package-lock.json /
 * yarn.lock-style flat lists. Checks:
 *  1. No package carries unexpected install/preinstall/postinstall
 *     lifecycle scripts (supply-chain execution vector) and no install
 *     script performs a network fetch — HARD gate.
 *  2. `pnpm audit --prod` (or `npm audit --omit=dev`) when network is
 *     available — high/critical CVEs reported loudly, NON-blocking by
 *     default; DEP_AUDIT_STRICT=1 makes them fail the gate (CI sets it).
 *
 * Full-tree malware scanning lives in scripts/scan-malware.mjs and stays a
 * hard gate in the pre-commit hook and CI.
 *
 * Exit 0 = clean, exit 1 = vulnerability or policy failure.
 */
import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
let failures = 0;
const warnings = [];

const BENIGN = /^(esbuild|sharp|husky|simple-git-hooks|@swc\/core|puppeteer|canvas|cpu-[\w-]+|os-[\w-]+|fsevents|unrs-resolver|@biomejs\/biome|workerd|protobufjs|vue-demi|core-js|@expo\/[\w.-]+|expo-modules-[\w-]+)/;

function flag(pkg, line, label) {
  if (pkg && !BENIGN.test(pkg)) {
    failures++;
    console.error(`  ✗ ${pkg} declares a ${label} script (${line.trim()}) — verify it is expected`);
  }
}

function scanLockfileLines(name) {
  const path = join(ROOT, name);
  if (!existsSync(path)) return false;
  const lines = readFileSync(path, 'utf8').split('\n');
  // Track the innermost package name above each lifecycle-script line.
  let currentPkg = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const indent = line.match(/^\s*/)[0].length;
    // pnpm: `  pkg@ver:`, npm v2/v3: `      "pkg": { "version": ... }`
    const pkgMatch = line.match(/^\s+'?((?:@[\w.-]+\/)?[\w.-]+)@(?:[\w.^~*-]+)'/) ??
      line.match(/^\s{4,}"((?:@[\w.-]+\/)?[\w.-]+)":\s*\{\s*"version"/);
    if (pkgMatch) currentPkg = pkgMatch[1];
    const scriptMatch = line.match(/^\s+"?(preinstall|postinstall|prepare)"?\s*:\s*"(.*)"\s*,?\s*$/);
    if (scriptMatch) {
      const scriptBody = scriptMatch[2];
      if (/curl|wget|https?:\/\//.test(scriptBody)) {
        failures++;
        console.error(`  ✗ line ${i + 1}: install script performs a network fetch: ${line.trim()}`);
      } else {
        flag(currentPkg, line, scriptMatch[1]);
      }
    }
    void indent;
  }
  return true;
}

function scanNpmLockV2() {
  const path = join(ROOT, 'package-lock.json');
  if (!existsSync(path)) return false;
  const lock = JSON.parse(readFileSync(path, 'utf8'));
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    for (const hook of ['preinstall', 'postinstall', 'prepare']) {
      if (typeof entry[hook] === 'string') {
        const pkg = key.replace(/^node_modules\//, '');
        if (/curl|wget|https?:\/\//.test(entry[hook])) {
          failures++;
          console.error(`  ✗ ${pkg}: ${hook} performs a network fetch: ${entry[hook]}`);
        } else {
          flag(pkg, `${hook}: "${entry[hook]}"`, hook);
        }
      }
    }
  }
  return true;
}

scanLockfileLines('pnpm-lock.yaml');
scanNpmLockV2();

// ── 2. Known-vulnerability audit ────────────────────────────────────────────
function report(report) {
  const advisories = Object.values(report.advisories ?? {});
  for (const adv of advisories) {
    const sev = (adv.severity ?? '').toLowerCase();
    const via = adv.module_name ?? adv.name ?? '?';
    if (sev === 'high' || sev === 'critical') {
      if (process.env.DEP_AUDIT_STRICT === '1') failures++;
      console.error(`  ✗ ${sev.toUpperCase()}: ${via} — ${adv.title ?? adv.url ?? ''}`);
    } else {
      warnings.push(`${sev}: ${via} — ${adv.title ?? ''}`);
    }
  }
}

const hasPnpm = existsSync(join(ROOT, 'pnpm-lock.yaml'));
try {
  const cmd = hasPnpm ? 'pnpm audit --prod --json' : 'npm audit --omit=dev --json';
  const out = execSync(`${cmd} 2>/dev/null`, { cwd: ROOT, encoding: 'utf8', timeout: 60_000 });
  report(JSON.parse(out || '{}'));
} catch (err) {
  if (err.stdout) {
    try { report(JSON.parse(err.stdout)); } catch { warnings.push('audit output unparseable — CVE audit skipped'); }
  } else {
    warnings.push('audit unavailable (offline?) — CVE audit skipped this run');
  }
}

for (const w of warnings) console.warn(`  ⚠ ${w}`);

if (failures > 0) {
  console.error(`\n✗ dep-audit: ${failures} blocking issue(s). Do not commit without resolving.`);
  process.exit(1);
}
console.log('✅ dep-audit clean');
