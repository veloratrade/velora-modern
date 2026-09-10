export interface PublicUserDto {
  id: number;
  email: string;
  fullName: string;
  role: string;
  plan: string;
  timezone: string;
  locale: string;
  createdAt: string;
  aiConsent: boolean;
}

export interface TokenPairResponse {
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
  tokenType: string;
  user: PublicUserDto;
}

export interface RegisterRequestDto {
  email: string;
  password: string;
  full_name?: string;
  fullName?: string;
  timezone?: string;
  locale?: string;
  notificationLocale?: string;
}

export interface LoginRequestDto {
  email: string;
  password: string;
  notificationLocale?: string;
}

export interface VerifyEmailRequestDto {
  token: string;
  notificationLocale?: string;
}

export interface ResendVerificationRequestDto {
  email: string;
  notificationLocale?: string;
}

export interface ForgotPasswordRequestDto {
  email: string;
  notificationLocale?: string;
}

export interface ResetPasswordRequestDto {
  token: string;
  newPassword: string;
  notificationLocale?: string;
}

export interface ChangePasswordRequestDto {
  currentPassword: string;
  newPassword: string;
  notificationLocale?: string;
}

export interface EmailPreferencesDto {
  welcome_email: boolean;
  security_alerts: boolean;
  trade_notifications: boolean;
  weekly_report: boolean;
  marketing_emails: boolean;
}

export interface UpdatePreferencesRequestDto {
  locale?: string;
  ai_consent?: boolean;
}
