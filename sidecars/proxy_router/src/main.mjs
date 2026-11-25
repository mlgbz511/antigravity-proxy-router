// main.mjs — Antigravity Proxy Router Sidecar + Detached Daemon dual-mode entry point
import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { ConfigStore } from './config-store.mjs';
import { resolveRoute } from './matcher.mjs';
import { HealthMonitor } from './health-monitor.mjs';
import { ProxyServer } from './proxy-server.mjs';
import { SettingsManager } from './settings-manager.mjs';
import { DaemonManager, probeControlEndpoint } from './daemon-manager.mjs';

const CONSOLE_HTML_URL = new URL('./console.html', import.meta.url);
const DEFAULT_CONTROL_PORT = parseInt(process.env.ANTIGRAVITY_PROXY_ROUTER_CONTROL_PORT || '17891', 10) || 17891;

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1_048_576) {
        req.destroy();
        reject(new Error('Request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.once('error', reject);
  });
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'upgrade',
  'te',
  'trailer',
]);

function stripHopByHop(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    const lk = k.toLowerCase();
    if (lk === 'host' || HOP_BY_HOP_HEADERS.has(lk)) continue;
    out[k] = v;
  }
  return out;
}

function forwardToDaemon(req, res, targetHost, targetPort, extraHeaders = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    const headers = { ...stripHopByHop(req.headers), ...extraHeaders };
    const outReq = http.request({
      host: targetHost,
      port: targetPort,
      path: req.url || '/',
      method: req.method,
      headers,
      agent: false,
      timeout: 5000,
    }, (outRes) => {
      res.writeHead(outRes.statusCode || 200, stripHopByHop(outRes.headers));
      outRes.pipe(res);
      outRes.once('end', () => done(true));
    });
    outReq.on('timeout', () => { outReq.destroy(); done(false); });
    outReq.on('error', () => done(false));
    req.pipe(outReq);
  });
}

