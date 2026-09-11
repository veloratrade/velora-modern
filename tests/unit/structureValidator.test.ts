import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  readBaseline,
  computeLiveStructure,
  evaluateStructureDrift,
  getTrackedFiles,
} from '../../scripts/validate-structure.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '../..');
const BASELINE_PATH = path.join(ROOT, 'docs', 'architecture', 'STRUCTURE_BASELINE.md');

describe('Structure Guard & Baseline Validator (Phase 6.6B)', () => {
  it('Test A — clean baseline: current repository matches baseline', () => {
    const trackedFiles = getTrackedFiles(ROOT);
    const baseline = readBaseline(BASELINE_PATH);
    const drift = evaluateStructureDrift(baseline, trackedFiles);

    expect(drift.hasDrift).toBe(false);
    expect(drift.newTopLevel).toHaveLength(0);
    expect(drift.removedTopLevel).toHaveLength(0);
    expect(drift.newSecondLevel).toHaveLength(0);
    expect(drift.removedSecondLevel).toHaveLength(0);
    expect(drift.missingRequiredFiles).toHaveLength(0);
  });

  it('Test B — new structural directory: detects unindexed top-level directory addition', () => {
    const trackedFiles = [...getTrackedFiles(ROOT), 'unindexed_module/index.ts'];
    const baseline = readBaseline(BASELINE_PATH);
    const drift = evaluateStructureDrift(baseline, trackedFiles);

    expect(drift.hasDrift).toBe(true);
    expect(drift.newTopLevel).toContain('unindexed_module');
  });

  it('Test C — removed structural directory: detects missing baseline top-level directory', () => {
    const trackedFiles = getTrackedFiles(ROOT).filter((f) => !f.startsWith('locales/'));
    const baseline = readBaseline(BASELINE_PATH);
    const drift = evaluateStructureDrift(baseline, trackedFiles);

    expect(drift.hasDrift).toBe(true);
    expect(drift.removedTopLevel).toContain('locales');
  });

  it('Test D — second-level structural drift: detects unindexed key 2nd-level boundary', () => {
    const trackedFiles = [...getTrackedFiles(ROOT), 'src/new_core_subfolder/file.ts'];
    const baseline = readBaseline(BASELINE_PATH);
    const drift = evaluateStructureDrift(baseline, trackedFiles);

    expect(drift.hasDrift).toBe(true);
    expect(drift.newSecondLevel).toContain('src/new_core_subfolder');
  });

  it('Test E — deterministic output: same repository state produces identical representation', () => {
    const trackedFiles = getTrackedFiles(ROOT);
    const live1 = computeLiveStructure(trackedFiles);
    const live2 = computeLiveStructure(trackedFiles);

    expect(live1).toEqual(live2);
  });

  it('Test F — no mutation: running normal validation does not modify baseline file', () => {
    const beforeContent = fs.readFileSync(BASELINE_PATH, 'utf-8');
    const trackedFiles = getTrackedFiles(ROOT);
    const baseline = readBaseline(BASELINE_PATH);
    evaluateStructureDrift(baseline, trackedFiles);
    const afterContent = fs.readFileSync(BASELINE_PATH, 'utf-8');

    expect(beforeContent).toBe(afterContent);
  });
});
