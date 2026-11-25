// health-monitor.mjs — True 1xRTT latency, Google 204 check, GeoIP whitelist/blacklist & on-demand speedtest
import { EventEmitter } from 'node:events';
import tls from 'node:tls';
import { performance } from 'node:perf_hooks';
import { connectViaProxy } from './upstream-client.mjs';

const DEFAULT_GEO_HOST = 'cloudflare.com';
const DEFAULT_GEO_PATH = '/cdn-cgi/trace';
const GOOGLE_204_HOST = 'www.gstatic.com';
const GOOGLE_204_PATH = '/generate_204';
const SPEEDTEST_HOST = 'speed.cloudflare.com';
const SPEEDTEST_DOWN_BYTES = 2 * 1024 * 1024; // 2 MB
const SPEEDTEST_UP_BYTES = 512 * 1024;        // 512 KB

/**
 * Execute an HTTPS request through an upstream proxy over raw TCP + TLS (anti-loop, bypasses env vars).
 * Measures true 1xRTT HTTP TTFB (from HTTP write to first response byte), excluding local proxy handshake time.
 */
export async function tlsHttpRequest(
  proxy,
  { host, port = 443, method = 'GET', path = '/', body = null, headers = {}, timeout = 7000 }
) {
  const tConnectStart = performance.now();
  let rawSock;
  let tlsSock;

  try {
    rawSock = await connectViaProxy(proxy, host, port, timeout);
    const connectMs = Math.max(1, Math.round(performance.now() - tConnectStart));

    return await new Promise((resolve, reject) => {
      let settled = false;
      const done = (err, val) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) {
          tlsSock?.destroy();
          rawSock?.destroy();
          reject(err);
        } else {
          tlsSock?.destroy();
          resolve(val);
        }
      };

      const timer = setTimeout(() => done(new Error(`${host} HTTPS timeout`)), timeout);

      tlsSock = tls.connect({ socket: rawSock, servername: host }, () => {
        const hdrLines = [
          `${method} ${path} HTTP/1.1`,
          `Host: ${host}`,
          'User-Agent: antigravity-proxy-router/1.0',
          'Accept: */*',
          'Connection: close',
        ];
        if (body) {
          hdrLines.push(`Content-Length: ${body.length}`);
        }
        for (const [k, v] of Object.entries(headers)) {
          hdrLines.push(`${k}: ${v}`);
        }

        const tReqStart = performance.now();
        let tFirstByte = null;
        let tBodyStart = tReqStart;

        const chunks = [];
        let headerDone = false;
        let statusCode = 0;
        let headerEndIdx = -1;
        let contentLength = null;

        tlsSock.on('data', (chunk) => {
          if (tFirstByte === null) {
            tFirstByte = performance.now();
          }
          chunks.push(chunk);

          if (!headerDone) {
            const joined = Buffer.concat(chunks);
            const sep = joined.indexOf('\r\n\r\n');
            if (sep !== -1) {
              headerDone = true;
              headerEndIdx = sep + 4;
              const hdrText = joined.slice(0, sep).toString('latin1');
              const firstLine = hdrText.split('\r\n')[0] || '';
              statusCode = parseInt(firstLine.split(' ')[1], 10) || 0;
              const clMatch = hdrText.match(/content-length:\s*(\d+)/i);
              if (clMatch) contentLength = parseInt(clMatch[1], 10);

              if (statusCode === 204 || method === 'HEAD') {
                const endAt = performance.now();
                return done(null, {
                  statusCode,
                  body: Buffer.alloc(0),
                  connectMs,
                  ttfbMs: Math.max(1, Math.round(tFirstByte - tReqStart)),
                  totalTransferMs: Math.max(1, Math.round(endAt - tBodyStart)),
                });
              }
            }
          }

          if (headerDone && contentLength !== null) {
            const totalLen = chunks.reduce((acc, b) => acc + b.length, 0);
            if (totalLen - headerEndIdx >= contentLength) {
              const full = Buffer.concat(chunks);
              const endAt = performance.now();
              return done(null, {
                statusCode,
                body: full.slice(headerEndIdx, headerEndIdx + contentLength),
                connectMs,
                ttfbMs: Math.max(1, Math.round(tFirstByte - tReqStart)),
                totalTransferMs: Math.max(1, Math.round(endAt - tFirstByte)),
              });
            }
          }
        });

        tlsSock.once('end', () => {
          const full = Buffer.concat(chunks);
          const endAt = performance.now();
          const sep = full.indexOf('\r\n\r\n');
          const hdrText = sep !== -1 ? full.slice(0, sep).toString('latin1') : '';
          const parsedCode = statusCode || parseInt((hdrText.split('\r\n')[0] || '').split(' ')[1], 10) || 0;
          const bodyBuf = sep !== -1 ? full.slice(sep + 4) : full;
          done(null, {
            statusCode: parsedCode,
            body: bodyBuf,
            connectMs,
            ttfbMs: Math.max(1, Math.round((tFirstByte ?? endAt) - tReqStart)),
            totalTransferMs: Math.max(1, Math.round(endAt - (tFirstByte ?? tReqStart))),
          });
        });

        tlsSock.once('error', (err) => done(err));

        tlsSock.write(hdrLines.join('\r\n') + '\r\n\r\n');
        if (body && body.length > 0) {
          tBodyStart = performance.now();
          tlsSock.write(body);
        }
      });

      tlsSock.once('error', (err) => done(err));
    });
  } catch (err) {
    tlsSock?.destroy();
    rawSock?.destroy();
    throw err;
  }
}