export function createApp({
  dataDir,
  settingsPath,
  envAdapter,
  registryAdapter,
  geoLookupFn,
  google204Fn,
  speedTestFn,
  isDaemonProcess = false,
  controlHost = '127.0.0.1',
  controlPort = DEFAULT_CONTROL_PORT,
  disableBridge = false,
} = {}) {
  const configStore = new ConfigStore(dataDir);
  const healthMonitor = new HealthMonitor(configStore, { geoLookupFn, google204Fn, speedTestFn });
  const proxyServer = new ProxyServer(configStore, healthMonitor);
  const settingsManager = new SettingsManager({ settingsPath, envAdapter });
  const daemonManager = new DaemonManager({
    dataDir,
    controlHost,
    controlPort,
    isDaemonProcess,
    registryAdapter,
  });

  let bridged = false;
  let bridgeEligible = false;
  let reportedHostEnv = null;

  function buildLocalHostEnv(listenHost, listenPort) {
    const expectedUrl = `http://${listenHost}:${listenPort}`;
    const httpsProxy = process.env.HTTPS_PROXY || process.env.https_proxy || null;
    const httpProxy = process.env.HTTP_PROXY || process.env.http_proxy || null;
    return {
      httpsProxy,
      httpProxy,
      noProxy: process.env.NO_PROXY || process.env.no_proxy || null,
      effective: httpsProxy === expectedUrl,
      reportedBySidecar: !isDaemonProcess,
    };
  }

  async function getFullStatus() {
    const cfg = configStore.data;
    const active = configStore.getActiveProxy();
    const health = healthMonitor.getAllStatuses();
    const activeHealth = active ? health[active.id] : null;
    const takeover = await settingsManager.getTakeoverStatusAsync(cfg.listenHost, cfg.listenPort, configStore);
    const envConflicts = settingsManager.checkEnvironmentConflicts(cfg.listenHost, cfg.listenPort);
    const daemon = await daemonManager.getStatus();
    const hostEnv = isDaemonProcess
      ? (reportedHostEnv || { httpsProxy: null, httpProxy: null, noProxy: null, effective: null, reportedBySidecar: false })
      : buildLocalHostEnv(cfg.listenHost, cfg.listenPort);

    return {
      gateway: {
        listening: proxyServer.isListening,
        host: cfg.listenHost,
        port: cfg.listenPort,
        error: proxyServer.listenError,
      },
      traffic: proxyServer.getTrafficStats(),
      geoBlocked: healthMonitor.isBlocked(),
      activeCountry: activeHealth?.country || null,
      activeExitIp: activeHealth?.exitIp || null,
      config: cfg,
      health,
      takeover,
      hostEnv,
      shortcutStatus: daemonManager.getShortcutStatus({ configStore }),
      envConflicts,
      daemon,
    };
  }

  async function trySelfHealBridge() {
    if (!bridgeEligible || bridged || proxyServer.isListening) return false;
    const live = await probeControlEndpoint(controlHost, controlPort, 800);
    if (!live) return false;
    healthMonitor.stop();
    bridged = true;
    daemonManager.setBridgeMode(true);
    return true;
  }

  async function switchFromBridgeToLocal() {
    bridged = false;
    daemonManager.setBridgeMode(false);
    if (!proxyServer.isListening) {
      try {
        await proxyServer.listen();
      } catch (err) {
        console.error(`[proxy-router] Failed to resume local gateway: ${err.message}`);
      }
      healthMonitor.start();
    }
  }

  async function switchFromLocalToBridge() {
    healthMonitor.stop();
    await proxyServer.close();
    const res = await daemonManager.startDaemon();
    const live = await probeControlEndpoint(controlHost, controlPort, 500);
    if (live) {
      bridged = true;
      daemonManager.setBridgeMode(true);
      return { ok: true, res };
    }
    // Rollback to local if daemon failed to start
    await switchFromBridgeToLocal();
    return { ok: false, res };
  }

  const webServer = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const pathname = url.pathname;

    try {
      // Identity endpoint always belongs to THIS process
      if (req.method === 'GET' && pathname === '/api/identity') {
        sendJson(res, 200, {
          service: 'antigravity-proxy-router',
          pid: process.pid,
          mode: bridged ? 'bridge' : (isDaemonProcess ? 'daemon' : 'sidecar'),
          proxyListening: proxyServer.isListening,
        });
        return;
      }

      // If Sidecar is bridging to the running daemon, intercept stop-daemon seamlessly
      if (bridged && req.method === 'POST' && pathname === '/api/daemon') {
        const body = await readJsonBody(req);
        if (body.action === 'stop') {
          await daemonManager.stopDaemon({ settingsManager, configStore });
          // Wait briefly for daemon to release 17890
          for (let i = 0; i < 20; i++) {
            const stillAlive = await probeControlEndpoint(controlHost, controlPort, 150);
            if (!stillAlive) break;
            await new Promise(r => setTimeout(r, 120));
          }
          await switchFromBridgeToLocal();
          sendJson(res, 200, await getFullStatus());
          return;
        }
      }

      // Accept live host-env report piggybacked by Antigravity Sidecar bridge
      if (isDaemonProcess && req.headers['x-agy-host-reported'] === '1') {
        const cfg = configStore.data;
        const expectedUrl = `http://${cfg.listenHost}:${cfg.listenPort}`;
        const hp = String(req.headers['x-agy-host-https-proxy'] || '').trim() || null;
        const hpHttp = String(req.headers['x-agy-host-http-proxy'] || '').trim() || null;
        reportedHostEnv = {
          httpsProxy: hp,
          httpProxy: hpHttp,
          noProxy: null,
          effective: hp === expectedUrl,
          reportedBySidecar: true,
        };
      }

      // Self-heal bridge if Sidecar booted earlier than Daemon or missed initial probe on EADDRINUSE
      if (!bridged && bridgeEligible && !proxyServer.isListening && pathname !== '/api/identity') {
        await trySelfHealBridge();
      }

      // Transparent HTTP bridge to daemon when running as Sidecar bridge
      if (bridged) {
        const bridgeHeaders = {
          'x-agy-host-reported': '1',
          'x-agy-host-https-proxy': process.env.HTTPS_PROXY || process.env.https_proxy || '',
          'x-agy-host-http-proxy': process.env.HTTP_PROXY || process.env.http_proxy || '',
        };
        const ok = await forwardToDaemon(req, res, controlHost, controlPort, bridgeHeaders);
        if (ok) return;
        // Brief grace check in case daemon is in the middle of a quick restart
        for (let i = 0; i < 4; i++) {
          await new Promise(r => setTimeout(r, 400));
          const stillUp = await probeControlEndpoint(controlHost, controlPort, 500);
          if (stillUp) {
            const retryOk = await forwardToDaemon(req, res, controlHost, controlPort, bridgeHeaders);
            if (retryOk) return;
          }
        }
        // Daemon truly exited -> seamlessly recover local gateway
        await switchFromBridgeToLocal();
      }

      if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
        const html = fs.readFileSync(CONSOLE_HTML_URL, 'utf8');
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(html);
        return;
      }

      if (req.method === 'GET' && pathname === '/api/status') {
        sendJson(res, 200, await getFullStatus());
        return;
      }

      if (req.method === 'POST' && pathname === '/api/daemon') {
        const body = await readJsonBody(req);
        const action = body.action || 'status';
        if (action === 'start') {
          if (!isDaemonProcess) {
            const { ok } = await switchFromLocalToBridge();
            if (!ok) return sendJson(res, 500, { error: 'Failed to launch background daemon' });
            const stRes = await fetch(`http://${controlHost}:${controlPort}/api/status`);
            sendJson(res, 200, await stRes.json());
            return;
          }
        } else if (action === 'stop') {
          const stopRes = await daemonManager.stopDaemon({ settingsManager, configStore });
          if (stopRes.self) {
            sendJson(res, 200, { ...(await getFullStatus()), stopping: true });
            setTimeout(() => {
              appHandle.stop().finally(() => process.exit(0));
            }, 80);
            return;
          }
        } else if (action === 'autostart-on') {
          daemonManager.setAutostart(true);
        } else if (action === 'autostart-off') {
          daemonManager.setAutostart(false);
        } else {
          return sendJson(res, 400, { error: `Unknown daemon action: ${action}` });
        }
        sendJson(res, 200, await getFullStatus());
        return;
      }

      if (req.method === 'POST' && pathname === '/api/shutdown') {
        await daemonManager.stopDaemon({ settingsManager, configStore });
        sendJson(res, 200, { ok: true, stopping: true });
        setTimeout(() => {
          appHandle.stop().finally(() => process.exit(0));
        }, 80);
        return;
      }

      if (req.method === 'POST' && pathname === '/api/launch-antigravity') {
        const body = await readJsonBody(req);
        const launchRes = daemonManager.launchAntigravity({
          settingsManager,
          configStore,
          restart: body.restart !== false,
        });
        sendJson(res, 200, { ...launchRes, status: await getFullStatus() });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/shortcuts') {
        const body = await readJsonBody(req);
        const action = body.action || 'takeover';
        if (action === 'restore') {
          daemonManager.restoreShortcuts({ configStore });
        } else {
          daemonManager.takeoverShortcuts({
            configStore,
            listenPort: configStore.data.listenPort,
          });
        }
        sendJson(res, 200, await getFullStatus());
        return;
      }

      if (req.method === 'POST' && pathname === '/api/refresh-shell') {
        const resShell = settingsManager.refreshDesktopShell();
        sendJson(res, 200, { ...resShell, status: await getFullStatus() });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/config') {
        const body = await readJsonBody(req);
        const cfg = configStore.data;
        if (body.connectionMode && ['disabled', 'custom'].includes(body.connectionMode)) {
          cfg.connectionMode = body.connectionMode;
        }
        if (body.routingMode && ['rule', 'global'].includes(body.routingMode)) {
          cfg.routingMode = body.routingMode;
        }
        if (body.options && typeof body.options === 'object') {
          let needReconcile = false;
          if (body.options.geoPolicyMode && ['whitelist', 'blacklist'].includes(body.options.geoPolicyMode)) {
            cfg.options.geoPolicyMode = body.options.geoPolicyMode;
            needReconcile = true;
          }
          if (Array.isArray(body.options.allowedCountries)) {
            body.options.allowedCountries = [...new Set(
              body.options.allowedCountries.map(c => String(c).trim().toUpperCase()).filter(Boolean)
            )];
            needReconcile = true;
          }
          if (Array.isArray(body.options.blockedCountries)) {
            body.options.blockedCountries = [...new Set(
              body.options.blockedCountries.map(c => String(c).trim().toUpperCase()).filter(Boolean)
            )];
            needReconcile = true;
          }
          Object.assign(cfg.options, body.options);
          if (needReconcile) {
            healthMonitor.reconcileCountries();
          }
        }
        configStore.save();
        sendJson(res, 200, await getFullStatus());
        return;
      }

      if (req.method === 'POST' && pathname === '/api/proxies') {
        const body = await readJsonBody(req);
        const cfg = configStore.data;
        const action = body.action || 'add';

        if (action === 'add') {
          const proxy = {
            id: crypto.randomUUID(),
            label: String(body.label || `${String(body.protocol || 'socks5').toUpperCase()} ${body.host || '127.0.0.1'}:${body.port}`).trim(),
            protocol: body.protocol === 'http' ? 'http' : 'socks5',
            host: String(body.host || '127.0.0.1').trim(),
            port: parseInt(body.port, 10) || 10808,
            username: String(body.username || ''),
            password: String(body.password || ''),
            enabled: body.enabled !== false,
          };
          cfg.proxies.push(proxy);
          if (!cfg.activeProxyId) cfg.activeProxyId = proxy.id;
          configStore.save();
          healthMonitor.checkProxy(proxy).catch(() => {});
        } else if (action === 'update') {
          const p = cfg.proxies.find(item => item.id === body.id);
          if (!p) return sendJson(res, 404, { error: 'Proxy not found' });
          if (body.label !== undefined) p.label = String(body.label).trim();
          if (body.protocol !== undefined) p.protocol = body.protocol === 'http' ? 'http' : 'socks5';
          if (body.host !== undefined) p.host = String(body.host).trim();
          if (body.port !== undefined) p.port = parseInt(body.port, 10) || p.port;
          if (body.username !== undefined) p.username = String(body.username);
          if (body.password !== undefined) p.password = String(body.password);
          if (body.enabled !== undefined) p.enabled = Boolean(body.enabled);
          configStore.save();
          healthMonitor.checkProxy(p).catch(() => {});
        } else if (action === 'delete') {
          cfg.proxies = cfg.proxies.filter(item => item.id !== body.id);
          if (cfg.activeProxyId === body.id) {
            cfg.activeProxyId = cfg.proxies.find(p => p.enabled)?.id || null;
          }
          configStore.save();
        } else if (action === 'set-active') {
          const p = cfg.proxies.find(item => item.id === body.id);
          if (!p) return sendJson(res, 404, { error: 'Proxy not found' });
          p.enabled = true;
          cfg.activeProxyId = p.id;
          configStore.save();
          healthMonitor.checkProxy(p).catch(() => {});
        } else {
          return sendJson(res, 400, { error: `Unknown proxy action: ${action}` });
        }

        sendJson(res, 200, await getFullStatus());
        return;
      }

      if (req.method === 'POST' && pathname === '/api/proxies/test') {
        const body = await readJsonBody(req);
        if (body.id) {
          const p = configStore.data.proxies.find(item => item.id === body.id);
          if (!p) return sendJson(res, 404, { error: 'Proxy not found' });
          await healthMonitor.checkProxy(p);
          healthMonitor.tryAutoSwitch();
        } else {
          await healthMonitor.checkAll({ forceAll: true });
        }
        sendJson(res, 200, await getFullStatus());
        return;
      }

      if (req.method === 'POST' && pathname === '/api/proxies/speedtest') {
        const body = await readJsonBody(req);
        const target = body.id
          ? configStore.data.proxies.find(item => item.id === body.id)
          : configStore.getActiveProxy();
        if (!target) return sendJson(res, 404, { error: 'Proxy not found' });
        await healthMonitor.runSpeedTest(target);
        sendJson(res, 200, await getFullStatus());
        return;
      }

      if (req.method === 'POST' && pathname === '/api/rules') {
        const body = await readJsonBody(req);
        const cfg = configStore.data;
        const action = body.action || 'add';

        if (action === 'add') {
          const domain = String(body.domain || '').trim().toLowerCase();
          if (!domain) return sendJson(res, 400, { error: 'Domain is required' });
          const type = ['exact', 'suffix', 'wildcard'].includes(body.type) ? body.type : 'suffix';
          const existing = cfg.rules.find(r => r.domain.toLowerCase() === domain && r.type === type);
          if (existing) {
            existing.enabled = true;
          } else {
            cfg.rules.unshift({ id: crypto.randomUUID(), domain, type, enabled: true });
          }
          configStore.save();
        } else if (action === 'toggle') {
          const r = cfg.rules.find(item => item.id === body.id);
          if (!r) return sendJson(res, 404, { error: 'Rule not found' });
          r.enabled = body.enabled !== undefined ? Boolean(body.enabled) : !r.enabled;
          configStore.save();
        } else if (action === 'delete') {
          cfg.rules = cfg.rules.filter(item => item.id !== body.id);
          configStore.save();
        } else if (action === 'update') {
          const r = cfg.rules.find(item => item.id === body.id);
          if (!r) return sendJson(res, 404, { error: 'Rule not found' });
          if (body.domain) r.domain = String(body.domain).trim().toLowerCase();
          if (['exact', 'suffix', 'wildcard'].includes(body.type)) r.type = body.type;
          if (body.enabled !== undefined) r.enabled = Boolean(body.enabled);
          configStore.save();
        } else {
          return sendJson(res, 400, { error: `Unknown rule action: ${action}` });
        }

        sendJson(res, 200, await getFullStatus());
        return;
      }

      if (req.method === 'POST' && pathname === '/api/rules/reset') {
        configStore.resetRules();
        sendJson(res, 200, await getFullStatus());
        return;
      }

      if (req.method === 'POST' && pathname === '/api/rules/bulk-add') {
        const body = await readJsonBody(req);
        const text = String(body.text || '');
        const type = ['exact', 'suffix', 'wildcard'].includes(body.type) ? body.type : 'suffix';
        const domains = text
          .split(/[\r\n,;\s]+/)
          .map(s => s.trim().toLowerCase())
          .filter(Boolean);

        const cfg = configStore.data;
        let added = 0;
        for (const domain of domains) {
          if (!cfg.rules.some(r => r.domain.toLowerCase() === domain)) {
            cfg.rules.push({ id: crypto.randomUUID(), domain, type, enabled: true });
            added++;
          }
        }
        configStore.save();
        sendJson(res, 200, { added, ...(await getFullStatus()) });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/takeover') {
        const body = await readJsonBody(req);
        const cfg = configStore.data;
        const target = body.target || 'env';
        const action = body.action || 'enable';

        if (target === 'settings') {
          if (action === 'enable') settingsManager.enableTakeover(cfg.listenHost, cfg.listenPort, configStore);
          else settingsManager.restoreTakeover(cfg.listenHost, cfg.listenPort, configStore);
        } else if (target === 'env') {
          if (action === 'enable') settingsManager.enableEnvTakeover(cfg.listenHost, cfg.listenPort, configStore);
          else settingsManager.restoreEnvTakeover(cfg.listenHost, cfg.listenPort, configStore);
        } else {
          return sendJson(res, 400, { error: `Unknown takeover target: ${target}` });
        }

        sendJson(res, 200, await getFullStatus());
        return;
      }

      if (req.method === 'POST' && pathname === '/api/test-domain') {
        const body = await readJsonBody(req);
        const domain = String(body.domain || '').trim();
        if (!domain) return sendJson(res, 400, { error: 'Domain is required' });
        const result = resolveRoute(domain, configStore.data, healthMonitor.isBlocked());
        sendJson(res, 200, { domain, ...result });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/logs') {
        sendJson(res, 200, { logs: proxyServer.getLogs() });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/connections') {
        sendJson(res, 200, { connections: proxyServer.getActiveConnections() });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/connections/close') {
        const body = await readJsonBody(req);
        const ok = body.id ? proxyServer.closeConnection(String(body.id)) : false;
        sendJson(res, 200, { ok, connections: proxyServer.getActiveConnections() });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/logs/clear') {
        proxyServer.clearLogs();
        sendJson(res, 200, { logs: [] });
        return;
      }

      sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
  });

  const appHandle = {
    configStore,
    healthMonitor,
    proxyServer,
    settingsManager,
    daemonManager,
    webServer,
    get isBridged() { return bridged; },
    async start({ proxyPort, webPort, allowBridge = false } = {}) {
      const uiPort = webPort ?? (
        isDaemonProcess
          ? controlPort
          : (parseInt(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || String(controlPort), 10) || controlPort)
      );

      // Single-instance guard for --daemon
      if (isDaemonProcess) {
        const existingDaemon = await probeControlEndpoint(controlHost, controlPort, 800);
        if (existingDaemon) {
          return {
            alreadyRunning: true,
            bridged: false,
            proxyAddr: null,
            webAddr: { address: '127.0.0.1', port: controlPort },
          };
        }
      }

      bridgeEligible = !disableBridge && !isDaemonProcess && (allowBridge || (proxyPort === undefined && webPort === undefined)) && uiPort !== controlPort;
      if (bridgeEligible) {
        const existing = await probeControlEndpoint(controlHost, controlPort, 1200);
        if (existing) {
          bridged = true;
          daemonManager.setBridgeMode(true);
        }
      }

      const bindWebServer = async () => {
        if (webServer.listening) return;
        await new Promise((resolve, reject) => {
          webServer.once('error', reject);
          webServer.listen(uiPort, '127.0.0.1', resolve);
        });
      };

      // Sidecar binds UI immediately so Antigravity Aux Pane never stalls; Daemon waits until gateway+GeoIP are ready.
      if (!isDaemonProcess) {
        try {
          await bindWebServer();
        } catch (err) {
          healthMonitor.stop();
          await proxyServer.close();
          throw err;
        }
      }

      if (!bridged) {
        // Complete initial probe (up to 4s) before opening proxy port so strictGeoGuard never
        // emits false-positive 'unknown' BLOCKED responses when GeoIP falls back on cold boot.
        await Promise.race([
          healthMonitor.checkAll({ forceAll: true }).catch(() => {}),
          new Promise(r => setTimeout(r, 4000)),
        ]);

        const maxAttempts = isDaemonProcess ? 12 : 1;
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
          try {
            await proxyServer.listen(proxyPort);
            break;
          } catch (err) {
            if (isDaemonProcess && err?.code === 'EADDRINUSE' && attempt < maxAttempts - 1) {
              await new Promise(r => setTimeout(r, 250));
              continue;
            }
            // If 17890 is held by a slow/starting daemon, re-probe controlPort before giving up
            if (bridgeEligible) {
              await new Promise(r => setTimeout(r, 250));
              const existing = await probeControlEndpoint(controlHost, controlPort, 1200);
              if (existing) {
                bridged = true;
                daemonManager.setBridgeMode(true);
              }
            }
            if (!bridged && attempt === maxAttempts - 1) {
              console.error(`[proxy-router] Failed to start proxy gateway: ${err.message}`);
            }
          }
        }
        if (!bridged) {
          healthMonitor.start({ skipInitial: true });
          if (isDaemonProcess) {
            daemonManager.writePidFile(process.pid);
          } else if (bridgeEligible) {
            // If a daemon restarts later while Sidecar is temporarily holding 17890, yield back automatically.
            const yieldTimer = setInterval(async () => {
              if (bridged || !proxyServer.isListening) return;
              const dm = await probeControlEndpoint(controlHost, controlPort, 400);
              if (dm && dm.mode === 'daemon') {
                healthMonitor.stop();
                await proxyServer.close();
                bridged = true;
                daemonManager.setBridgeMode(true);
                clearInterval(yieldTimer);
              }
            }, 1500);
            yieldTimer.unref?.();
          }
        }
      }

      if (isDaemonProcess) {
        try {
          await bindWebServer();
        } catch (err) {
          healthMonitor.stop();
          await proxyServer.close();
          daemonManager.removePidFile();
          throw err;
        }
      }

      if (bridged) {
        // Push live Antigravity process env status to daemon immediately on Sidecar boot
        const reportReq = http.request({
          host: controlHost,
          port: controlPort,
          path: '/api/identity',
          method: 'GET',
          agent: false,
          timeout: 1000,
          headers: {
            'x-agy-host-reported': '1',
            'x-agy-host-https-proxy': process.env.HTTPS_PROXY || process.env.https_proxy || '',
            'x-agy-host-http-proxy': process.env.HTTP_PROXY || process.env.http_proxy || '',
          },
        }, (r) => r.resume());
        reportReq.on('error', () => {});
        reportReq.end();
      }

      return {
        alreadyRunning: false,
        bridged,
        proxyAddr: proxyServer.isListening ? { host: configStore.data.listenHost, port: configStore.data.listenPort } : null,
        webAddr: webServer.address(),
      };
    },
    async stop() {
      healthMonitor.stop();
      await proxyServer.close();
      if (isDaemonProcess) {
        daemonManager.removePidFile();
      }
      await new Promise((resolve) => webServer.close(() => resolve()));
    },
  };

  return appHandle;
}

// Run directly as Sidecar or Daemon process
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (isMain) {
  const isDaemonFlag = process.argv.includes('--daemon') || process.env.ANTIGRAVITY_PROXY_ROUTER_DAEMON === '1';
  const app = createApp({ isDaemonProcess: isDaemonFlag });
  app.start().then(({ alreadyRunning, bridged: isBr, webAddr }) => {
    if (alreadyRunning) {
      console.log(`[proxy-router] Daemon already running at ${app.daemonManager.controlUrl}; exiting cleanly.`);
      process.exit(0);
      return;
    }
    const cfg = app.configStore.data;
    if (isBr) {
      console.log(`[proxy-router] Sidecar bridged to running daemon at ${app.daemonManager.controlUrl}`);
    } else {
      console.log(`[proxy-router] Gateway (${isDaemonFlag ? 'daemon' : 'sidecar'}) listening on ${cfg.listenHost}:${cfg.listenPort}`);
    }
    console.log(`[proxy-router] Console UI listening on http://127.0.0.1:${webAddr?.port}`);
  }).catch((err) => {
    console.error('[proxy-router] Fatal startup error:', err);
    process.exit(1);
  });

  const shutdown = () => {
    app.stop().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
