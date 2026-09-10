import fs from 'fs';
import path from 'path';

interface I18nValidationResult {
  success: boolean;
  missingKeys: { locale: string; key: string }[];
  extraKeys: { locale: string; key: string }[];
  brandViolations: { locale: string; key: string; expected: string; actual: string }[];
  directionViolations: { locale: string; expected: string; actual: string }[];
  digitViolations: { locale: string; key: string; value: string }[];
  errors: string[];
}

const SUPPORTED_LOCALES = ['en', 'fa'];
const PRIMARY_LOCALE = 'en';

const EXPECTED_DIRECTIONS: Record<string, string> = {
  en: 'ltr',
  fa: 'rtl',
};

function flattenKeys(obj: Record<string, unknown>, prefix = ''): Record<string, string> {
  const keys: Record<string, string> = {};
  for (const key of Object.keys(obj)) {
    const propPath = prefix ? `${prefix}.${key}` : key;
    const val = obj[key];
    if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
      Object.assign(keys, flattenKeys(val as Record<string, unknown>, propPath));
    } else {
      keys[propPath] = String(val);
    }
  }
  return keys;
}

// Regex to detect Eastern Arabic/Persian digits: \u0660-\u0669 or \u06f0-\u06f9
const NON_LATIN_DIGIT_REGEX = /[\u0660-\u0669\u06f0-\u06f9]/;

export function validateI18nCatalogs(localesDir: string): I18nValidationResult {
  const result: I18nValidationResult = {
    success: true,
    missingKeys: [],
    extraKeys: [],
    brandViolations: [],
    directionViolations: [],
    digitViolations: [],
    errors: [],
  };

  const catalogs: Record<string, Record<string, string>> = {};

  // 1. Load and parse catalogs
  for (const locale of SUPPORTED_LOCALES) {
    const filePath = path.join(localesDir, `${locale}.json`);
    if (!fs.existsSync(filePath)) {
      result.errors.push(`Missing locale file: ${filePath}`);
      result.success = false;
      return result;
    }

    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      catalogs[locale] = flattenKeys(parsed);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      result.errors.push(`Failed to parse ${locale}.json: ${errMsg}`);
      result.success = false;
      return result;
    }
  }

  const primaryCatalog = catalogs[PRIMARY_LOCALE];
  const primaryKeys = new Set(Object.keys(primaryCatalog));

  // 2. Validate Key-Level Parity
  for (const locale of SUPPORTED_LOCALES) {
    if (locale === PRIMARY_LOCALE) continue;

    const currentCatalog = catalogs[locale];
    const currentKeys = new Set(Object.keys(currentCatalog));

    // Check for missing keys in target locale compared to primary
    for (const key of primaryKeys) {
      if (!currentKeys.has(key)) {
        result.missingKeys.push({ locale, key });
        result.success = false;
      }
    }

    // Check for extra keys in target locale not in primary
    for (const key of currentKeys) {
      if (!primaryKeys.has(key)) {
        result.extraKeys.push({ locale, key });
        result.success = false;
      }
    }
  }

  // 3. Validate Direction Metadata
  for (const locale of SUPPORTED_LOCALES) {
    const catalog = catalogs[locale];
    const actualDir = catalog['locale.direction'];
    const expectedDir = EXPECTED_DIRECTIONS[locale];

    if (actualDir !== expectedDir) {
      result.directionViolations.push({
        locale,
        expected: expectedDir,
        actual: actualDir || 'undefined',
      });
      result.success = false;
    }
  }

  // 4. Validate Brand Policy Terms Preservation
  for (const locale of SUPPORTED_LOCALES) {
    const catalog = catalogs[locale];
    if (catalog['brand.name'] && catalog['brand.name'] !== 'VELORA') {
      result.brandViolations.push({
        locale,
        key: 'brand.name',
        expected: 'VELORA',
        actual: catalog['brand.name'],
      });
      result.success = false;
    }
    if (catalog['brand.metaapi'] && catalog['brand.metaapi'] !== 'MetaAPI') {
      result.brandViolations.push({
        locale,
        key: 'brand.metaapi',
        expected: 'MetaAPI',
        actual: catalog['brand.metaapi'],
      });
      result.success = false;
    }
  }

  // 5. Validate ASCII / Latin Digit Invariant
  for (const locale of SUPPORTED_LOCALES) {
    const catalog = catalogs[locale];
    for (const [key, val] of Object.entries(catalog)) {
      if (NON_LATIN_DIGIT_REGEX.test(val)) {
        result.digitViolations.push({ locale, key, value: val });
        result.success = false;
      }
    }
  }

  return result;
}

// CLI runner
if (
  process.argv[1] &&
  (process.argv[1].endsWith('validate-i18n.ts') || process.argv[1].endsWith('validate-i18n.js'))
) {
  const localesDir = path.resolve(process.cwd(), 'locales');
  console.log(`[i18n-validator] Validating translation catalogs in: ${localesDir}`);

  const res = validateI18nCatalogs(localesDir);

  if (res.success) {
    console.log(
      `✅ [i18n-validator] PASS: Key-level parity, brand policy, direction, and Latin-digit invariants verified for all locales (${SUPPORTED_LOCALES.join(', ')}).`,
    );
    process.exit(0);
  } else {
    console.error(`❌ [i18n-validator] FAIL: Localization quality gate violations detected!\n`);

    if (res.errors.length > 0) {
      console.error(`Errors:`);
      res.errors.forEach((e) => console.error(`  - ${e}`));
    }

    if (res.missingKeys.length > 0) {
      console.error(`Missing Keys (${res.missingKeys.length}):`);
      res.missingKeys.forEach((m) => console.error(`  - [${m.locale}] missing key: "${m.key}"`));
    }

    if (res.extraKeys.length > 0) {
      console.error(`Extra Keys (${res.extraKeys.length}):`);
      res.extraKeys.forEach((e) =>
        console.error(`  - [${e.locale}] unexpected extra key: "${e.key}"`),
      );
    }

    if (res.brandViolations.length > 0) {
      console.error(`Brand Policy Violations (${res.brandViolations.length}):`);
      res.brandViolations.forEach((b) =>
        console.error(`  - [${b.locale}] ${b.key}: expected "${b.expected}", got "${b.actual}"`),
      );
    }

    if (res.directionViolations.length > 0) {
      console.error(`Direction Violations (${res.directionViolations.length}):`);
      res.directionViolations.forEach((d) =>
        console.error(`  - [${d.locale}] expected direction "${d.expected}", got "${d.actual}"`),
      );
    }

    if (res.digitViolations.length > 0) {
      console.error(`Non-Latin Digit Invariant Violations (${res.digitViolations.length}):`);
      res.digitViolations.forEach((v) =>
        console.error(`  - [${v.locale}] ${v.key}: contains Eastern Arabic digits ("${v.value}")`),
      );
    }

    process.exit(1);
  }
}
