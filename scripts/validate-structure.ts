import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

// ESM dirname resolution
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ROOT = path.resolve(__dirname, '..');
const BASELINE_PATH = path.join(ROOT, 'docs', 'architecture', 'STRUCTURE_BASELINE.md');
const BEGIN_MARKER = '<!-- VELORA_STRUCTURE_BASELINE_BEGIN -->';
const END_MARKER = '<!-- VELORA_STRUCTURE_BASELINE_END -->';

export interface StructureBaseline {
  top_level_directories: string[];
  selected_second_level_boundaries: string[];
  required_structural_files: string[];
}

export interface DriftReport {
  hasDrift: boolean;
  newTopLevel: string[];
  removedTopLevel: string[];
  newSecondLevel: string[];
  removedSecondLevel: string[];
  missingRequiredFiles: string[];
}

/**
 * Get all tracked files in the git repository.
 * Falls back to basic filesystem walk if git command is unavailable.
 */
export function getTrackedFiles(root: string = ROOT): string[] {
  try {
    const stdout = execSync('git ls-files', { cwd: root, encoding: 'utf-8', timeout: 10000 });
    return stdout
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  } catch {
    // Fallback if git is unavailable
    const files: string[] = [];
    const walk = (dir: string, rel: string) => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist')
          continue;
        const entryRel = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          walk(path.join(dir, entry.name), entryRel);
        } else {
          files.push(entryRel);
        }
      }
    };
    walk(root, '');
    return files;
  }
}

/**
 * Read and parse the machine-readable structure baseline JSON from Markdown.
 */
export function readBaseline(baselinePath: string = BASELINE_PATH): StructureBaseline {
  if (!fs.existsSync(baselinePath)) {
    throw new Error(`Structure baseline file not found at: ${baselinePath}`);
  }
  const content = fs.readFileSync(baselinePath, 'utf-8');
  const beginIdx = content.indexOf(BEGIN_MARKER);
  const endIdx = content.indexOf(END_MARKER);

  if (beginIdx === -1 || endIdx === -1 || endIdx <= beginIdx) {
    throw new Error('Structure baseline index markers missing or malformed.');
  }

  const block = content.substring(beginIdx + BEGIN_MARKER.length, endIdx);
  const jsonMatch = block.match(/```json\s*(\{[\s\S]*?\})\s*```/);

  if (!jsonMatch) {
    throw new Error('Valid JSON codeblock not found within structure baseline markers.');
  }

  try {
    return JSON.parse(jsonMatch[1]) as StructureBaseline;
  } catch (err) {
    throw new Error(`Failed to parse structure baseline JSON: ${(err as Error).message}`);
  }
}

/**
 * Compute the live structure model from tracked files.
 */
export function computeLiveStructure(trackedFiles: string[]) {
  const topLevelDirs = new Set<string>();
  const secondLevelBoundaries = new Set<string>();

  for (const file of trackedFiles) {
    const parts = file.split('/');
    if (parts.length > 1) {
      topLevelDirs.add(parts[0]);
    }
    if (parts.length > 2) {
      secondLevelBoundaries.add(`${parts[0]}/${parts[1]}`);
    }
  }

  return {
    top_level_directories: Array.from(topLevelDirs).sort(),
    selected_second_level_boundaries: Array.from(secondLevelBoundaries).sort(),
  };
}

/**
 * Compare live structure against baseline and generate drift report.
 */
export function evaluateStructureDrift(
  baseline: StructureBaseline,
  trackedFiles: string[],
): DriftReport {
  const live = computeLiveStructure(trackedFiles);
  const liveTopLevel = new Set(live.top_level_directories);
  const baseTopLevel = new Set(baseline.top_level_directories);

  const liveSecondLevel = new Set(live.selected_second_level_boundaries);
  const baseSecondLevel = new Set(baseline.selected_second_level_boundaries);

  const trackedSet = new Set(trackedFiles);

  const newTopLevel = live.top_level_directories.filter((d) => !baseTopLevel.has(d));
  const removedTopLevel = baseline.top_level_directories.filter((d) => !liveTopLevel.has(d));

  // For 2nd-level boundaries, evaluate drift relative to key parent folders
  const keyParents = new Set(['src', 'tests', 'docs', 'prisma', '.github']);
  const newSecondLevel = live.selected_second_level_boundaries.filter(
    (b) => !baseSecondLevel.has(b) && keyParents.has(b.split('/')[0]),
  );
  const removedSecondLevel = baseline.selected_second_level_boundaries.filter(
    (b) => !liveSecondLevel.has(b),
  );

  const missingRequiredFiles = baseline.required_structural_files.filter(
    (f) => !trackedSet.has(f) && !fs.existsSync(path.join(ROOT, f)),
  );

  const hasDrift =
    newTopLevel.length > 0 ||
    removedTopLevel.length > 0 ||
    newSecondLevel.length > 0 ||
    removedSecondLevel.length > 0 ||
    missingRequiredFiles.length > 0;

  return {
    hasDrift,
    newTopLevel,
    removedTopLevel,
    newSecondLevel,
    removedSecondLevel,
    missingRequiredFiles,
  };
}

