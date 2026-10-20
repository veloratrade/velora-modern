// Shared constants for the admin-UI verification rig (round 5).
//
// These are NOT secrets. They are the LOCAL fixtures a throwaway harness and its
// browser script agree on:
//   * RIG_SENTINEL is a canary: its whole purpose is to be searched for in every
//     HTTP response body and console line the browser sees. If it ever appears
//     there, a route leaked a credential to a client — that is the finding, not
//     the fixture.
//   * RIG_PASSWORD logs in disposable in-memory accounts on loopback.
// Changing either requires restarting the rig; the browser script reads this file,
// so the two can never drift.
export const RIG_SENTINEL = "RIGSENTINEL-do-not-log-4f7c2a";
export const RIG_PASSWORD = "local-verify-rig-password-123";

export const RIG_ACCOUNTS = {
  /** No AI permission at all: the tab must not render AND the API must refuse. */
  plain: { email: "plain@verify.local", role: "user" },
  /** `aiManage`: reads the panel, must NOT be able to run a live probe. */
  admin: { email: "admin@verify.local", role: "admin" },
  /** `aiRouteManage`: the only role the probe route accepts. */
  super: { email: "root@verify.local", role: "super_admin" },
} as const;
