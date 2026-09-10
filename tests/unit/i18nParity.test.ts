import { describe, it, expect } from 'vitest';
import path from 'path';
import fs from 'fs';
import { validateI18nCatalogs } from '../../scripts/validate-i18n.js';

describe('Modern i18n Localization Quality Gate (Parity & Invariants)', () => {
  const localesDir = path.resolve(process.cwd(), 'locales');

  it('should pass on valid en.json and fa.json catalogs with 100% key parity', () => {
    const result = validateI18nCatalogs(localesDir);
    expect(result.success).toBe(true);
    expect(result.missingKeys).toHaveLength(0);
    expect(result.extraKeys).toHaveLength(0);
    expect(result.brandViolations).toHaveLength(0);
    expect(result.directionViolations).toHaveLength(0);
    expect(result.digitViolations).toHaveLength(0);
  });

  it('should DEMONSTRATE FAIL-CLOSED GATE on missing translation key (Requirement 19)', () => {
    const tempDir = path.resolve(process.cwd(), 'tmp_test_locales_missing');
    fs.mkdirSync(tempDir, { recursive: true });

    const enCatalog = {
      common: { save: 'Save', cancel: 'Cancel' },
      brand: { name: 'VELORA', metaapi: 'MetaAPI' },
      locale: { direction: 'ltr' },
    };

    // Corrupted faCatalog missing 'common.cancel'
    const faCatalogCorrupted = {
      common: { save: 'ذخیره' }, // missing cancel!
      brand: { name: 'VELORA', metaapi: 'MetaAPI' },
      locale: { direction: 'rtl' },
    };

    fs.writeFileSync(path.join(tempDir, 'en.json'), JSON.stringify(enCatalog));
    fs.writeFileSync(path.join(tempDir, 'fa.json'), JSON.stringify(faCatalogCorrupted));

    const result = validateI18nCatalogs(tempDir);
    fs.rmSync(tempDir, { recursive: true, force: true });

    expect(result.success).toBe(false);
    expect(result.missingKeys).toContainEqual({ locale: 'fa', key: 'common.cancel' });
  });

  it('should DEMONSTRATE FAIL-CLOSED GATE on brand policy violation', () => {
    const tempDir = path.resolve(process.cwd(), 'tmp_test_locales_brand');
    fs.mkdirSync(tempDir, { recursive: true });

    const enCatalog = {
      brand: { name: 'VELORA', metaapi: 'MetaAPI' },
      locale: { direction: 'ltr' },
    };

    // Corrupted faCatalog translating VELORA to something else
    const faCatalogCorrupted = {
      brand: { name: 'ولورا', metaapi: 'MetaAPI' },
      locale: { direction: 'rtl' },
    };

    fs.writeFileSync(path.join(tempDir, 'en.json'), JSON.stringify(enCatalog));
    fs.writeFileSync(path.join(tempDir, 'fa.json'), JSON.stringify(faCatalogCorrupted));

    const result = validateI18nCatalogs(tempDir);
    fs.rmSync(tempDir, { recursive: true, force: true });

    expect(result.success).toBe(false);
    expect(result.brandViolations).toContainEqual({
      locale: 'fa',
      key: 'brand.name',
      expected: 'VELORA',
      actual: 'ولورا',
    });
  });

  it('should DEMONSTRATE FAIL-CLOSED GATE on non-ASCII Eastern Arabic digits', () => {
    const tempDir = path.resolve(process.cwd(), 'tmp_test_locales_digits');
    fs.mkdirSync(tempDir, { recursive: true });

    const enCatalog = {
      version: 'v1.0.0',
      locale: { direction: 'ltr' },
      brand: { name: 'VELORA', metaapi: 'MetaAPI' },
    };

    // Corrupted faCatalog with Eastern Arabic numerals (۱۲۳)
    const faCatalogCorrupted = {
      version: 'v۱.۰.۰', // Eastern Arabic digits!
      locale: { direction: 'rtl' },
      brand: { name: 'VELORA', metaapi: 'MetaAPI' },
    };

    fs.writeFileSync(path.join(tempDir, 'en.json'), JSON.stringify(enCatalog));
    fs.writeFileSync(path.join(tempDir, 'fa.json'), JSON.stringify(faCatalogCorrupted));

    const result = validateI18nCatalogs(tempDir);
    fs.rmSync(tempDir, { recursive: true, force: true });

    expect(result.success).toBe(false);
    expect(result.digitViolations).toContainEqual({
      locale: 'fa',
      key: 'version',
      value: 'v۱.۰.۰',
    });
  });
});
