import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ROOT = path.resolve(__dirname, '..');
const WORKFLOWS_DIR = path.join(ROOT, '.github', 'workflows');

export const ALLOWED_RUNNERS = new Set(['ubuntu-latest', 'ubuntu-24.04', 'ubuntu-22.04']);
export const MAX_ARTIFACT_RETENTION_DAYS = 14;
export const ALLOWED_WRITE_PERMISSIONS = new Set<string>(); // None required by default

// ---------------------------------------------------------------------------
// QG-14 scheduled-workflow policy
// ---------------------------------------------------------------------------
// Scheduled workflows remain PROHIBITED BY DEFAULT. This is a single, narrow,
// fail-closed exception: the Backup Retention maintenance workflow may run once
// every 7 days because it performs retention maintenance only and holds no
// deployment, migration, MetaAPI or worker authority.
//
// This is deliberately NOT a general "allow schedules" flag. A workflow earns
// the exception only if it satisfies EVERY condition below; any failure falls
// straight back to the default prohibition.
//
//   1. identity     — exact path match against SCHEDULED_WORKFLOW_ALLOWLIST
//   2. frequency    — exactly one schedule, and that cron must be weekly
//   3. authority    — no deploy/migration/Railway/MetaAPI/worker capability
//
// Weekly-only is enforced structurally by WEEKLY_CRON_RE rather than by
// blacklisting daily/hourly forms, so unanticipated high-frequency spellings
// (`*/5 * * * *`, `0 * * * *`, `30 3 * * *`, multiple crons) fail closed.
export const SCHEDULED_WORKFLOW_ALLOWLIST = new Set(['.github/workflows/backup-retention.yml']);

// A weekly cron: fixed minute, fixed hour, every day-of-month, every month,
// and exactly one fixed day-of-week. `30 3 * * 0` matches; `30 3 * * *`
// (daily), `0 * * * 0` (hourly), `30 3 * * 0,3` (twice weekly) and any
// step/range form such as `*/10` or `1-5` do not.
export const WEEKLY_CRON_RE = /^\s*(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+([0-7])\s*$/;

// Capabilities that disqualify a workflow from the scheduled-maintenance
// exception. Matched against the workflow source with comments stripped, so
// prose explaining why a capability is absent can never grant the exception.
export const SCHEDULE_DISQUALIFYING_CAPABILITIES: Array<{ label: string; re: RegExp }> = [
  { label: 'deployment', re: /railway\s+up|@railway\/cli|railway\s+link|\bnpm\s+run\s+deploy\b/i },
  { label: 'migration', re: /\bmigrate\b|\bmigration\b|roles\.sql/i },
  { label: 'MetaAPI', re: /metaapi|agiliumtrade/i },
  { label: 'worker', re: /start:worker|apps\/worker/i },
];

/** Strip full-line and trailing `#` comments so prose cannot satisfy a check. */
export function stripYamlComments(source: string): string {
  return source
    .split('\n')
    .map((line) => {
      let inSingle = false;
      let inDouble = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === "'" && !inDouble) inSingle = !inSingle;
        else if (ch === '"' && !inSingle) inDouble = !inDouble;
        else if (ch === '#' && !inSingle && !inDouble) return line.slice(0, i);
      }
      return line;
    })
    .join('\n');
}

/**
 * Decide whether a scheduled workflow is covered by the narrow retention
 * exception. Returns the policy errors; an empty array means "allowed".
 * Fail-closed: anything unrecognised produces the default prohibition error.
 */
export function evaluateSchedulePolicy(relPath: string, source: string): string[] {
  const normalised = relPath.split(path.sep).join('/');
  const prohibition = `${relPath}: scheduled workflows are prohibited; use explicit manual/push policy`;

  if (!SCHEDULED_WORKFLOW_ALLOWLIST.has(normalised)) {
    return [prohibition];
  }

  const code = stripYamlComments(source);
  const crons = Array.from(code.matchAll(/^\s*-\s*cron:\s*['"]?([^'"#\n]+?)['"]?\s*$/gm)).map((m) =>
    m[1].trim(),
  );

  if (crons.length !== 1) {
    return [
      `${relPath}: allowlisted maintenance workflow must declare exactly one schedule (found ${crons.length})`,
    ];
  }
  if (!WEEKLY_CRON_RE.test(crons[0])) {
    return [
      `${relPath}: allowlisted maintenance schedule must be weekly (once per 7 days); found cron '${crons[0]}'`,
    ];
  }

  const errors: string[] = [];
  for (const cap of SCHEDULE_DISQUALIFYING_CAPABILITIES) {
    if (cap.re.test(code)) {
      errors.push(
        `${relPath}: allowlisted maintenance workflow must hold no ${cap.label} authority`,
      );
    }
  }
  return errors;
}

export interface CostGuardResult {
  passed: boolean;
  errors: string[];
  runnerCount: number;
  artifactCount: number;
  realJobCount: number;
  workflowCount: number;
}

