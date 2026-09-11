/**
 * VELORA OPS STATUS — read-only repository + operations posture snapshot.
 *
 * Answers, without mutating anything: which commit is checked out, is the tree
 * clean, which workflows exist and do they pass the cost guard, which npm
 * operational scripts are available, and is the Railway baseline documented.
 * Intended for session bootstrap and pre-dispatch sanity checks.
 *
 * Read-only contract: this script NEVER writes files, NEVER touches the
 * network, and NEVER prints secret values (it only reports the PRESENCE of
 * secret references by name pattern, e.g. `secrets.RAILWAY_TOKEN`).
 *
 * Usage: `npm run ops:status` (human) or
 * `npx tsx scripts/ops-status.ts --json` (machine; npm's own banner lines
 * would otherwise pollute piped stdout).
 */

import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { validateWorkflows } from './validate-github-cost.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

interface OpsStatus {
  generated_at: string;
  git: { head: string; clean: boolean; status_short: string[] };
  node: string;
  workflows: { files: string[]; cost_guard_pass: boolean; cost_errors: string[] };
  scripts: string[];
  railway_baseline_present: boolean;
  secret_refs_by_name: Record<string, string[]>;
}

function git(args: string[]): string {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf-8' }).trim();
  } catch {
    return 'unknown';
  }
}

export function collectStatus(): OpsStatus {
  const head = git(['rev-parse', 'HEAD']);
  const statusOut = git(['status', '--short']);
  const statusShort = statusOut === '' || statusOut === 'unknown' ? [] : statusOut.split('\n');

  const workflowsDir = path.join(ROOT, '.github', 'workflows');
  const files = fs.existsSync(workflowsDir)
    ? fs
        .readdirSync(workflowsDir)
        .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
        .sort()
    : [];
  const cost = validateWorkflows(workflowsDir, ROOT);

  let scripts: string[] = [];
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8')) as {
      scripts?: Record<string, string>;
    };
    scripts = Object.keys(pkg.scripts ?? {}).sort();
  } catch {
    scripts = [];
  }

  // Secret REFERENCES by name only: scan workflow texts for `secrets.NAME`
  // occurrences and report names. Values are never accessible here by design.
  const secretRefsByName: Record<string, string[]> = {};
  for (const file of files) {
    const text = fs.readFileSync(path.join(workflowsDir, file), 'utf-8');
    const names = new Set<string>();
    for (const m of text.matchAll(/secrets\.([A-Z0-9_]+)/g)) {
      names.add(m[1]);
    }
    if (names.size > 0) {
      secretRefsByName[file] = [...names].sort();
    }
  }

  return {
    generated_at: new Date().toISOString(),
    git: { head, clean: statusShort.length === 0, status_short: statusShort.slice(0, 20) },
    node: process.version,
    workflows: { files, cost_guard_pass: cost.passed, cost_errors: cost.errors },
    scripts,
    railway_baseline_present: fs.existsSync(
      path.join(ROOT, 'docs', 'infrastructure', 'railway-baseline.md'),
    ),
    secret_refs_by_name: secretRefsByName,
  };
}

export function main(args: string[] = process.argv.slice(2)): number {
  const status = collectStatus();
  if (args.includes('--json')) {
    console.log(JSON.stringify(status, null, 2));
    return 0;
  }
  console.log(`VELORA OPS STATUS @ ${status.generated_at}`);
  console.log(`  git head : ${status.git.head}`);
  console.log(`  tree     : ${status.git.clean ? 'clean' : 'MODIFIED (see git status)'}`);
  console.log(`  node     : ${status.node}`);
  console.log(
    `  workflows: ${status.workflows.files.length} file(s), ` +
      `cost guard ${status.workflows.cost_guard_pass ? 'PASS' : 'FAIL'}`,
  );
  for (const err of status.workflows.cost_errors) {
    console.log(`    - ${err}`);
  }
  console.log(`  npm scripts: ${status.scripts.join(', ')}`);
  console.log(`  railway baseline doc: ${status.railway_baseline_present ? 'present' : 'MISSING'}`);
  const refFiles = Object.keys(status.secret_refs_by_name);
  console.log(`  secret refs (names only): ${refFiles.length === 0 ? 'none' : ''}`);
  for (const file of refFiles) {
    console.log(`    ${file}: ${status.secret_refs_by_name[file].join(', ')}`);
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  process.exit(main());
}
