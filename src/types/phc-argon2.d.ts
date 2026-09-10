declare module '@phc/argon2' {
  export function hash(password: string, options?: Record<string, unknown>): Promise<string>;
  export function verify(hash: string, password: string): Promise<boolean>;
}