export function splitTopLevelJobs(source: string): Array<{ name: string; block: string }> {
  const jobsMatch = source.match(/^jobs:\s*$([\s\S]*)/m);
  if (!jobsMatch) return [];

  const body = jobsMatch[1];
  const nameMatches = Array.from(body.matchAll(/^ {2}([A-Za-z0-9_-]+):\s*$/gm));
  const blocks: Array<{ name: string; block: string }> = [];

  for (let i = 0; i < nameMatches.length; i++) {
    const name = nameMatches[i][1];
    const startIndex = nameMatches[i].index!;
    const nextIndex = i + 1 < nameMatches.length ? nameMatches[i + 1].index! : body.length;
    const block = body.substring(startIndex, nextIndex);
    blocks.push({ name, block });
  }

  return blocks;
}

export function validateRunnerLabel(relPath: string, rawLabel: string, errors: string[]): number {
  const value = rawLabel.trim();

  if (value.includes('${{')) {
    errors.push(
      `${relPath}: dynamic/expression runner \`${value}\` cannot be verified; pin an approved standard Linux label`,
    );
    return 1;
  }

  if (value.startsWith('[') || value.startsWith('{')) {
    const inner = value.replace(/^\[|\{|\]|\}$/g, '').trim();
    const parts = inner
      .split(',')
      .map((p) => p.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
    const low = parts.join(' ').toLowerCase();

    if (low.includes('self-hosted')) {
      errors.push(`${relPath}: self-hosted runner form \`${value}\` is prohibited by policy`);
      return 1;
    }

    for (const p of parts) {
      if (p && !ALLOWED_RUNNERS.has(p)) {
        errors.push(
          `${relPath}: runner array element \`${p}\` in \`${value}\` is not an approved standard Linux runner`,
        );
      }
    }
    return 1;
  }

  if (value.startsWith('group:') || value.startsWith('labels:')) {
    errors.push(`${relPath}: runner group/labels form \`${value}\` is prohibited by policy`);
    return 1;
  }

  const label = value.replace(/^['"]|['"]$/g, '').trim();
  if (label.toLowerCase() === 'self-hosted') {
    errors.push(`${relPath}: self-hosted runner is prohibited by policy`);
    return 1;
  }

  if (!ALLOWED_RUNNERS.has(label)) {
    errors.push(`${relPath}: runner \`${label}\` is not an approved standard Linux runner`);
  }

  return 1;
}

export function validateWorkflows(
  workflowsDir: string = WORKFLOWS_DIR,
  rootDir: string = ROOT,
): CostGuardResult {
  const errors: string[] = [];
  let runnerCount = 0;
  let artifactCount = 0;
  let realJobCount = 0;
  let workflowCount = 0;

  if (!fs.existsSync(workflowsDir)) {
    return {
      passed: true,
      errors: [],
      runnerCount: 0,
      artifactCount: 0,
      realJobCount: 0,
      workflowCount: 0,
    };
  }

  const files = fs
    .readdirSync(workflowsDir)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
  workflowCount = files.length;

  for (const file of files) {
    const filePath = path.join(workflowsDir, file);
    const source = fs.readFileSync(filePath, 'utf-8');
    const relPath = path.relative(rootDir, filePath);

    // 1. Runner labels
    const runsOnMatches = Array.from(source.matchAll(/^\s*runs-on:\s*(\[[^\]]*\]|[^#\n]+)/gm));
    for (const match of runsOnMatches) {
      runnerCount += validateRunnerLabel(relPath, match[1], errors);
    }

    if (/^\s*runs-on:\s*$/im.test(source) && /^\s*(group|labels):\s/im.test(source)) {
      errors.push(`${relPath}: runner group/labels map form is prohibited by policy`);
    }

    // 2. Prohibited triggers
    // Scheduled workflows are prohibited by default. `evaluateSchedulePolicy`
    // grants one narrow, fail-closed exception (see its comment block) for the
    // weekly Backup Retention maintenance workflow; everything else still fails.
    if (/^\s*schedule:\s*$|^\s*-\s*cron:\s*/im.test(source)) {
      errors.push(...evaluateSchedulePolicy(relPath, source));
    }
    if (/^\s*repository_dispatch:\s*/im.test(source)) {
      errors.push(`${relPath}: repository_dispatch trigger is prohibited`);
    }
    if (/^\s*workflow_run:\s*/im.test(source)) {
      errors.push(`${relPath}: workflow_run trigger is prohibited`);
    }

    // 3. Cache
    if (/actions\/cache@|cache:\s*(?:npm|pip|composer|gradle|yarn|maven)/i.test(source)) {
      errors.push(`${relPath}: Actions cache requires explicit storage review`);
    }

    // 4. Packages / publishing / registry
    if (/^\s*packages:\s*write\s*$/im.test(source)) {
      errors.push(
        `${relPath}: package publishing (packages: write) requires explicit billing review`,
      );
    }
    if (/docker\/build-push-action/i.test(source)) {
      errors.push(
        `${relPath}: docker/build-push-action (image publishing) requires explicit review`,
      );
    }
    if (/docker\/login-action/i.test(source)) {
      errors.push(`${relPath}: docker/login-action (registry login) requires explicit review`);
    }
    if (/ghcr\.io/i.test(source)) {
      errors.push(`${relPath}: GitHub Container Registry (ghcr.io) usage requires explicit review`);
    }
    if (/\bnpm\s+publish\b/i.test(source)) {
      errors.push(`${relPath}: npm publish (package publishing) requires explicit review`);
    }

    // 5. Permissions
    if (/^\s*id-token:\s*write\s*$/im.test(source)) {
      errors.push(`${relPath}: id-token: write (OIDC) requires explicit review`);
    }
    const writePermMatches = Array.from(source.matchAll(/^\s*([a-z-]+):\s*write\s*$/gim));
    for (const pmatch of writePermMatches) {
      const key = pmatch[1].toLowerCase();
      if (key === 'packages' || key === 'id-token') continue;
      if (!ALLOWED_WRITE_PERMISSIONS.has(key)) {
        errors.push(`${relPath}: unexpected write permission \`${key}: write\` (least-privilege)`);
      }
    }

    // 6. Per-Step Artifact retention check
    const uploadMatches = Array.from(source.matchAll(/actions\/upload-artifact@/gi));
    if (uploadMatches.length > 0) {
      for (const match of uploadMatches) {
        artifactCount++;
        const matchIdx = match.index!;
        // Extract step block following actions/upload-artifact@
        const nextStepMatch = source.substring(matchIdx + 1).match(/\n\s*-\s+(name|uses):/);
        const endStepIdx = nextStepMatch ? matchIdx + 1 + nextStepMatch.index! : source.length;
        const stepBlock = source.substring(matchIdx, endStepIdx);

        const retMatch = stepBlock.match(/^\s*retention-days:\s*(\d+)/m);
        if (!retMatch) {
          errors.push(
            `${relPath}: upload-artifact step present but missing retention-days setting (must be <= ${MAX_ARTIFACT_RETENTION_DAYS})`,
          );
        } else {
          const days = parseInt(retMatch[1], 10);
          if (days > MAX_ARTIFACT_RETENTION_DAYS) {
            errors.push(
              `${relPath}: artifact retention ${days}d exceeds maximum allowed ${MAX_ARTIFACT_RETENTION_DAYS}d`,
            );
          }
        }
      }
    }

    // Standalone retention-days check over cap
    const standaloneRetMatches = Array.from(source.matchAll(/^\s*retention-days:\s*(\d+)/gm));
    for (const match of standaloneRetMatches) {
      if (uploadMatches.length === 0) {
        artifactCount++;
        const days = parseInt(match[1], 10);
        if (days > MAX_ARTIFACT_RETENTION_DAYS) {
          errors.push(
            `${relPath}: artifact retention ${days}d exceeds maximum allowed ${MAX_ARTIFACT_RETENTION_DAYS}d`,
          );
        }
      }
    }

    // 7. Timeout enforcement per REAL job
    const jobs = splitTopLevelJobs(source);
    for (const job of jobs) {
      const hasRunsOn = /^\s{4}runs-on:/m.test(job.block);
      const isReusable = /^\s{4}uses:/m.test(job.block) && !hasRunsOn;
      if (isReusable) continue;

      if (hasRunsOn) {
        realJobCount++;
        const timeoutMatch = job.block.match(/^\s{4}timeout-minutes:\s*(\d+)/m);
        if (!timeoutMatch) {
          errors.push(`${relPath}: job \`${job.name}\` has runs-on but no timeout-minutes`);
        } else {
          const timeoutVal = parseInt(timeoutMatch[1], 10);
          if (timeoutVal > 30) {
            errors.push(
              `${relPath}: job \`${job.name}\` timeout ${timeoutVal}m exceeds maximum allowed 30m`,
            );
          }
        }
      }
    }
  }

  if (workflowCount > 0 && runnerCount === 0) {
    errors.push('no runner declarations found in workflows');
  }

  return {
    passed: errors.length === 0,
    errors,
    runnerCount,
    artifactCount,
    realJobCount,
    workflowCount,
  };
}

export function main(workflowsDir: string = WORKFLOWS_DIR): number {
  const result = validateWorkflows(workflowsDir);

  if (!result.passed) {
    console.log('GITHUB_COST_GUARD_FAIL');
    for (const err of result.errors) {
      console.log(`- ${err}`);
    }
    return 1;
  }

  console.log(
    'GITHUB_COST_GUARD_OK ' +
      `workflows=${result.workflowCount} ` +
      `runners=${result.runnerCount} real_jobs=${result.realJobCount} ` +
      `allowed=${Array.from(ALLOWED_RUNNERS).sort().join(',')} ` +
      `artifact_rules=${result.artifactCount} retention_max=${MAX_ARTIFACT_RETENTION_DAYS}d ` +
      `schedule=default-prohibited(+${SCHEDULED_WORKFLOW_ALLOWLIST.size} weekly-maintenance-allowlisted) ` +
      'repository_dispatch=none workflow_run=none ' +
      'cache=none packages=none docker=none npm_publish=none ' +
      'id_token=none unexpected_writes=none timeouts=enforced',
  );
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  process.exit(main());
}
