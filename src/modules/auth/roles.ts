export enum UserRole {
  GUEST = 'guest',
  USER = 'user',
  ADMIN = 'admin',
  SUPER_ADMIN = 'super_admin',
}

export const PANEL_ROLES = [UserRole.ADMIN, UserRole.SUPER_ADMIN];

export const PERMISSIONS = {
  OVERVIEW_VIEW: 'overview.view',
  USERS_VIEW: 'users.view',
  USERS_SUSPEND: 'users.suspend',
  USERS_ACTIVATE: 'users.activate',
  USERS_CHANGE_ROLE: 'users.change_role',
  USERS_MANAGE_SUBSCRIPTION: 'users.manage_subscription',
  USERS_VERIFY_EMAIL: 'users.verify_email',
  USERS_CREATE: 'users.create',
  AUDIT_VIEW: 'audit.view',
  AUDIT_SENSITIVE_VIEW: 'audit.view_sensitive',
  SYSTEM_HEALTH_VIEW: 'system.health.view',
  SYSTEM_LOGS_VIEW: 'system.logs.view',
  SETTINGS_VIEW: 'settings.view',
  SETTINGS_MANAGE: 'system.settings.manage',
  COMM_VIEW: 'communication.view',
  COMM_REPLY: 'communication.reply',
  BILLING_VIEW: 'billing.view',
  FEATURE_FLAGS_VIEW: 'feature_flags.view',
  FEATURE_FLAGS_EDIT: 'feature_flags.edit',
  INTEGRATIONS_VIEW: 'integrations.view',
  INTEGRATIONS_MANAGE: 'integrations.manage',
  ANALYTICS_VIEW: 'analytics.view',
  AI_MANAGE: 'aiManage',
  AI_ROUTE_MANAGE: 'aiRouteManage',
} as const;

export const PERMISSION_MAP: Record<string, string[]> = {
  [UserRole.USER]: [],
  [UserRole.ADMIN]: [
    PERMISSIONS.OVERVIEW_VIEW,
    PERMISSIONS.USERS_VIEW,
    PERMISSIONS.USERS_SUSPEND,
    PERMISSIONS.USERS_ACTIVATE,
    PERMISSIONS.USERS_MANAGE_SUBSCRIPTION,
    PERMISSIONS.USERS_VERIFY_EMAIL,
    PERMISSIONS.USERS_CREATE,
    PERMISSIONS.AUDIT_VIEW,
    PERMISSIONS.SYSTEM_HEALTH_VIEW,
    PERMISSIONS.SYSTEM_LOGS_VIEW,
    PERMISSIONS.SETTINGS_VIEW,
    PERMISSIONS.COMM_VIEW,
    PERMISSIONS.COMM_REPLY,
    PERMISSIONS.FEATURE_FLAGS_VIEW,
    PERMISSIONS.BILLING_VIEW,
    PERMISSIONS.INTEGRATIONS_VIEW,
    PERMISSIONS.AI_MANAGE,
    PERMISSIONS.ANALYTICS_VIEW,
  ],
  [UserRole.SUPER_ADMIN]: [
    PERMISSIONS.OVERVIEW_VIEW,
    PERMISSIONS.USERS_VIEW,
    PERMISSIONS.USERS_SUSPEND,
    PERMISSIONS.USERS_ACTIVATE,
    PERMISSIONS.USERS_CHANGE_ROLE,
    PERMISSIONS.USERS_MANAGE_SUBSCRIPTION,
    PERMISSIONS.USERS_VERIFY_EMAIL,
    PERMISSIONS.USERS_CREATE,
    PERMISSIONS.AUDIT_VIEW,
    PERMISSIONS.AUDIT_SENSITIVE_VIEW,
    PERMISSIONS.SYSTEM_HEALTH_VIEW,
    PERMISSIONS.SYSTEM_LOGS_VIEW,
    PERMISSIONS.SETTINGS_VIEW,
    PERMISSIONS.SETTINGS_MANAGE,
    PERMISSIONS.COMM_VIEW,
    PERMISSIONS.COMM_REPLY,
    PERMISSIONS.FEATURE_FLAGS_VIEW,
    PERMISSIONS.FEATURE_FLAGS_EDIT,
    PERMISSIONS.BILLING_VIEW,
    PERMISSIONS.INTEGRATIONS_VIEW,
    PERMISSIONS.INTEGRATIONS_MANAGE,
    PERMISSIONS.AI_MANAGE,
    PERMISSIONS.AI_ROUTE_MANAGE,
    PERMISSIONS.ANALYTICS_VIEW,
  ],
};

export class RoleService {
  static can(role: string, permission: string): boolean {
    const perms = PERMISSION_MAP[role] ?? [];
    return perms.includes(permission);
  }

  static isPanel(role: string): boolean {
    return PANEL_ROLES.includes(role as UserRole);
  }

  static isPrivileged(role: string): boolean {
    return role === UserRole.ADMIN || role === UserRole.SUPER_ADMIN;
  }
}
