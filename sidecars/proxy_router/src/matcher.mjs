// matcher.mjs — Domain routing matcher with private/loopback detection

const PRIVATE_RANGES_V4 = [
  [0x7F000000, 0xFF000000], // 127.0.0.0/8
  [0x0A000000, 0xFF000000], // 10.0.0.0/8
  [0xAC100000, 0xFFF00000], // 172.16.0.0/12
  [0xC0A80000, 0xFFFF0000], // 192.168.0.0/16
  [0xA9FE0000, 0xFFFF0000], // 169.254.0.0/16
];

function ipv4ToInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const v = parseInt(p, 10);
    if (isNaN(v) || v < 0 || v > 255) return null;
    n = (n << 8) | v;
  }
  return n >>> 0;
}

export function isPrivateOrLoopback(host) {
  if (!host) return true;
  const h = host.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')) return true;

  const ip = ipv4ToInt(h);
  if (ip !== null) {
    for (const [base, mask] of PRIVATE_RANGES_V4) {
      if (((ip & mask) >>> 0) === base) return true;
    }
  }
  return false;
}

function stripPort(host) {
  if (!host) return '';
  // Strip port for both IPv4 host:port and [IPv6]:port
  const bracketEnd = host.indexOf(']');
  if (bracketEnd !== -1) {
    return host.slice(1, bracketEnd).toLowerCase();
  }
  const lastColon = host.lastIndexOf(':');
  if (lastColon !== -1 && host.indexOf(':') === lastColon) {
    return host.slice(0, lastColon).toLowerCase();
  }
  return host.toLowerCase();
}

export function matchDomain(host, rule) {
  if (!rule.enabled) return false;
  const h = stripPort(host).toLowerCase();
  const p = rule.domain.toLowerCase();
  switch (rule.type) {
    case 'exact':
      return h === p;
    case 'suffix':
      return h === p || h.endsWith('.' + p);
    case 'wildcard': {
      const re = new RegExp('^' + p.replace(/\./g, '\\.').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
      return re.test(h);
    }
    default:
      return h === p;
  }
}

/**
 * Resolve routing for a given host.
 * @returns {{ action: 'DIRECT'|'PRIMARY'|'FALLBACK'|'BLOCKED', matchedRule?: object, reason: string, isNewDomain: boolean }}
 */
export function resolveRoute(host, config, geoGuardBlocked = false) {
  const h = stripPort(host);

  // Always direct-connect for private/loopback
  if (isPrivateOrLoopback(h)) {
    return { action: 'DIRECT', reason: 'private/loopback', isNewDomain: false };
  }

  // Connection mode: disabled => all direct
  if (config.connectionMode === 'disabled') {
    return { action: 'DIRECT', reason: 'proxy disabled', isNewDomain: false };
  }

  // Geo-Guard strict block
  if (geoGuardBlocked && config.options.strictGeoGuard) {
    return { action: 'BLOCKED', reason: 'geo-guard: no compliant proxy available', isNewDomain: false };
  }

  // Global mode: everything non-private goes through proxy
  if (config.routingMode === 'global') {
    return { action: 'PRIMARY', reason: 'global mode', isNewDomain: false };
  }

  // Rule mode: match against rules
  for (const rule of config.rules) {
    if (matchDomain(h, rule)) {
      return { action: 'PRIMARY', matchedRule: rule, reason: `rule: ${rule.domain}`, isNewDomain: false };
    }
  }

  // Not matched — mark as new domain for capture
  return { action: 'DIRECT', reason: 'no matching rule', isNewDomain: true };
}

export { stripPort };
