// proxy-router.test.mjs — Comprehensive tests for antigravity-proxy-router
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

import { ConfigStore } from '../src/config-store.mjs';
import { isPrivateOrLoopback, matchDomain, resolveRoute, stripPort } from '../src/matcher.mjs';
import { connectDirect, connectViaSocks5, connectViaHttpProxy, probeUpstream } from '../src/upstream-client.mjs';
import { HealthMonitor } from '../src/health-monitor.mjs';
import { ProxyServer } from '../src/proxy-server.mjs';
import { SettingsManager, parseJsonc } from '../src/settings-manager.mjs';
import { DaemonManager } from '../src/daemon-manager.mjs';
import { createApp } from '../src/main.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONSOLE_HTML_PATH = path.resolve(__dirname, '../src/console.html');

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'apr-test-'));
}

/** Local TCP echo server for verifying real end-to-end tunnel traffic */
function startEchoServer() {
  const srv = net.createServer((sock) => {
    sock.on('error', () => {});
    sock.on('data', (chunk) => sock.write(Buffer.concat([Buffer.from('ECHO:'), chunk])));
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => resolve({ server: srv, port: srv.address().port }));
  });
}

/** Minimal mock SOCKS5 server forwarding all domain CONNECT requests to a specified local echo port (records requested host!) */
function startMockSocks5Server({ redirectPort, onConnectHost } = {}) {
  const seenHosts = [];
  const srv = net.createServer((clientSock) => {
    clientSock.on('error', () => {});
    let step = 'greeting';
    let buf = Buffer.alloc(0);

    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (step === 'greeting') {
        if (buf.length < 2) return;
        const nmethods = buf[1];
        if (buf.length < 2 + nmethods) return;
        buf = buf.slice(2 + nmethods);
        step = 'request';
        clientSock.write(Buffer.from([0x05, 0x00]));
      }
      if (step === 'request') {
        if (buf.length < 5) return;
        const atyp = buf[3];
        let host = '';
        let end = 4;
        if (atyp === 0x03) {
          const len = buf[4];
          if (buf.length < 5 + len + 2) return;
          host = buf.slice(5, 5 + len).toString('utf8');
          end = 5 + len;
        } else if (atyp === 0x01) {
          if (buf.length < 10) return;
          host = `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`;
          end = 8;
        }
        const port = buf.readUInt16BE(end);
        const rem = buf.slice(end + 2);
        seenHosts.push({ host, port });
        onConnectHost?.(host, port);

        clientSock.removeListener('data', onData);
        const targetPort = redirectPort || port;
        const targetHost = redirectPort ? '127.0.0.1' : host;
        const up = net.connect(targetPort, targetHost, () => {
          clientSock.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0]));
          if (rem.length) up.write(rem);
          clientSock.pipe(up);
          up.pipe(clientSock);
        });
        up.on('error', () => clientSock.destroy());
        clientSock.on('close', () => up.destroy());
      }
    };
    clientSock.on('data', onData);
  });

  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => resolve({ server: srv, port: srv.address().port, seenHosts }));
  });
}

/** Minimal mock HTTP CONNECT & HTTP forwarding proxy server */
function startMockHttpProxyServer({ redirectPort } = {}) {
  const seenRequests = [];
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url);
    seenRequests.push({ method: req.method, host: u.hostname, port: u.port });
    const out = http.request({
      host: '127.0.0.1',
      port: redirectPort || u.port,
      path: u.pathname + u.search,
      method: req.method,
      headers: req.headers,
    }, (outRes) => {
      res.writeHead(outRes.statusCode, outRes.headers);
      outRes.pipe(res);
    });
    req.pipe(out);
  });
  srv.on('connect', (req, clientSock, head) => {
    const [host, portStr] = req.url.split(':');
    const port = parseInt(portStr, 10) || 443;
    seenRequests.push({ method: 'CONNECT', host, port });
    const up = net.connect(redirectPort || port, '127.0.0.1', () => {
      clientSock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) up.write(head);
      clientSock.pipe(up);
      up.pipe(clientSock);
    });
    up.on('error', () => clientSock.destroy());
    clientSock.on('close', () => up.destroy());
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => resolve({ server: srv, port: srv.address().port, seenRequests }));
  });
}

