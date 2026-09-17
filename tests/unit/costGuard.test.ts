import { describe, it, expect } from 'vitest';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import {
  validateWorkflows,
  splitTopLevelJobs,
  validateRunnerLabel,
  evaluateSchedulePolicy,
  stripYamlComments,
  SCHEDULED_WORKFLOW_ALLOWLIST,
  WEEKLY_CRON_RE,
} from '../../scripts/validate-github-cost.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('GitHub Cost Guard Validator (Phase 6.6C)', () => {
  it('splitTopLevelJobs: correctly parses top-level jobs and blocks from workflow YAML', () => {
    const yaml = `
name: Test Workflow
on: [push]
jobs:
  job_one:
    runs-on: ubuntu-latest
    timeout-minutes: 10
  job_two:
    uses: ./.github/workflows/reusable.yml
`;
    const jobs = splitTopLevelJobs(yaml);
    expect(jobs).toHaveLength(2);
    expect(jobs[0].name).toBe('job_one');
    expect(jobs[1].name).toBe('job_two');
  });

  it('validateRunnerLabel: allows approved standard Linux runners', () => {
    const errors: string[] = [];
    validateRunnerLabel('.github/workflows/test.yml', 'ubuntu-latest', errors);
    validateRunnerLabel('.github/workflows/test.yml', 'ubuntu-24.04', errors);
    validateRunnerLabel('.github/workflows/test.yml', 'ubuntu-22.04', errors);
    expect(errors).toHaveLength(0);
  });

  it('validateRunnerLabel: rejects self-hosted and non-approved runner labels (macOS, Windows)', () => {
    const errors: string[] = [];
    validateRunnerLabel('.github/workflows/test.yml', 'self-hosted', errors);
    validateRunnerLabel('.github/workflows/test.yml', 'macos-latest', errors);
    validateRunnerLabel('.github/workflows/test.yml', 'windows-latest', errors);
    expect(errors.length).toBeGreaterThanOrEqual(3);
    expect(errors[0]).toContain('self-hosted runner is prohibited');
    expect(errors[1]).toContain('not an approved standard Linux runner');
    expect(errors[2]).toContain('not an approved standard Linux runner');
  });

  it('validateRunnerLabel: rejects dynamic ${{ matrix.runner }} runners', () => {
    const errors: string[] = [];
    validateRunnerLabel('.github/workflows/test.yml', '${{ matrix.os }}', errors);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('dynamic/expression runner');
  });

  it('Timeout check: rejects job with missing timeout or timeout > 30m, exempts reusable workflows', () => {
    const fixtureDir = path.join(__dirname, 'fixtures_timeout_test');
    fs.mkdirSync(fixtureDir, { recursive: true });
    const fixturePath = path.join(fixtureDir, 'timeouts.yml');

    const yaml = `
name: Timeout Test
on: [push]
jobs:
  no_timeout:
    runs-on: ubuntu-latest
  excessive_timeout:
    runs-on: ubuntu-latest
    timeout-minutes: 45
  reusable_exempt:
    uses: ./.github/workflows/reusable.yml
`;
    fs.writeFileSync(fixturePath, yaml, 'utf-8');

    try {
      const result = validateWorkflows(fixtureDir, fixtureDir);
      expect(result.passed).toBe(false);
      expect(
        result.errors.some((e) =>
          e.includes('job `no_timeout` has runs-on but no timeout-minutes'),
        ),
      ).toBe(true);
      expect(
        result.errors.some((e) =>
          e.includes('job `excessive_timeout` timeout 45m exceeds maximum allowed 30m'),
        ),
      ).toBe(true);
      expect(result.errors.some((e) => e.includes('reusable_exempt'))).toBe(false);
    } finally {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  it('Per-step retention check: detects upload-artifact step missing retention-days even if another step has retention', () => {
    const fixtureDir = path.join(__dirname, 'fixtures_cost_test');
    fs.mkdirSync(fixtureDir, { recursive: true });
    const fixturePath = path.join(fixtureDir, 'multi_upload.yml');

    const multiUploadYaml = `
name: Multi Upload Test
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/upload-artifact@v4
        with:
          name: artifact-one
          path: ./dist
          retention-days: 7
      - uses: actions/upload-artifact@v4
        with:
          name: artifact-two
          path: ./logs
`;
    fs.writeFileSync(fixturePath, multiUploadYaml, 'utf-8');

    try {
      const result = validateWorkflows(fixtureDir, fixtureDir);
      expect(result.passed).toBe(false);
      expect(result.errors.some((e) => e.includes('missing retention-days setting'))).toBe(true);
    } finally {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  it('Prohibited triggers & cache & registry & Docker & GHCR check', () => {
    const fixtureDir = path.join(__dirname, 'fixtures_prohibited_test');
    fs.mkdirSync(fixtureDir, { recursive: true });
    const fixturePath = path.join(fixtureDir, 'prohibited.yml');

    const yaml = `
name: Prohibited Test
on:
  schedule:
    - cron: '0 0 * * *'
  repository_dispatch:
  workflow_run:
    workflows: ["CI"]
jobs:
  publish:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    permissions:
      id-token: write
      packages: write
    steps:
      - uses: actions/cache@v3
        with:
          path: ~/.npm
          key: cache
      - uses: docker/build-push-action@v5
        with:
          tags: ghcr.io/owner/repo:latest
      - run: npm publish
`;
    fs.writeFileSync(fixturePath, yaml, 'utf-8');

    try {
      const result = validateWorkflows(fixtureDir, fixtureDir);
      expect(result.passed).toBe(false);
      expect(result.errors.some((e) => e.includes('scheduled workflows are prohibited'))).toBe(
        true,
      );
      expect(
        result.errors.some((e) => e.includes('repository_dispatch trigger is prohibited')),
      ).toBe(true);
      expect(result.errors.some((e) => e.includes('workflow_run trigger is prohibited'))).toBe(
        true,
      );
      expect(
        result.errors.some((e) => e.includes('Actions cache requires explicit storage review')),
      ).toBe(true);
      expect(result.errors.some((e) => e.includes('package publishing (packages: write)'))).toBe(
        true,
      );
      expect(result.errors.some((e) => e.includes('docker/build-push-action'))).toBe(true);
      expect(result.errors.some((e) => e.includes('ghcr.io'))).toBe(true);
      expect(result.errors.some((e) => e.includes('npm publish'))).toBe(true);
      expect(result.errors.some((e) => e.includes('id-token: write'))).toBe(true);
    } finally {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
  });
});

describe('QG-14 scheduled-workflow policy (weekly retention exception)', () => {
  const RETENTION_PATH = '.github/workflows/backup-retention.yml';
  const retentionSource = (cron = '30 3 * * 0') => `
name: Backup Retention
on:
  schedule:
    - cron: '${cron}'
  workflow_dispatch:
jobs:
  reap:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - run: python3 ops/backup/reap_retention.py --environment staging
`;

  // --- §11 D: weekly schedule PASSES -------------------------------------
  it('D: allows the exact retention workflow on a weekly cron', () => {
    expect(evaluateSchedulePolicy(RETENTION_PATH, retentionSource('30 3 * * 0'))).toEqual([]);
  });

  // --- §11 E/F: daily and hourly FAIL ------------------------------------
  it('E: rejects a DAILY cron even for the allowlisted workflow', () => {
    const errs = evaluateSchedulePolicy(RETENTION_PATH, retentionSource('30 3 * * *'));
    expect(errs.length).toBe(1);
    expect(errs[0]).toContain('must be weekly');
  });

  it('F: rejects an HOURLY cron even for the allowlisted workflow', () => {
    expect(evaluateSchedulePolicy(RETENTION_PATH, retentionSource('0 * * * *'))[0]).toContain(
      'must be weekly',
    );
  });

  it('F2: rejects sub-hourly step syntax such as */5 * * * *', () => {
    expect(evaluateSchedulePolicy(RETENTION_PATH, retentionSource('*/5 * * * *'))[0]).toContain(
      'must be weekly',
    );
    expect(WEEKLY_CRON_RE.test('*/5 * * * *')).toBe(false);
    expect(WEEKLY_CRON_RE.test('30 3 * * 0')).toBe(true);
  });

  it('F3: rejects twice-weekly and multi-cron declarations', () => {
    expect(evaluateSchedulePolicy(RETENTION_PATH, retentionSource('30 3 * * 0,3'))[0]).toContain(
      'must be weekly',
    );
    const twoCrons = retentionSource('30 3 * * 0').replace(
      "- cron: '30 3 * * 0'",
      "- cron: '30 3 * * 0'\n    - cron: '30 4 * * 3'",
    );
    expect(evaluateSchedulePolicy(RETENTION_PATH, twoCrons)[0]).toContain('exactly one schedule');
  });

  // --- §11 G/H/I: everything else still FAILS ----------------------------
  it('G: an arbitrary scheduled workflow is still prohibited, even weekly', () => {
    const errs = evaluateSchedulePolicy('.github/workflows/nightly-thing.yml', retentionSource());
    expect(errs[0]).toContain('scheduled workflows are prohibited');
  });

  it('H: an unauthorized deploy workflow is prohibited, and deploy authority disqualifies', () => {
    expect(
      evaluateSchedulePolicy('.github/workflows/deploy-weekly.yml', retentionSource())[0],
    ).toContain('scheduled workflows are prohibited');

    for (const [capability, line] of [
      ['deployment', 'railway up'],
      ['migration', 'npm run migrate'],
      ['MetaAPI', 'curl https://metaapi.cloud/x'],
      ['worker', 'npm run start:worker'],
    ] as const) {
      const src = retentionSource().replace(
        '      - run: python3',
        `      - run: ${line}\n      - run: python3`,
      );
      const errs = evaluateSchedulePolicy(RETENTION_PATH, src);
      expect(errs.some((e) => e.includes(`no ${capability} authority`))).toBe(true);
    }
  });

  it('I: the allowlist is path-exact — a renamed copy is rejected', () => {
    expect(SCHEDULED_WORKFLOW_ALLOWLIST.size).toBe(1);
    expect(SCHEDULED_WORKFLOW_ALLOWLIST.has(RETENTION_PATH)).toBe(true);
    expect(
      evaluateSchedulePolicy('.github/workflows/backup-retention-copy.yml', retentionSource())[0],
    ).toContain('scheduled workflows are prohibited');
  });

  it('comment prose can neither grant nor revoke the exception', () => {
    expect(stripYamlComments('a: 1 # railway up\n# metaapi\nb: 2')).not.toContain('railway up');
    expect(stripYamlComments("a: '# not a comment'")).toContain('# not a comment');
    // a workflow whose ONLY mention of deployment is prose stays allowed
    const prose = '# This never calls railway up and never touches MetaAPI.\n' + retentionSource();
    expect(evaluateSchedulePolicy(RETENTION_PATH, prose)).toEqual([]);
  });

  it('the real repository workflow set passes QG-14 end to end', () => {
    const result = validateWorkflows();
    expect(result.errors).toEqual([]);
    expect(result.passed).toBe(true);
  });
});
