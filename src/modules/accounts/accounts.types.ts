export type AccountProvider = 'MT4' | 'MT5' | 'MANUAL';
export type AccountStatus = 'connected' | 'error' | 'disconnected';
export type SyncStatus = 'DISCONNECTED' | 'CONNECTING' | 'SYNCING' | 'CONNECTED' | 'ERROR';

export interface TradingAccountRecord {
  id: number;
  userId: number;
  provider: AccountProvider;
  platform: string;
  broker: string | null;
  server: string | null;
  timezone: string | null;
  timezoneSource: string;
  mtLogin: string | null;
  label: string;
  accountNumber: string;
  currency: string;
  leverage: string | null;
  status: AccountStatus;
  syncStatus: SyncStatus;
  metaapiAccountId: string | null;
  lastSyncedAt: Date | string | null;
  connectedAt: Date | string | null;
  balance: string;
  equity: string;
  createdAt: Date;
  updatedAt?: Date;
}

export interface CreateAccountInput {
  provider: AccountProvider;
  label?: string;
  accountNumber?: string;
  currency?: string;
  leverage?: string;
  status?: AccountStatus;
  timezone?: string;
}

export interface UpdateAccountTimezoneInput {
  timezone?: string;
}

export interface DetectServerInput {
  mt_login?: string;
  accountNumber?: string;
}

export interface DetectServerResult {
  mt_login: string;
  suggestedServers: string[];
  allServers: string[];
  messageKey: string;
  nextStepKey: string;
  params: Record<string, unknown>;
}