const GEO_PROVIDERS = [
  {
    host: 'cloudflare.com',
    path: '/cdn-cgi/trace',
    parse(text) {
      const fields = {};
      for (const line of text.split(/\r?\n/)) {
        const eq = line.indexOf('=');
        if (eq > 0) fields[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
      }
      return {
        country: fields.loc ? fields.loc.toUpperCase() : null,
        exitIp: fields.ip || null,
      };
    },
  },
  {
    host: 'www.cloudflare.com',
    path: '/cdn-cgi/trace',
    parse(text) {
      const fields = {};
      for (const line of text.split(/\r?\n/)) {
        const eq = line.indexOf('=');
        if (eq > 0) fields[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
      }
      return {
        country: fields.loc ? fields.loc.toUpperCase() : null,
        exitIp: fields.ip || null,
      };
    },
  },
  {
    host: 'ipinfo.io',
    path: '/json',
    parse(text) {
      const obj = JSON.parse(text || '{}');
      return {
        country: obj.country ? String(obj.country).trim().toUpperCase() : null,
        exitIp: obj.ip ? String(obj.ip).trim() : null,
      };
    },
  },
];

/**
 * Default GeoIP lookup cascading across Cloudflare trace and ipinfo.io over raw proxy + TLS.
 * Uses HTTP 1xRTT (ttfbMs) as primary latency to match real proxy RTT instead of local loopback handshake.
 */
export async function defaultGeoLookup(proxy, timeout = 7000) {
  let lastErr = null;
  const perProviderTimeout = Math.min(timeout, 3000);
  for (const provider of GEO_PROVIDERS) {
    try {
      const res = await tlsHttpRequest(proxy, {
        host: provider.host,
        path: provider.path,
        timeout: perProviderTimeout,
      });
      if (res.statusCode < 200 || res.statusCode >= 300) {
        lastErr = new Error(`${provider.host} HTTP ${res.statusCode}`);
        continue;
      }
      const parsed = provider.parse(res.body.toString('utf8'));
      if (!parsed.country && !parsed.exitIp) {
        lastErr = new Error(`${provider.host} returned empty GeoIP payload`);
        continue;
      }
      return {
        ok: true,
        latencyMs: res.ttfbMs,
        connectMs: res.connectMs,
        country: parsed.country,
        exitIp: parsed.exitIp,
      };
    } catch (err) {
      lastErr = err;
    }
  }
  return {
    ok: false,
    latencyMs: null,
    connectMs: null,
    country: null,
    exitIp: null,
    error: lastErr?.message || 'GeoIP lookup failed',
  };
}

/** Lightweight Google 204 reachability check through proxy */
export async function defaultGoogle204Probe(proxy, timeout = 5000) {
  try {
    const res = await tlsHttpRequest(proxy, {
      host: GOOGLE_204_HOST,
      path: GOOGLE_204_PATH,
      timeout,
    });
    return {
      ok: res.statusCode === 204 || (res.statusCode >= 200 && res.statusCode < 400),
      latencyMs: res.ttfbMs,
      statusCode: res.statusCode,
    };
  } catch (err) {
    return { ok: false, latencyMs: null, error: err.message };
  }
}

/** On-demand bandwidth speedtest (2MB down / 512KB up via speed.cloudflare.com). Only runs on explicit user action. */
export async function defaultSpeedTest(proxy, timeout = 12000) {
  let downloadMbps = null;
  let uploadMbps = null;
  const errors = [];

  try {
    const downRes = await tlsHttpRequest(proxy, {
      host: SPEEDTEST_HOST,
      path: `/__down?bytes=${SPEEDTEST_DOWN_BYTES}`,
      timeout,
    });
    const bytes = downRes.body.length || SPEEDTEST_DOWN_BYTES;
    const sec = Math.max(0.05, downRes.totalTransferMs / 1000);
    downloadMbps = Number(((bytes * 8) / 1_000_000 / sec).toFixed(2));
  } catch (err) {
    errors.push(`DL: ${err.message}`);
  }

  try {
    const payload = Buffer.alloc(SPEEDTEST_UP_BYTES, 0x61);
    const upRes = await tlsHttpRequest(proxy, {
      host: SPEEDTEST_HOST,
      method: 'POST',
      path: '/__up',
      body: payload,
      headers: { 'Content-Type': 'application/octet-stream' },
      timeout,
    });
    const sec = Math.max(0.05, (upRes.totalTransferMs || upRes.ttfbMs) / 1000);
    uploadMbps = Number(((SPEEDTEST_UP_BYTES * 8) / 1_000_000 / sec).toFixed(2));
  } catch (err) {
    errors.push(`UL: ${err.message}`);
  }

  return {
    ok: downloadMbps !== null || uploadMbps !== null,
    downloadMbps,
    uploadMbps,
    error: errors.length ? errors.join('; ') : null,
  };
}

export class HealthMonitor extends EventEmitter {
  #configStore;
  #statuses = new Map();
  #timer = null;
  #geoLookupFn;
  #google204Fn;
  #speedTestFn;
  #checking = false;

  constructor(configStore, { geoLookupFn, google204Fn, speedTestFn } = {}) {
    super();
    this.#configStore = configStore;
    this.#geoLookupFn = geoLookupFn || defaultGeoLookup;
    // If tests mock geoLookupFn without specifying google204Fn, avoid hitting external gstatic
    this.#google204Fn = google204Fn || (geoLookupFn ? async () => null : defaultGoogle204Probe);
    this.#speedTestFn = speedTestFn || defaultSpeedTest;
  }

  getStatus(proxyId) {
    return this.#statuses.get(proxyId) || {
      status: 'unknown',
      latencyMs: null,
      connectMs: null,
      country: null,
      exitIp: null,
      google204Ok: null,
      googleLatencyMs: null,
      downloadMbps: null,
      uploadMbps: null,
      speedTestAt: null,
      speedTestError: null,
      lastCheck: null,
      error: null,
    };
  }

  getAllStatuses() {
    const out = {};
    for (const proxy of this.#configStore.data.proxies) {
      out[proxy.id] = this.getStatus(proxy.id);
    }
    return out;
  }

  isCountryAllowed(country) {
    const opts = this.#configStore.data.options || {};
    const mode = opts.geoPolicyMode || 'whitelist';
    const norm = country ? String(country).trim().toUpperCase() : null;

    if (mode === 'whitelist') {
      if (!norm || norm === 'XX' || norm === 'T1') return false;
      const allowed = (opts.allowedCountries || []).map(c => String(c).trim().toUpperCase());
      return allowed.includes(norm);
    }

    // Blacklist mode
    if (!norm) return true;
    if (norm === 'T1') return false;
    const blocked = (opts.blockedCountries || []).map(c => String(c).trim().toUpperCase());
    return !blocked.includes(norm);
  }

  isCountryBlocked(country) {
    return !this.isCountryAllowed(country);
  }

  /**
   * Returns true if strictGeoGuard is active and no compliant connected active proxy is available.
   */
  isBlocked() {
    const cfg = this.#configStore.data;
    if (cfg.connectionMode === 'disabled') return false;
    if (!cfg.options?.strictGeoGuard) return false;

    const active = this.#configStore.getActiveProxy();
    if (!active) return true;

    const st = this.getStatus(active.id);
    if (st.status === 'geo_blocked' || st.status === 'unavailable' || st.status === 'unknown') {
      return true;
    }
    return this.isCountryBlocked(st.country);
  }

  #buildCountryError(country) {
    const mode = this.#configStore.data.options?.geoPolicyMode || 'whitelist';
    if (!country) return 'Exit region unknown (blocked by whitelist policy)';
    return mode === 'whitelist'
      ? `Exit region ${country} not in allowed whitelist`
      : `Exit region ${country} is in blocked blacklist`;
  }

  /** Test a single proxy (GeoIP + 1xRTT + optional Google 204) */
  async checkProxy(proxy) {
    const prev = this.getStatus(proxy.id);
    const geoPromise = this.#geoLookupFn(proxy);
    const g204Promise = this.#google204Fn(proxy).catch(() => null);

    // Publish GeoIP outcome immediately so Geo-Guard unblocks in ~200ms without waiting on slow 204 probes.
    const res = await geoPromise;
    if (res.ok) {
      const immediateStatus = this.isCountryBlocked(res.country) ? 'geo_blocked' : 'connected';
      const immediateRec = {
        ...prev,
        status: immediateStatus,
        latencyMs: res.latencyMs ?? null,
        connectMs: res.connectMs ?? null,
        country: res.country ?? null,
        exitIp: res.exitIp ?? null,
        lastCheck: Date.now(),
        error: immediateStatus === 'geo_blocked' ? this.#buildCountryError(res.country) : null,
      };
      this.#statuses.set(proxy.id, immediateRec);
      this.emit('update', { proxyId: proxy.id, record: immediateRec });
    }

    const g204 = await g204Promise;

    let status;
    let error = res.error || null;
    let country = res.country ?? null;
    let exitIp = res.exitIp ?? null;
    let latencyMs = res.latencyMs ?? null;
    let connectMs = res.connectMs ?? null;

    if (!res.ok) {
      // Transient GeoIP glitch grace: if Google 204 succeeded and we verified a compliant region within 5 min,
      // avoid false-positive 503 circuit-breaking of active traffic.
      const recentlyVerified = prev.lastCheck && (Date.now() - prev.lastCheck) < 300_000;
      if (g204?.ok && prev.status === 'connected' && prev.country && recentlyVerified && !this.isCountryBlocked(prev.country)) {
        status = 'connected';
        country = prev.country;
        exitIp = prev.exitIp;
        latencyMs = g204.latencyMs ?? prev.latencyMs;
        connectMs = prev.connectMs;
        error = null;
      } else {
        status = 'unavailable';
      }
    } else if (this.isCountryBlocked(country)) {
      status = 'geo_blocked';
      error = this.#buildCountryError(country);
    } else {
      status = 'connected';
    }

    const record = {
      ...prev,
      status,
      latencyMs,
      connectMs,
      country,
      exitIp,
      google204Ok: g204 ? Boolean(g204.ok) : prev.google204Ok,
      googleLatencyMs: g204?.latencyMs ?? prev.googleLatencyMs,
      lastCheck: Date.now(),
      error,
    };
    this.#statuses.set(proxy.id, record);
    this.emit('update', { proxyId: proxy.id, record });
    return record;
  }

  /** On-demand bandwidth speedtest for a specific proxy */
  async runSpeedTest(proxy) {
    const prev = this.getStatus(proxy.id);
    const res = await this.#speedTestFn(proxy);
    const record = {
      ...prev,
      downloadMbps: res.downloadMbps ?? prev.downloadMbps,
      uploadMbps: res.uploadMbps ?? prev.uploadMbps,
      speedTestAt: Date.now(),
      speedTestError: res.error || null,
    };
    this.#statuses.set(proxy.id, record);
    this.emit('update', { proxyId: proxy.id, record });
    return record;
  }

  /** Check active proxy (or all enabled proxies) and auto-switch if needed */
  async checkAll({ forceAll = true } = {}) {
    if (this.#checking) return this.getAllStatuses();
    this.#checking = true;
    try {
      const cfg = this.#configStore.data;
      const enabled = cfg.proxies.filter(p => p.enabled);

      if (forceAll) {
        await Promise.all(enabled.map(p => this.checkProxy(p)));
      } else {
        const active = this.#configStore.getActiveProxy();
        if (active) await this.checkProxy(active);
      }

      this.tryAutoSwitch();
      return this.getAllStatuses();
    } finally {
      this.#checking = false;
    }
  }

  /** If active proxy is unavailable/geo_blocked and autoSwitch is on, select first connected enabled proxy */
  tryAutoSwitch() {
    const cfg = this.#configStore.data;
    if (!cfg.options?.autoSwitch) return null;

    const active = this.#configStore.getActiveProxy();
    if (active) {
      const st = this.getStatus(active.id);
      if (st.status === 'connected') return active.id;
    }

    for (const p of cfg.proxies) {
      if (!p.enabled) continue;
      const st = this.getStatus(p.id);
      if (st.status === 'connected') {
        if (cfg.activeProxyId !== p.id) {
          this.#configStore.update({ activeProxyId: p.id });
          this.emit('switched', { toProxyId: p.id });
        }
        return p.id;
      }
    }
    return null;
  }

  /** Re-evaluate geo_blocked vs connected when policy mode or country lists change */
  reconcileCountries() {
    for (const st of this.#statuses.values()) {
      if (st.status === 'connected' || st.status === 'geo_blocked') {
        if (this.isCountryBlocked(st.country)) {
          st.status = 'geo_blocked';
          st.error = this.#buildCountryError(st.country);
        } else if (st.exitIp || st.latencyMs !== null) {
          st.status = 'connected';
          st.error = null;
        }
      }
    }
    this.tryAutoSwitch();
    this.emit('update', { reconciled: true });
  }

  start({ skipInitial = false } = {}) {
    this.stop();
    const intervalSec = Math.max(10, Number(this.#configStore.data.options?.healthCheckIntervalSec) || 60);
    if (!skipInitial) {
      this.checkAll({ forceAll: true }).catch(() => {});
    }
    this.#timer = setInterval(() => {
      if (this.#configStore.data.connectionMode === 'custom') {
        this.checkAll({ forceAll: false }).catch(() => {});
      }
    }, intervalSec * 1000);
    this.#timer.unref?.();
  }

  stop() {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }
}
