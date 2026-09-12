// Client-IP resolution — PHP Core/RateLimiter.php::clientIp port (Phase C
// increment 7). Forwarding headers are attacker-controlled unless the
// immediate peer is an explicitly configured trusted reverse proxy; the
// fail-closed default (empty CIDR list) never trusts X-Forwarded-For.

/** Parse an IPv4 dotted-quad or IPv6 literal (incl. `::` compression and
 * embedded IPv4 tails such as `::ffff:1.2.3.4`) into bytes; null when not a
 * valid IP literal. PHP `inet_pton` equivalent (family-preserving: IPv4 → 4
 * bytes, IPv6 → 16 bytes — never normalized across families, matching PHP's
 * per-family CIDR length check). */
export function ipToBytes(ip: string): Uint8Array | null {
  if (ip.includes(":")) return parseIpv6(ip);
  return parseIpv4(ip);
}

function parseIpv4(ip: string): Uint8Array | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const bytes = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    const part = parts[i] ?? "";
    if (part === "" || part.length > 3 || !/^\d+$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    bytes[i] = value;
  }
  return bytes;
}

/** Hextet values for one side of an optional `::`; an embedded IPv4 tail is
 * accepted only as the last component (two hextets). Returns null on any
 * malformed component. */
function parseIpv6Group(group: string): number[] | null {
  if (group === "") return [];
  const parts = group.split(":");
  const values: number[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] ?? "";
    if (part === "") return null;
    if (part.includes(".")) {
      if (i !== parts.length - 1) return null; // embedded IPv4 only at the end
      const v4 = parseIpv4(part);
      if (v4 === null) return null;
      values.push(((v4[0] ?? 0) << 8) | (v4[1] ?? 0), ((v4[2] ?? 0) << 8) | (v4[3] ?? 0));
      return values;
    }
    if (part === "") return null; // stray single colon (":1:2", "1:2:")
    if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return null;
    values.push(parseInt(part, 16));
  }
  return values;
}

function parseIpv6(ip: string): Uint8Array | null {
  const sides = ip.split("::");
  if (sides.length > 2) return null; // at most one `::`
  const bytes = new Uint8Array(16);
  let hextets: number[];
  if (sides.length === 2) {
    const left = parseIpv6Group(sides[0] ?? "");
    const right = parseIpv6Group(sides[1] ?? "");
    if (left === null || right === null) return null;
    const missing = 8 - left.length - right.length;
    if (missing < 1) return null; // `::` must stand for at least one zero group
    hextets = [...left, ...new Array<number>(missing).fill(0), ...right];
  } else {
    const single = parseIpv6Group(ip);
    if (single === null) return null;
    hextets = single;
  }
  if (hextets.length !== 8) return null;
  for (let i = 0; i < 8; i++) {
    const hextet = hextets[i] ?? 0;
    bytes[i * 2] = hextet >> 8;
    bytes[i * 2 + 1] = hextet & 0xff;
  }
  return bytes;
}

/** PHP `RateLimiter::matchesAnyCidr` port: byte-exact network/prefix match,
 * same-family lengths only, missing prefix = full-length prefix, prefix
 * bounds validated, invalid entries skipped (never throw). */
export function matchesAnyCidr(ip: string, cidrs: readonly string[]): boolean {
  const packedIp = ipToBytes(ip);
  if (packedIp === null) return false;

  for (const entry of cidrs) {
    if (typeof entry !== "string" || entry.trim() === "") continue;
    const trimmed = entry.trim();
    const slash = trimmed.indexOf("/");
    const network = slash === -1 ? trimmed : trimmed.slice(0, slash);
    const prefixRaw = slash === -1 ? null : trimmed.slice(slash + 1);

    const packedNetwork = ipToBytes(network);
    if (packedNetwork === null || packedNetwork.length !== packedIp.length) continue;
    const maxBits = packedIp.length * 8;
    let prefix: number;
    if (prefixRaw === null) {
      prefix = maxBits;
    } else {
      if (!/^\d+$/.test(prefixRaw)) continue;
      const parsed = Number(prefixRaw);
      if (parsed < 0 || parsed > maxBits) continue;
      prefix = parsed;
    }

    const wholeBytes = Math.floor(prefix / 8);
    const remainingBits = prefix % 8;
    let matches = true;
    for (let i = 0; i < wholeBytes; i++) {
      if ((packedIp[i] ?? -1) !== (packedNetwork[i] ?? -1)) {
        matches = false;
        break;
      }
    }
    if (!matches) continue;
    if (remainingBits > 0) {
      const mask = (0xff << (8 - remainingBits)) & 0xff;
      if (((packedIp[wholeBytes] ?? 0) & mask) !== ((packedNetwork[wholeBytes] ?? 0) & mask)) continue;
    }
    return true;
  }
  return false;
}

export interface ClientIpInput {
  readonly remoteAddress: string | undefined;
  readonly xForwardedFor: string | undefined;
}

/** PHP `RateLimiter::clientIp` port: the socket peer address (validated,
 * `0.0.0.0` fallback) unless the peer is a configured trusted proxy — only
 * then is the FIRST `X-Forwarded-For` entry honored (validated, 64-char cap). */
export function resolveClientIp(input: ClientIpInput, trustedProxyCidrs: readonly string[]): string {
  const remoteRaw = input.remoteAddress === undefined ? "" : input.remoteAddress.trim();
  const remote = ipToBytes(remoteRaw) !== null ? remoteRaw : "0.0.0.0";

  if (matchesAnyCidr(remote, trustedProxyCidrs)) {
    const forwarded = input.xForwardedFor === undefined ? "" : input.xForwardedFor;
    if (forwarded !== "") {
      const first = (forwarded.split(",")[0] ?? "").trim();
      if (ipToBytes(first) !== null) return first.slice(0, 64);
    }
  }
  return remote.slice(0, 64);
}
