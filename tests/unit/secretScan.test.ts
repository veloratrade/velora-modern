import { describe, it, expect } from 'vitest';
import { scanFiles } from '../../scripts/secret-scan.js';

/**
 * All fixtures are in-memory (injected `readFile`) so no fake-secret fixture
 * file ever touches the repository. Fake values below are synthetic and
 * recognizable (never real credential material).
 */
function scan(entries: Record<string, string>): ReturnType<typeof scanFiles> {
  return scanFiles(Object.keys(entries), (p) => entries[p] ?? null);
}

describe('Secret Scan', () => {
  it('CLEAN: ordinary source with placeholders passes', () => {
    const result = scan({
      'src/a.ts': 'export const x = 1;\n// see docs\n',
      '.env.example': '# JWT_SECRET=your-32-character-secret-key-here\nPORT=8080\n',
    });
    expect(result.clean).toBe(true);
    expect(result.findings).toHaveLength(0);
  });

  it('FORBIDDEN_FILE: .env, keys and sqlite files are flagged; .env.example is allowed', () => {
    const result = scanFiles(['.env', 'certs/id_rsa', 'data/app.sqlite', '.env.example'], () => '');
    const rules = result.findings.map((f) => f.rule);
    expect(result.clean).toBe(false);
    expect(rules.filter((r) => r === 'FORBIDDEN_FILE')).toHaveLength(3);
    expect(result.findings.some((f) => f.file === '.env.example')).toBe(false);
  });

  it('SQL_BCRYPT_HASH / SQL_PUBLIC_MAIL: real user data in SQL is flagged', () => {
    const result = scan({
      'dump.sql':
        "INSERT INTO users VALUES ('a@gmail.com', '$2b$12$abcdefghijklmnopqrstuuABCDEF');\n",
    });
    const rules = result.findings.map((f) => f.rule);
    expect(rules).toContain('SQL_BCRYPT_HASH');
    expect(rules).toContain('SQL_PUBLIC_MAIL');
  });

  it('SQL scan ignores non-public-mail domains and non-SQL files', () => {
    const result = scan({
      'schema.sql': 'CREATE TABLE t (email VARCHAR(255)); -- admin@veloratrade.ir\n',
      'src/a.ts': 'const h = "$2b$12$testonly";\n',
    });
    expect(result.clean).toBe(true);
  });

  it('Key patterns: AWS / Resend / Anthropic / Gemini / GitHub / Slack flagged', () => {
    const result = scan({
      'src/k.ts': [
        'const a = "AKIAIOSF' + 'ODNN7EXAMPLE";',
        'const r = "re_9f8e7d6c' + '5b4a32109876";',
        'const c = "sk-ant-synthetic' + '-key-0123456789";',
        'const g = "AIzaSyB-synthetic' + '-key-material-0123456789";',
        'const t = "ghp_syntheticgithub' + 'token000000000000";',
        'const s = "xoxb-synthetic' + '-slack-token";',
      ].join('\n'),
    });
    const rules = new Set(result.findings.map((f) => f.rule));
    for (const expected of [
      'AWS_KEY',
      'RESEND_KEY',
      'ANTHROPIC_KEY',
      'GEMINI_KEY',
      'GITHUB_TOKEN',
      'SLACK_TOKEN',
    ]) {
      expect(rules.has(expected)).toBe(true);
    }
  });

  it('PRIVATE_KEY is flagged even inside comments', () => {
    const result = scan({ 'notes.md': '# old key\n-----BEGIN RSA PRIVATE ' + 'KEY-----\n' });
    expect(result.findings.some((f) => f.rule === 'PRIVATE_KEY')).toBe(true);
  });

  it('PASSWORD_ASSIGNMENT flags literals but skips placeholders and comments', () => {
    const bad = scan({ 'src/a.ts': 'const password = "Sup3rS' + 'ecretValue!";\n' });
    expect(bad.findings.some((f) => f.rule === 'PASSWORD_ASSIGNMENT')).toBe(true);

    const ok = scan({
      'src/b.ts': 'const password = "changeme";\n',
      'conf.yml': '# password: "Sup3rS' + 'ecretValue!"\n',
    });
    expect(ok.findings.some((f) => f.rule === 'PASSWORD_ASSIGNMENT')).toBe(false);
  });

  it('CONNECTION_STRING_SECRET flags embedded credentials, skips commented dummies', () => {
    const bad = scan({ 'src/a.ts': 'const u = "postgres://' + 'app:hunter2@db:5432/app";\n' });
    expect(bad.findings.some((f) => f.rule === 'CONNECTION_STRING_SECRET')).toBe(true);

    const ok = scan({ '.env.example': '# DATABASE_URL=mysql://root:password@localhost:3306/x\n' });
    expect(ok.findings.some((f) => f.rule === 'CONNECTION_STRING_SECRET')).toBe(false);
  });

  it('Calibration: textbook dummy passwords are skipped, real-looking ones flagged', () => {
    const ok = scan({
      't.ts': [
        'const a = "Password123!";',
        'const b = "SecurePass123";',
        'const c = "SecurePassword123";',
      ].join('\n'),
    });
    expect(ok.findings.some((f) => f.rule === 'PASSWORD_ASSIGNMENT')).toBe(false);

    const bad = scan({ 't.ts': 'const dbPassword = "k7#VmQ' + '2!xZ9pL4sW8e";\n' });
    expect(bad.findings.some((f) => f.rule === 'PASSWORD_ASSIGNMENT')).toBe(true);
  });

  it('Calibration: dummy localhost URLs skipped; remote credentialed URLs always flagged', () => {
    const ok = scan({
      't.ts': [
        'const a = "mysql://user:pass@localhost:3306/db";',
        'const b = "mysql://root:root@localhost:3306/x";',
      ].join('\n'),
    });
    expect(ok.findings.some((f) => f.rule === 'CONNECTION_STRING_SECRET')).toBe(false);

    const bad = scan({
      't.ts': [
        'const a = "postgres://' + 'app:hunter2@db.internal:5432/app";',
        'const b = "mysql://ro' + 'ot:root@prod-db:3306/x";',
        'const c = "redis://:k7VmQ2xZ' + '9p@cache:6379/0";',
      ].join('\n'),
    });
    expect(bad.findings.filter((f) => f.rule === 'CONNECTION_STRING_SECRET')).toHaveLength(3);
  });

  it('Calibration: message strings under password-named keys are skipped', () => {
    const ok = scan({
      'svc.ts': [
        "currentPassword: 'Current password is incorrect.',",
        "newPassword: 'New password must differ from current password.',",
      ].join('\n'),
    });
    expect(ok.findings.some((f) => f.rule === 'PASSWORD_ASSIGNMENT')).toBe(false);
  });

  it('Output discipline: findings never contain matched secret values', () => {
    const marker = 'AKIAIOSF' + 'ODNN7EXAMPLE';
    const result = scan({ 'src/a.ts': `const a = "${marker}";\n` });
    expect(result.clean).toBe(false);
    const serialized = JSON.stringify(result.findings);
    expect(serialized.includes(marker)).toBe(false);
    expect(serialized.includes('AKIA')).toBe(false);
  });

  it('Live repo: currently tracked files are clean', async () => {
    const { scanRepo } = await import('../../scripts/secret-scan.js');
    const result = scanRepo();
    expect(result.findings).toEqual([]);
    expect(result.clean).toBe(true);
  });
});
