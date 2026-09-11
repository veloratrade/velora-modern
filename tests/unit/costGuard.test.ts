import { describe, it, expect } from 'vitest';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import {
  validateWorkflows,
  splitTopLevelJobs,
  validateRunnerLabel,
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
