import { describe, it, expect } from 'vitest';
import { Prisma } from '@prisma/client';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('Phase 3 — Database Schema & Parity Verification', () => {
  const schemaPath = path.join(__dirname, '../../prisma/schema.prisma');
  const migrationPath = path.join(__dirname, '../../prisma/migrations/0_init/migration.sql');

  it('should load prisma schema and verify file exists', () => {
    expect(fs.existsSync(schemaPath)).toBe(true);
    expect(fs.existsSync(migrationPath)).toBe(true);
  });

  it('should verify all 38 active canonical models exist in Prisma Client DMMF', () => {
    const dmmf = Prisma.dmmf;
    const modelNames = dmmf.datamodel.models.map((m) => m.name);

    const expected38Models = [
      'User',
      'UserSession',
      'AuthEvent',
      'PasswordReset',
      'EmailVerification',
      'EmailNotification',
      'EmailPreference',
      'UserAchievement',
      'UserDevice',
      'RateLimit',
      'TradingAccount',
      'Trade',
      'TradeExit',
      'MetaapiOperation',
      'SyncJob',
      'WebhookEvent',
      'ContentTranslationCache',
      'ContentTranslationJob',
      'AiExtraction',
      'AiProviderQuota',
      'AiProviderLog',
      'AiRequest',
      'AiFeatureFlag',
      'AiAuditLog',
      'AiFeedback',
      'AiJob',
      'AiReport',
      'AiAnalysis',
      'AiFeatureProvider',
      'AiGlobalSetting',
      'AiProviderCredential',
      'AdminAuditLog',
      'SystemLog',
      'IntegrationHealth',
      'MetaapiFill',
      'SupportConversation',
      'SupportMessage',
      'SupportMessageTranslation',
    ];

    expect(modelNames.length).toBe(38);
    for (const model of expected38Models) {
      expect(modelNames).toContain(model);
    }
  });

  it('should verify MetaAPI Fill idempotency constraint (account_id, external_deal_id)', () => {
    const dmmf = Prisma.dmmf;
    const metaapiFillModel = dmmf.datamodel.models.find((m) => m.name === 'MetaapiFill');
    expect(metaapiFillModel).toBeDefined();

    const multiUniqueFields = metaapiFillModel!.uniqueFields;
    const hasAccountDealUnique = multiUniqueFields.some(
      (fields) =>
        fields.length === 2 && fields.includes('accountId') && fields.includes('externalDealId'),
    );

    expect(hasAccountDealUnique).toBe(true);
  });

  it('should verify Trade idempotency constraint (account_id, external_deal_id)', () => {
    const dmmf = Prisma.dmmf;
    const tradeModel = dmmf.datamodel.models.find((m) => m.name === 'Trade');
    expect(tradeModel).toBeDefined();

    const multiUniqueFields = tradeModel!.uniqueFields;
    const hasAccountDealUnique = multiUniqueFields.some(
      (fields) =>
        fields.length === 2 && fields.includes('accountId') && fields.includes('externalDealId'),
    );

    expect(hasAccountDealUnique).toBe(true);
  });

  it('should verify UserSession security token hashes and refresh index', () => {
    const dmmf = Prisma.dmmf;
    const sessionModel = dmmf.datamodel.models.find((m) => m.name === 'UserSession');
    expect(sessionModel).toBeDefined();

    const refreshTokenField = sessionModel!.fields.find((f) => f.name === 'refreshTokenHash');
    expect(refreshTokenField).toBeDefined();
    expect(refreshTokenField!.isUnique).toBe(true);
    expect(refreshTokenField!.dbName).toBe('refresh_token_hash');

    const accessTokenField = sessionModel!.fields.find((f) => f.name === 'accessTokenHash');
    expect(accessTokenField).toBeDefined();
    expect(accessTokenField!.dbName).toBe('access_token_hash');
  });

  it('should verify Trade financial Decimal fields preservation', () => {
    const dmmf = Prisma.dmmf;
    const tradeModel = dmmf.datamodel.models.find((m) => m.name === 'Trade');
    expect(tradeModel).toBeDefined();

    const decimalFields = [
      'entryPrice',
      'exitPrice',
      'volume',
      'contractSize',
      'commission',
      'swap',
      'profitLoss',
      'rMultiple',
      'stopLoss',
      'takeProfit',
    ];

    for (const fieldName of decimalFields) {
      const field = tradeModel!.fields.find((f) => f.name === fieldName);
      expect(field).toBeDefined();
      expect(field!.type).toBe('Decimal');
    }
  });

  it('should verify Trade time canonical provenance fields', () => {
    const dmmf = Prisma.dmmf;
    const tradeModel = dmmf.datamodel.models.find((m) => m.name === 'Trade');
    expect(tradeModel).toBeDefined();

    const timeCanonicalFields = [
      'openTime',
      'closeTime',
      'occurredOpenAtUtc',
      'occurredCloseAtUtc',
      'timeStatus',
      'sourceTimezone',
      'sourceTimezoneSource',
      'sourceCalendar',
      'rawOpenText',
      'rawCloseText',
    ];

    for (const fieldName of timeCanonicalFields) {
      const field = tradeModel!.fields.find((f) => f.name === fieldName);
      expect(field).toBeDefined();
    }
  });

  it('should verify Support Ticket models exist with correct relations', () => {
    const dmmf = Prisma.dmmf;
    const convModel = dmmf.datamodel.models.find((m) => m.name === 'SupportConversation');
    const msgModel = dmmf.datamodel.models.find((m) => m.name === 'SupportMessage');
    const transModel = dmmf.datamodel.models.find((m) => m.name === 'SupportMessageTranslation');

    expect(convModel).toBeDefined();
    expect(msgModel).toBeDefined();
    expect(transModel).toBeDefined();

    const msgToConvRelation = msgModel!.fields.find((f) => f.name === 'conversation');
    expect(msgToConvRelation).toBeDefined();
    expect(msgToConvRelation!.type).toBe('SupportConversation');
  });
});