/**
 * Update the baseline Markdown file with live structure.
 */
export function writeBaseline(baselinePath: string, newBaselineData: StructureBaseline): void {
  const content = fs.readFileSync(baselinePath, 'utf-8');
  const beginIdx = content.indexOf(BEGIN_MARKER);
  const endIdx = content.indexOf(END_MARKER);

  if (beginIdx === -1 || endIdx === -1 || endIdx <= beginIdx) {
    throw new Error('Structure baseline index markers missing or malformed.');
  }

  const newJsonBlock = `\n\`\`\`json\n${JSON.stringify(newBaselineData, null, 2)}\n\`\`\`\n`;
  const updatedContent =
    content.substring(0, beginIdx + BEGIN_MARKER.length) + newJsonBlock + content.substring(endIdx);

  fs.writeFileSync(baselinePath, updatedContent, 'utf-8');
}

/**
 * CLI Entrypoint
 */
export function main(args: string[] = process.argv.slice(2)): number {
  const isUpdate = args.includes('--update');
  const isReport = args.includes('--report');

  try {
    const trackedFiles = getTrackedFiles();
    const baseline = readBaseline();
    const drift = evaluateStructureDrift(baseline, trackedFiles);

    console.log('============================================================');
    console.log(
      `VELORA STRUCTURE GUARD  —  mode: ${isUpdate ? '--update' : isReport ? '--report' : '--check'}`,
    );
    console.log('============================================================');

    if (!drift.hasDrift) {
      console.log('✅ STRUCTURE CHECK: PASS');
      console.log('No structural drift detected against baseline.');
      return 0;
    }

    console.log('❌ STRUCTURE DRIFT DETECTED:');
    if (drift.newTopLevel.length > 0) {
      console.log('  NEW Top-Level Directories:', drift.newTopLevel.join(', '));
    }
    if (drift.removedTopLevel.length > 0) {
      console.log('  REMOVED Top-Level Directories:', drift.removedTopLevel.join(', '));
    }
    if (drift.newSecondLevel.length > 0) {
      console.log('  NEW 2nd-Level Boundaries:', drift.newSecondLevel.join(', '));
    }
    if (drift.removedSecondLevel.length > 0) {
      console.log('  REMOVED 2nd-Level Boundaries:', drift.removedSecondLevel.join(', '));
    }
    if (drift.missingRequiredFiles.length > 0) {
      console.log('  MISSING Required Structural Files:', drift.missingRequiredFiles.join(', '));
    }

    if (isUpdate) {
      const live = computeLiveStructure(trackedFiles);
      const updatedBaseline: StructureBaseline = {
        top_level_directories: live.top_level_directories,
        selected_second_level_boundaries: live.selected_second_level_boundaries,
        required_structural_files: baseline.required_structural_files,
      };
      writeBaseline(BASELINE_PATH, updatedBaseline);
      console.log('\n>> Baseline updated successfully in docs/architecture/STRUCTURE_BASELINE.md.');
      return 0;
    }

    if (isReport) {
      console.log('\n(report mode — exit 0; run --update to sync)');
      return 0;
    }

    console.log('\n>> FAIL: Structural drift detected.');
    console.log(
      '   Run `npm run structure:check -- --update` to sync baseline if changes are intentional.',
    );
    return 1;
  } catch (err) {
    console.error(`ERROR: ${(err as Error).message}`);
    return 1;
  }
}

// Execute CLI if run directly
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  process.exit(main());
}