// =========================================================================
// 1. Matcher & ConfigStore tests
// =========================================================================
test('matcher: 14 preset rules, suffix/exact/wildcard, loopback, global, and Geo-Guard', () => {
  const dir = makeTmpDir();
  try {
    const store = new ConfigStore(dir);
    assert.equal(store.data.rules.length, 20);
    assert.equal(store.data.connectionMode, 'custom');
    assert.equal(store.data.routingMode, 'rule');

    const cfg = store.data;
    // Preset domains hit PRIMARY (including Antigravity 2.x hub/telemetry domains)
    for (const d of [
      'accounts.google.com',
      'generativelanguage.googleapis.com:443',
      'daily-cloudcode-pa.googleapis.com',
      'cloudcode-pa.googleapis.com',
      'aicode.googleapis.com',
      'future-api.googleapis.com',
      'open-vsx.org',
      'antigravity.dev',
      'sub.antigravity.com',
      'ANTIGRAVITY-UNLEASH.GOOG',
      'antigravity-hub-auto-updater-974169037036.us-central1.run.app',
      'play.googleapis.com',
      'jetski-webchannel.googleapis.com',
      'antigravity.google',
    ]) {
      const res = resolveRoute(d, cfg, false);
      assert.equal(res.action, 'PRIMARY', `Expected ${d} -> PRIMARY`);
      assert.equal(res.isNewDomain, false);
    }

    // Unlisted domain marks isNewDomain
    const unknown = resolveRoute('unlisted-example.org:443', cfg, false);
    assert.equal(unknown.action, 'DIRECT');
    assert.equal(unknown.isNewDomain, true);

    // Private / loopback always DIRECT even in global mode or geoBlocked
    cfg.routingMode = 'global';
    cfg.options.strictGeoGuard = true;
    for (const priv of ['127.0.0.1:52386', 'localhost', '[::1]:8080', '192.168.1.10', '10.0.0.5', '172.16.5.4']) {
      assert.equal(isPrivateOrLoopback(stripPort(priv)), true, `Expected ${priv} private`);
      assert.equal(resolveRoute(priv, cfg, true).action, 'DIRECT', `Expected ${priv} DIRECT even when geoBlocked`);
    }

    // Geo-Guard blocks external host when strictGeoGuard=true & geoBlocked=true
    assert.equal(resolveRoute('generativelanguage.googleapis.com', cfg, true).action, 'BLOCKED');

    // Wildcard rule
    assert.equal(matchDomain('foo.run.app', { domain: '*.run.app', type: 'wildcard', enabled: true }), true);
    assert.equal(matchDomain('run.app', { domain: '*.run.app', type: 'wildcard', enabled: true }), false);
    assert.equal(matchDomain('sub.example.com', { domain: 'example.com', type: 'exact', enabled: true }), false);

    // Disabled mode forces DIRECT
    cfg.connectionMode = 'disabled';
    assert.equal(resolveRoute('accounts.google.com', cfg, true).action, 'DIRECT');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// =========================================================================
// 2. Upstream client tests (DIRECT, SOCKS5, HTTP CONNECT, probeUpstream)
// =========================================================================
test('upstream-client: direct, socks5, http connect, and probeUpstream', async () => {
  const echo = await startEchoServer();
  const socks5 = await startMockSocks5Server({ redirectPort: echo.port });
  const httpProxy = await startMockHttpProxyServer({ redirectPort: echo.port });

  try {
    // Direct
    const s1 = await connectDirect('127.0.0.1', echo.port);
    const r1 = await new Promise((res) => {
      s1.once('data', (d) => res(d.toString()));
      s1.write('ping1');
    });
    assert.equal(r1, 'ECHO:ping1');
    s1.destroy();

    // SOCKS5
    const s2 = await connectViaSocks5({ protocol: 'socks5', host: '127.0.0.1', port: socks5.port }, 'accounts.google.com', 443);
    const r2 = await new Promise((res) => {
      s2.once('data', (d) => res(d.toString()));
      s2.write('ping2');
    });
    assert.equal(r2, 'ECHO:ping2');
    assert.equal(socks5.seenHosts[0].host, 'accounts.google.com');
    s2.destroy();

    // HTTP CONNECT
    const s3 = await connectViaHttpProxy({ protocol: 'http', host: '127.0.0.1', port: httpProxy.port }, 'antigravity.dev', 443);
    const r3 = await new Promise((res) => {
      s3.once('data', (d) => res(d.toString()));
      s3.write('ping3');
    });
    assert.equal(r3, 'ECHO:ping3');
    assert.equal(httpProxy.seenRequests[0].host, 'antigravity.dev');
    s3.destroy();

    // probeUpstream
    const probeOk = await probeUpstream({ protocol: 'socks5', host: '127.0.0.1', port: socks5.port }, 'daily-cloudcode-pa.googleapis.com', 443);
    assert.equal(probeOk.ok, true);
    assert.equal(typeof probeOk.latencyMs, 'number');
  } finally {
    echo.server.close();
    socks5.server.close();
    httpProxy.server.close();
  }
});

// =========================================================================
// 3. HealthMonitor & Geo-Guard whitelist/blacklist + auto-switch tests
// =========================================================================
test('health-monitor: whitelist default, blacklist switch, auto-switch, speedtest, and migration', async () => {
  const dir = makeTmpDir();
  try {
    // Verify legacy ['CN'] migration upgrades blockedCountries & sets whitelist default
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
      version: 1,
      options: { strictGeoGuard: true, blockedCountries: ['CN'] },
      proxies: [{ id: 'p-cn', label: 'Legacy', protocol: 'socks5', host: '127.0.0.1', port: 10808, enabled: true }],
      activeProxyId: 'p-cn',
    }), 'utf8');

    const store = new ConfigStore(dir);
    assert.equal(store.data.options.geoPolicyMode, 'whitelist');
    assert.ok(store.data.options.allowedCountries.includes('US'));
    assert.ok(store.data.options.blockedCountries.includes('HK'));
    assert.ok(store.data.options.blockedCountries.includes('RU'));

    const p1 = store.data.proxies[0];
    p1.label = 'FR Proxy';
    const p2 = {
      id: 'proxy-us-2',
      label: 'US Proxy',
      protocol: 'socks5',
      host: '127.0.0.1',
      port: 10809,
      enabled: true,
    };
    store.data.proxies.push(p2);
    store.data.options.strictGeoGuard = true;
    store.data.options.autoSwitch = true;
    store.save();

    let p2Country = 'US';
    const hm = new HealthMonitor(store, {
      geoLookupFn: async (proxy) => {
        if (proxy.id === p1.id) return { ok: true, latencyMs: 65, country: 'FR', exitIp: '1.2.3.4' };
        return { ok: true, latencyMs: 72, country: p2Country, exitIp: '8.8.8.8' };
      },
      google204Fn: async () => ({ ok: true, latencyMs: 68, statusCode: 204 }),
      speedTestFn: async () => ({ ok: true, downloadMbps: 88.5, uploadMbps: 24.1, error: null }),
    });

    await hm.checkAll({ forceAll: true });
    // In whitelist mode (default US, JP, SG...), FR is blocked even though it's not CN!
    assert.equal(hm.getStatus(p1.id).status, 'geo_blocked');
    assert.equal(hm.getStatus(p2.id).status, 'connected');
    assert.equal(hm.getStatus(p2.id).google204Ok, true);
    assert.equal(store.data.activeProxyId, p2.id);
    assert.equal(hm.isBlocked(), false);

    // Switch to blacklist mode -> FR becomes allowed, while HK/CN remain blocked
    store.updateOptions({ geoPolicyMode: 'blacklist' });
    hm.reconcileCountries();
    assert.equal(hm.getStatus(p1.id).status, 'connected');

    p2Country = 'HK';
    await hm.checkAll({ forceAll: true });
    assert.equal(hm.getStatus(p2.id).status, 'geo_blocked');

    // Speedtest updates proxy record
    const stAfterSpeed = await hm.runSpeedTest(p1);
    assert.equal(stAfterSpeed.downloadMbps, 88.5);
    assert.equal(stAfterSpeed.uploadMbps, 24.1);

    // Transient GeoIP failure grace: if GeoIP fails once while Google 204 still succeeds
    // for a recently verified compliant proxy, keep connected instead of false-positive 503.
    let failGeo = false;
    const hmGrace = new HealthMonitor(store, {
      geoLookupFn: async () => (failGeo
        ? { ok: false, latencyMs: null, country: null, exitIp: null, error: 'certificate has expired' }
        : { ok: true, latencyMs: 70, country: 'US', exitIp: '8.8.4.4' }),
      google204Fn: async () => ({ ok: true, latencyMs: 65, statusCode: 204 }),
    });
    store.updateOptions({ geoPolicyMode: 'whitelist', strictGeoGuard: true });
    store.update({ activeProxyId: p2.id });
    await hmGrace.checkProxy(p2);
    assert.equal(hmGrace.getStatus(p2.id).status, 'connected');
    failGeo = true;
    const graceRec = await hmGrace.checkProxy(p2);
    assert.equal(graceRec.status, 'connected');
    assert.equal(graceRec.country, 'US');
    assert.equal(hmGrace.isBlocked(), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// =========================================================================
// 4. ProxyServer E2E: HTTP CONNECT, SOCKS5 inbound, plain HTTP, Geo-Guard 503
// =========================================================================
test('proxy-server E2E: CONNECT, SOCKS5 inbound, Geo-Guard 503 block, and new domain capture', async () => {
  const dir = makeTmpDir();
  const echo = await startEchoServer();
  const mockSocks = await startMockSocks5Server({ redirectPort: echo.port });

  let blockedByGeo = false;
  let proxyServer;
  try {
    const store = new ConfigStore(dir);
    store.data.proxies[0].protocol = 'socks5';
    store.data.proxies[0].host = '127.0.0.1';
    store.data.proxies[0].port = mockSocks.port;
    store.data.options.strictGeoGuard = true;
    store.save();

    const fakeHm = {
      isBlocked: () => blockedByGeo,
      getStatus: () => ({ status: blockedByGeo ? 'geo_blocked' : 'connected' }),
    };

    proxyServer = new ProxyServer(store, fakeHm);
    const addr = await proxyServer.listen(0, '127.0.0.1');
    const gwPort = addr.port;

    // 4a. HTTP CONNECT to a preset domain (accounts.google.com) -> routed via mockSocks -> echo
    const resA = await new Promise((resolve, reject) => {
      const sock = net.connect(gwPort, '127.0.0.1', () => {
        sock.write('CONNECT accounts.google.com:443 HTTP/1.1\r\nHost: accounts.google.com:443\r\n\r\n');
      });
      sock.once('error', reject);
      let stage = 'headers';
      let buf = '';
      sock.on('data', (chunk) => {
        if (stage === 'headers') {
          buf += chunk.toString();
          if (buf.includes('\r\n\r\n')) {
            assert.match(buf, /^HTTP\/1\.1 200/);
            stage = 'tunnel';
            sock.write('hello-grpc');
          }
        } else {
          sock.destroy();
          resolve(chunk.toString());
        }
      });
    });
    assert.equal(resA, 'ECHO:hello-grpc');
    assert.equal(mockSocks.seenHosts.at(-1).host, 'accounts.google.com');

    // 4b. SOCKS5 inbound to daily-cloudcode-pa.googleapis.com -> routed via mockSocks -> echo
    const resB = await new Promise((resolve, reject) => {
      const sock = net.connect(gwPort, '127.0.0.1', () => {
        sock.write(Buffer.from([0x05, 0x01, 0x00]));
      });
      sock.once('error', reject);
      let phase = 'greet';
      sock.on('data', (chunk) => {
        if (phase === 'greet') {
          assert.deepEqual(chunk.slice(0, 2), Buffer.from([0x05, 0x00]));
          phase = 'connect';
          const domain = Buffer.from('daily-cloudcode-pa.googleapis.com');
          const req = Buffer.alloc(7 + domain.length);
          req[0] = 0x05; req[1] = 0x01; req[2] = 0x00; req[3] = 0x03;
          req[4] = domain.length;
          domain.copy(req, 5);
          req.writeUInt16BE(443, 5 + domain.length);
          sock.write(req);
        } else if (phase === 'connect') {
          assert.equal(chunk[1], 0x00);
          phase = 'data';
          sock.write('hello-socks5');
        } else {
          sock.destroy();
          resolve(chunk.toString());
        }
      });
    });
    assert.equal(resB, 'ECHO:hello-socks5');
    assert.equal(mockSocks.seenHosts.at(-1).host, 'daily-cloudcode-pa.googleapis.com');

    // 4c. Direct local unlisted host -> sets isNewDomain=true in logs
    const resDirect = await new Promise((resolve, reject) => {
      const sock = net.connect(gwPort, '127.0.0.1', () => {
        sock.write(`CONNECT 127.0.0.1:${echo.port} HTTP/1.1\r\nHost: 127.0.0.1:${echo.port}\r\n\r\n`);
      });
      sock.once('error', reject);
      let stage = 'headers';
      let buf = '';
      sock.on('data', (chunk) => {
        if (stage === 'headers') {
          buf += chunk.toString();
          if (buf.includes('\r\n\r\n')) { stage = 'data'; sock.write('local-ok'); }
        } else {
          sock.destroy();
          resolve(chunk.toString());
        }
      });
    });
    assert.equal(resDirect, 'ECHO:local-ok');

    // 4d. Geo-Guard BLOCKED -> returns 503 and does NOT hit mockSocks
    blockedByGeo = true;
    const countBeforeBlock = mockSocks.seenHosts.length;
    const resBlocked = await new Promise((resolve, reject) => {
      const sock = net.connect(gwPort, '127.0.0.1', () => {
        sock.write('CONNECT accounts.google.com:443 HTTP/1.1\r\nHost: accounts.google.com:443\r\n\r\n');
      });
      sock.once('error', reject);
      let out = '';
      sock.on('data', (c) => { out += c.toString(); });
      sock.on('end', () => resolve(out));
    });
    assert.match(resBlocked, /^HTTP\/1\.1 503 Service Unavailable/);
    assert.match(resBlocked, /Blocked by Geo-Guard/);
    assert.equal(mockSocks.seenHosts.length, countBeforeBlock);
    assert.equal(proxyServer.getLogs()[0].route, 'BLOCKED');

    // 4e. Verify real-time byte counters recorded TX & RX traffic
    const stats = proxyServer.getTrafficStats();
    assert.ok(stats.totalUpBytes > 0, 'Expected totalUpBytes > 0');
    assert.ok(stats.totalDownBytes > 0, 'Expected totalDownBytes > 0');
  } finally {
    await proxyServer?.close();
    echo.server.close();
    mockSocks.server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// =========================================================================
// 5. SettingsManager tests (JSONC, settings takeover/restore, env takeover)
// =========================================================================
test('settings-manager: JSONC parsing, takeover/restore with & without existing proxy, env takeover', () => {
  const dir = makeTmpDir();
  const settingsPath = path.join(dir, 'settings.json');
  const fakeEnv = new Map([['NO_PROXY', 'internal.corp']]);
  const envAdapter = {
    get: (k) => fakeEnv.get(k) ?? null,
    set: (k, v) => (v === null ? fakeEnv.delete(k) : fakeEnv.set(k, v)),
  };

  try {
    // Write JSONC with comments, URL string containing //, and trailing comma
    fs.writeFileSync(settingsPath, `{
      // User existing comment
      "editor.fontSize": 14,
      "http.proxy": "http://127.0.0.1:7890", // old proxy
      "custom.url": "https://example.com/a//b",
    }`, 'utf8');

    const parsed = parseJsonc(fs.readFileSync(settingsPath, 'utf8'));
    assert.equal(parsed['custom.url'], 'https://example.com/a//b');
    assert.equal(parsed['http.proxy'], 'http://127.0.0.1:7890');

    const store = new ConfigStore(dir);
    const sm = new SettingsManager({ settingsPath, envAdapter });

    // Enable takeover
    const st1 = sm.enableTakeover('127.0.0.1', 17890, store);
    assert.equal(st1.settingsTakenOver, true);
    assert.equal(st1.currentHttpProxy, 'http://127.0.0.1:17890');
    assert.equal(store.data.settingsBackup.httpProxy, 'http://127.0.0.1:7890');

    // Enabling twice must NOT overwrite original backup
    sm.enableTakeover('127.0.0.1', 17890, store);
    assert.equal(store.data.settingsBackup.httpProxy, 'http://127.0.0.1:7890');

    // Restore original
    const st2 = sm.restoreTakeover('127.0.0.1', 17890, store);
    assert.equal(st2.settingsTakenOver, false);
    assert.equal(st2.currentHttpProxy, 'http://127.0.0.1:7890');

    // Case 2: file without http.proxy restores cleanly by removing key
    fs.writeFileSync(settingsPath, JSON.stringify({ 'editor.tabSize': 2 }), 'utf8');
    sm.enableTakeover('127.0.0.1', 17890, store);
    assert.equal(sm.getTakeoverStatus('127.0.0.1', 17890, store).settingsTakenOver, true);
    const st3 = sm.restoreTakeover('127.0.0.1', 17890, store);
    assert.equal(st3.currentHttpProxy, null);

    // Env takeover + restore preserves NO_PROXY original values
    const e1 = sm.enableEnvTakeover('127.0.0.1', 17890, store);
    assert.equal(e1.envTakenOver, true);
    assert.equal(fakeEnv.get('HTTPS_PROXY'), 'http://127.0.0.1:17890');
    assert.match(fakeEnv.get('NO_PROXY'), /internal\.corp/);
    assert.match(fakeEnv.get('NO_PROXY'), /127\.0\.0\.1/);

    const e2 = sm.restoreEnvTakeover('127.0.0.1', 17890, store);
    assert.equal(e2.envTakenOver, false);
    assert.equal(fakeEnv.get('HTTPS_PROXY'), undefined);
    assert.equal(fakeEnv.get('NO_PROXY'), 'internal.corp');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// =========================================================================
// 7. DaemonManager autostart & Sidecar -> Daemon Bridge tests
// =========================================================================
test('daemon-manager autostart & sidecar-to-daemon HTTP bridge', async () => {
  const dir = makeTmpDir();
  const dirBridge = makeTmpDir();
  const fakeEnv = new Map();
  const envAdapter = {
    get: (k) => fakeEnv.get(k) ?? null,
    set: (k, v) => (v === null ? fakeEnv.delete(k) : fakeEnv.set(k, v)),
  };
  let runEntry = null;
  const registryAdapter = {
    getRunEntry: () => runEntry,
    setRunEntry: (v) => { runEntry = v; },
    deleteRunEntry: () => { runEntry = null; },
  };

  // Pick a free controlPort cleanly
  const probeSrv = net.createServer();
  await new Promise(r => probeSrv.listen(0, '127.0.0.1', r));
  const controlPort = probeSrv.address().port;
  await new Promise(r => probeSrv.close(r));

  const daemonApp = createApp({
    dataDir: dir,
    settingsPath: path.join(dir, 'settings.json'),
    envAdapter,
    registryAdapter,
    geoLookupFn: async () => ({ ok: true, latencyMs: 55, country: 'JP', exitIp: '2.2.2.2' }),
    google204Fn: async () => ({ ok: true, latencyMs: 51, statusCode: 204 }),
    isDaemonProcess: true,
    controlPort,
  });

  const sidecarApp = createApp({
    dataDir: dirBridge,
    settingsPath: path.join(dirBridge, 'settings.json'),
    envAdapter,
    registryAdapter,
    geoLookupFn: async () => ({ ok: true, latencyMs: 999, country: 'US', exitIp: '9.9.9.9' }),
    google204Fn: async () => ({ ok: true, latencyMs: 999, statusCode: 204 }),
    isDaemonProcess: false,
    controlPort,
  });

  try {
    await daemonApp.start({ proxyPort: 0 });
    await new Promise(r => setTimeout(r, 40));

    // Sidecar starts with allowBridge:true -> should NOT open its own proxy, should bridge to daemonApp
    const sStart = await sidecarApp.start({ webPort: 0, allowBridge: true });
    assert.equal(sStart.bridged, true);
    assert.equal(sidecarApp.proxyServer.isListening, false);

    // Sidecar /api/status must reflect daemon's JP exit country (NOT sidecar's fake US)
    const bridgedRes = await fetch(`http://127.0.0.1:${sStart.webAddr.port}/api/status`);
    assert.equal(bridgedRes.status, 200);
    const bridgedStatus = await bridgedRes.json();
    assert.equal(bridgedStatus.activeCountry, 'JP');
    assert.equal(bridgedStatus.daemon.running, true);
    assert.equal(bridgedStatus.hostEnv.reportedBySidecar, true);
    assert.equal(typeof bridgedStatus.hostEnv.effective, 'boolean');

    // Sidecar /api/identity still identifies itself as bridge
    const idRes = await fetch(`http://127.0.0.1:${sStart.webAddr.port}/api/identity`);
    const idData = await idRes.json();
    assert.equal(idData.mode, 'bridge');

    // Autostart toggle & safety env restore on stopDaemon
    const dm = daemonApp.daemonManager;
    assert.equal(dm.setAutostart(true), true);
    assert.match(runEntry, /start-hidden\.vbs/);
    assert.equal(dm.setAutostart(false), false);

    daemonApp.settingsManager.enableEnvTakeover('127.0.0.1', daemonApp.configStore.data.listenPort, daemonApp.configStore);
    assert.ok(fakeEnv.get('HTTPS_PROXY'));
    await dm.stopDaemon({ settingsManager: daemonApp.settingsManager, configStore: daemonApp.configStore });
    assert.equal(fakeEnv.get('HTTPS_PROXY'), undefined, 'stopDaemon must restore HTTPS_PROXY automatically');

    // Duplicate --daemon launch exits immediately as alreadyRunning
    const dupDaemon = createApp({
      dataDir: dir,
      settingsPath: path.join(dir, 'settings.json'),
      envAdapter,
      registryAdapter,
      geoLookupFn: async () => ({ ok: true, latencyMs: 55, country: 'JP', exitIp: '2.2.2.2' }),
      google204Fn: async () => ({ ok: true, latencyMs: 51, statusCode: 204 }),
      isDaemonProcess: true,
      controlPort,
    });
    const dupRes = await dupDaemon.start({ proxyPort: 0 });
    assert.equal(dupRes.alreadyRunning, true);
  } finally {
    await sidecarApp.stop();
    await daemonApp.stop();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(dirBridge, { recursive: true, force: true });
  }
});

// =========================================================================
// 6. Main App HTTP API & Static UI Layout Probes
// =========================================================================
test('main REST API lifecycle and console.html static probes', async () => {
  const dir = makeTmpDir();
  const settingsPath = path.join(dir, 'settings.json');
  const fakeEnv = new Map();
  const app = createApp({
    dataDir: dir,
    settingsPath,
    envAdapter: {
      get: (k) => fakeEnv.get(k) ?? null,
      set: (k, v) => (v === null ? fakeEnv.delete(k) : fakeEnv.set(k, v)),
    },
    registryAdapter: { getRunEntry: () => null, setRunEntry: () => {}, deleteRunEntry: () => {} },
    geoLookupFn: async () => ({ ok: true, latencyMs: 68, country: 'US', exitIp: '9.9.9.9' }),
    google204Fn: async () => ({ ok: true, latencyMs: 64, statusCode: 204 }),
    speedTestFn: async () => ({ ok: true, downloadMbps: 120.5, uploadMbps: 34.2, error: null }),
  });

  try {
    const { webAddr } = await app.start({ proxyPort: 0, webPort: 0 });
    const base = `http://127.0.0.1:${webAddr.port}`;

    // No wait needed: initial probe settles before proxyServer starts listening
    const stRes = await fetch(`${base}/api/status`);
    assert.equal(stRes.status, 200);
    const st = await stRes.json();
    assert.equal(st.gateway.listening, true);
    assert.equal(st.activeCountry, 'US');
    assert.equal(st.geoBlocked, false);
    assert.ok(st.traffic && typeof st.traffic.uploadBps === 'number');

    // Speedtest API
    const spRes = await fetch(`${base}/api/proxies/speedtest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(spRes.status, 200);
    const spData = await spRes.json();
    const activeHealth = spData.health[spData.config.activeProxyId];
    assert.equal(activeHealth.downloadMbps, 120.5);
    assert.equal(activeHealth.uploadMbps, 34.2);

    // Bulk add rules
    const bulkRes = await fetch(`${base}/api/rules/bulk-add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'custom-one.example\ncustom-two.example' }),
    });
    const bulkData = await bulkRes.json();
    assert.equal(bulkData.added, 2);

    // Probe domain API
    const probeRes = await fetch(`${base}/api/test-domain`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain: 'custom-one.example' }),
    });
    const probeData = await probeRes.json();
    assert.equal(probeData.action, 'PRIMARY');

    // Verify HTML endpoint
    const htmlRes = await fetch(`${base}/`);
    assert.equal(htmlRes.status, 200);
    const html = await htmlRes.text();
    assert.match(html, /Proxy Router/);
  } finally {
    await app.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // Static UI probes (Zero deps + 4 Tabs + Rule 09 Single Scrollport Law)
  const uiHtml = fs.readFileSync(CONSOLE_HTML_PATH, 'utf8');
  assert.ok(!/<script[^>]+src=/i.test(uiHtml), 'console.html must not contain external <script src=...>');
  assert.ok(!/<link[^>]+rel=["']stylesheet["']/i.test(uiHtml), 'console.html must not contain external stylesheet links');
  assert.ok(uiHtml.includes('max-height: calc(100vh - var(--chrome-height))'), 'Scroll host must respect chrome height budget');
  assert.ok(/--scrollbar-size\s*:/.test(uiHtml), 'Scrollbar size must use --scrollbar-size token');
  assert.ok(uiHtml.includes('--container-max'), 'Must define responsive desktop --container-max token');
  assert.ok(uiHtml.includes('@media (min-width: 840px)'), 'Must adapt layout for wide desktop browser windows');
  assert.ok(!uiHtml.includes('系统代理'), 'Must not expose Windows system proxy UI');
  assert.ok(uiHtml.includes('id="toggle-log-dedup-btn"'), 'Must expose log deduplication toggle');
  for (const cat of ['all', 'proxy', 'direct', 'error', 'new']) {
    assert.ok(uiHtml.includes(`data-log-cat="${cat}"`), `Missing log category ${cat}`);
  }
  for (const tabId of ['proxies', 'guard', 'rules', 'logs']) {
    assert.ok(uiHtml.includes(`data-tab="${tabId}"`), `Missing tab ${tabId}`);
  }
});
