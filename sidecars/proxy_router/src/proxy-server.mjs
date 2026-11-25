// proxy-server.mjs — Single-port SOCKS5 / HTTP CONNECT / HTTP proxy gateway with Geo-Guard & logging
import net from 'node:net';
import http from 'node:http';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveRoute, stripPort } from './matcher.mjs';
import { connectDirect, connectViaProxy } from './upstream-client.mjs';

const execFileAsync = promisify(execFile);
const MAX_LOGS = 100;

let procCache = { at: 0, tcpMap: new Map(), nameMap: new Map(), inflight: null };

async function resolveLoopbackProcess(sourcePort, listenPort) {
  if (process.platform !== 'win32' || !sourcePort || !listenPort) return null;
  const now = Date.now();
  if (now - procCache.at > 2000) {
    if (!procCache.inflight) {
      procCache.inflight = (async () => {
        try {
          const [{ stdout: netOut }, { stdout: taskOut }] = await Promise.all([
            execFileAsync('netstat.exe', ['-ano', '-p', 'tcp'], { encoding: 'utf8', windowsHide: true, timeout: 2000 }),
            execFileAsync('tasklist.exe', ['/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true, timeout: 2000 }),
          ]);
          const tcpMap = new Map();
          for (const line of netOut.split(/\r?\n/)) {
            const m = line.match(/^\s*TCP\s+127\.0\.0\.1:(\d+)\s+127\.0\.0\.1:(\d+)\s+\S+\s+(\d+)/i);
            if (m) tcpMap.set(`${m[1]}->${m[2]}`, parseInt(m[3], 10));
          }
          const nameMap = new Map();
          for (const line of taskOut.split(/\r?\n/)) {
            const m = line.match(/^"([^"]+)","(\d+)"/);
            if (m) nameMap.set(parseInt(m[2], 10), m[1]);
          }
          procCache = { at: Date.now(), tcpMap, nameMap, inflight: null };
        } catch {
          procCache.inflight = null;
        }
      })();
    }
    await procCache.inflight;
  }
  const pid = procCache.tcpMap.get(`${sourcePort}->${listenPort}`);
  if (!pid) return null;
  return { pid, processName: procCache.nameMap.get(pid) || `PID ${pid}` };
}

function parseHostPort(authority, defaultPort = 443) {
  if (!authority) return { host: '', port: defaultPort };
  if (authority.startsWith('[')) {
    const end = authority.indexOf(']');
    if (end !== -1) {
      const host = authority.slice(1, end);
      const rest = authority.slice(end + 1);
      const port = rest.startsWith(':') ? parseInt(rest.slice(1), 10) || defaultPort : defaultPort;
      return { host, port };
    }
  }
  const colon = authority.lastIndexOf(':');
  if (colon !== -1) {
    const host = authority.slice(0, colon);
    const port = parseInt(authority.slice(colon + 1), 10) || defaultPort;
    return { host, port };
  }
  return { host: authority, port: defaultPort };
}

function pipeSockets(a, b, { onUp, onDown } = {}) {
  const cleanup = () => {
    if (!a.destroyed) a.destroy();
    if (!b.destroyed) b.destroy();
  };
  if (onUp) a.on('data', (chunk) => onUp(chunk.length));
  if (onDown) b.on('data', (chunk) => onDown(chunk.length));
  a.on('error', (err) => {
    if (err?.code !== 'ECONNRESET' && err?.code !== 'EPIPE') {
      // ignore benign close noise
    }
    cleanup();
  });
  b.on('error', () => cleanup());
  a.on('close', cleanup);
  b.on('close', cleanup);
  a.pipe(b);
  b.pipe(a);
}

export class ProxyServer {
  #configStore;
  #healthMonitor;
  #netServer = null;
  #httpServer = null;
  #logs = [];
  #activeConnections = new Map();
  #listening = false;
  #listenError = null;
  #totalUpBytes = 0;
  #totalDownBytes = 0;
  #uploadBps = 0;
  #downloadBps = 0;
  #lastSampleUp = 0;
  #lastSampleDown = 0;
  #lastSampleAt = Date.now();
  #rateTimer = null;

  constructor(configStore, healthMonitor) {
    this.#configStore = configStore;
    this.#healthMonitor = healthMonitor;
  }

  get isListening() { return this.#listening; }
  get listenError() { return this.#listenError; }

  getTrafficStats() {
    return {
      uploadBps: this.#uploadBps,
      downloadBps: this.#downloadBps,
      totalUpBytes: this.#totalUpBytes,
      totalDownBytes: this.#totalDownBytes,
    };
  }

  #recordUp = (n) => { if (n > 0) this.#totalUpBytes += n; };
  #recordDown = (n) => { if (n > 0) this.#totalDownBytes += n; };

  getLogs() {
    return this.#logs;
  }

  clearLogs() {
    this.#logs = [];
  }

  getActiveConnections() {
    const now = Date.now();
    return Array.from(this.#activeConnections.values())
      .sort((a, b) => b.startedAt - a.startedAt)
      .map(({ closeFn: _closeFn, ...rest }) => ({
        ...rest,
        durationMs: Math.max(0, now - rest.startedAt),
      }));
  }

  closeConnection(id) {
    const conn = this.#activeConnections.get(id);
    if (!conn) return false;
    try { conn.closeFn?.(); } catch {}
    this.#activeConnections.delete(id);
    return true;
  }

  #trackConnection(clientSock, upstreamSock, meta, logEntry) {
    const id = crypto.randomUUID();
    const conn = {
      id,
      protocol: meta.protocol,
      host: meta.host,
      port: meta.port,
      route: meta.route,
      rule: meta.rule,
      proxyLabel: meta.proxyLabel,
      startedAt: Date.now(),
      upBytes: 0,
      downBytes: 0,
      sourcePort: clientSock.remotePort || null,
      pid: null,
      processName: null,
      closeFn: () => {
        if (!clientSock.destroyed) clientSock.destroy();
        if (!upstreamSock.destroyed) upstreamSock.destroy();
      },
    };
    this.#activeConnections.set(id, conn);

    const listenPort = this.#configStore.data.listenPort || 17890;
    if (conn.sourcePort) {
      resolveLoopbackProcess(conn.sourcePort, listenPort).then((proc) => {
        if (!proc) return;
        conn.pid = proc.pid;
        conn.processName = proc.processName;
        if (logEntry) {
          logEntry.pid = proc.pid;
          logEntry.processName = proc.processName;
        }
      }).catch(() => {});
    }

    const cleanup = () => this.#activeConnections.delete(id);
    clientSock.once('close', cleanup);
    upstreamSock.once('close', cleanup);
    return conn;
  }

  #addLog(entry) {
    const item = {
      id: crypto.randomUUID(),
      time: new Date().toISOString(),
      ...entry,
    };
    this.#logs.unshift(item);
    if (this.#logs.length > MAX_LOGS) {
      this.#logs.length = MAX_LOGS;
    }
    return item;
  }

  #isSelfTarget(host, port) {
    const cfg = this.#configStore.data;
    const h = stripPort(host).toLowerCase();
    const isLoop = h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === cfg.listenHost;
    return isLoop && Number(port) === Number(cfg.listenPort);
  }

  async #openOutbound(route, targetHost, targetPort) {
    if (route.action === 'DIRECT') {
      return {
        sock: await connectDirect(targetHost, targetPort),
        proxyLabel: 'DIRECT',
      };
    }

    const cfg = this.#configStore.data;
    // Custom proxy mode
    const active = this.#configStore.getActiveProxy();
    if (!active) {
      throw new Error('No enabled upstream proxy configured');
    }
    if (this.#isSelfTarget(active.host, active.port)) {
      throw new Error(`Refusing proxy loop to self (${active.host}:${active.port})`);
    }
    try {
      const sock = await connectViaProxy(active, targetHost, targetPort);
      return {
        sock,
        proxyLabel: active.label || `${active.protocol.toUpperCase()} ${active.host}:${active.port}`,
      };
    } catch (err) {
      // Optional inline failover if autoSwitch is enabled
      if (cfg.options?.autoSwitch) {
        for (const candidate of cfg.proxies) {
          if (!candidate.enabled || candidate.id === active.id) continue;
          if (this.#isSelfTarget(candidate.host, candidate.port)) continue;
          const st = this.#healthMonitor?.getStatus(candidate.id);
          if (st?.status === 'geo_blocked') continue;
          try {
            const sock = await connectViaProxy(candidate, targetHost, targetPort);
            this.#configStore.update({ activeProxyId: candidate.id });
            return {
              sock,
              proxyLabel: candidate.label || `${candidate.protocol.toUpperCase()} ${candidate.host}:${candidate.port}`,
            };
          } catch {
            // Try next candidate
          }
        }
      }
      throw err;
    }
  }

  #createHttpServer() {
    const server = http.createServer();

    // HTTPS / gRPC / HTTP2 CONNECT tunnel — pure byte passthrough, zero MITM
    server.on('connect', async (req, clientSock, head) => {
      const { host: targetHost, port: targetPort } = parseHostPort(req.url, 443);
      const start = Date.now();
      const geoBlocked = this.#healthMonitor ? this.#healthMonitor.isBlocked() : false;
      const route = resolveRoute(targetHost, this.#configStore.data, geoBlocked);

      if (route.action === 'BLOCKED') {
        this.#addLog({
          protocol: 'CONNECT',
          host: targetHost,
          port: targetPort,
          route: 'BLOCKED',
          rule: route.reason,
          proxyLabel: 'Geo-Guard',
          latencyMs: Date.now() - start,
          status: 503,
          error: route.reason,
          isNewDomain: false,
        });
        if (!clientSock.destroyed) {
          clientSock.end(
            'HTTP/1.1 503 Service Unavailable\r\n' +
            'Content-Type: text/plain; charset=utf-8\r\n' +
            'Connection: close\r\n\r\n' +
            'Blocked by Geo-Guard: exit IP is in a restricted region or proxy unavailable.\n'
          );
        }
        return;
      }

      if (this.#isSelfTarget(targetHost, targetPort)) {
        clientSock.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\nLoop blocked\n');
        return;
      }

      try {
        const { sock: upstreamSock, proxyLabel } = await this.#openOutbound(route, targetHost, targetPort);
        const latencyMs = Date.now() - start;

        if (clientSock.destroyed) {
          upstreamSock.destroy();
          return;
        }

        clientSock.write('HTTP/1.1 200 Connection Established\r\nProxy-Agent: antigravity-proxy-router/1.0\r\n\r\n');
        if (head && head.length > 0) {
          this.#recordUp(head.length);
          upstreamSock.write(head);
        }

        const logEntry = this.#addLog({
          protocol: 'CONNECT',
          host: targetHost,
          port: targetPort,
          route: route.action,
          rule: route.matchedRule?.domain || route.reason,
          proxyLabel,
          latencyMs,
          status: 'ok',
          error: null,
          isNewDomain: route.isNewDomain,
        });

        const conn = this.#trackConnection(clientSock, upstreamSock, {
          protocol: 'CONNECT',
          host: targetHost,
          port: targetPort,
          route: route.action,
          rule: route.matchedRule?.domain || route.reason,
          proxyLabel,
        }, logEntry);

        pipeSockets(clientSock, upstreamSock, {
          onUp: (n) => { this.#recordUp(n); conn.upBytes += n; },
          onDown: (n) => { this.#recordDown(n); conn.downBytes += n; },
        });
      } catch (err) {
        this.#addLog({
          protocol: 'CONNECT',
          host: targetHost,
          port: targetPort,
          route: route.action,
          rule: route.matchedRule?.domain || route.reason,
          proxyLabel: 'ERROR',
          latencyMs: Date.now() - start,
          status: 'error',
          error: err.message,
          isNewDomain: route.isNewDomain,
        });
        if (!clientSock.destroyed) {
          clientSock.end(`HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n${err.message}\n`);
        }
      }
    });

    // Plain HTTP proxy requests (e.g. GET http://example.com/...)
    server.on('request', async (req, res) => {
      let targetUrl;
      try {
        targetUrl = new URL(req.url);
      } catch {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Bad proxy request URL\n');
        return;
      }

      const targetHost = targetUrl.hostname;
      const targetPort = parseInt(targetUrl.port, 10) || (targetUrl.protocol === 'https:' ? 443 : 80);
      const start = Date.now();
      const geoBlocked = this.#healthMonitor ? this.#healthMonitor.isBlocked() : false;
      const route = resolveRoute(targetHost, this.#configStore.data, geoBlocked);

      if (route.action === 'BLOCKED') {
        this.#addLog({
          protocol: req.method,
          host: targetHost,
          port: targetPort,
          route: 'BLOCKED',
          rule: route.reason,
          proxyLabel: 'Geo-Guard',
          latencyMs: Date.now() - start,
          status: 503,
          error: route.reason,
          isNewDomain: false,
        });
        res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Blocked by Geo-Guard\n');
        return;
      }

      try {
        const { sock: tunnelSock, proxyLabel } = await this.#openOutbound(route, targetHost, targetPort);
        const headers = { ...req.headers };
        delete headers['proxy-connection'];
        headers.host = targetUrl.host;

        const outReq = http.request({
          host: targetHost,
          port: targetPort,
          method: req.method,
          path: targetUrl.pathname + targetUrl.search,
          headers,
          agent: false,
          createConnection: () => tunnelSock,
        }, (outRes) => {
          this.#addLog({
            protocol: req.method,
            host: targetHost,
            port: targetPort,
            route: route.action,
            rule: route.matchedRule?.domain || route.reason,
            proxyLabel,
            latencyMs: Date.now() - start,
            status: outRes.statusCode,
            error: null,
            isNewDomain: route.isNewDomain,
          });
          res.writeHead(outRes.statusCode || 200, outRes.headers);
          outRes.on('data', (c) => this.#recordDown(c.length));
          outRes.pipe(res);
        });

        outReq.on('error', (err) => {
          this.#addLog({
            protocol: req.method,
            host: targetHost,
            port: targetPort,
            route: route.action,
            rule: route.matchedRule?.domain || route.reason,
            proxyLabel: 'ERROR',
            latencyMs: Date.now() - start,
            status: 'error',
            error: err.message,
            isNewDomain: route.isNewDomain,
          });
          if (!res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'text/plain' });
            res.end(err.message);
          } else {
            res.destroy();
          }
        });

        req.on('data', (c) => this.#recordUp(c.length));
        req.pipe(outReq);
      } catch (err) {
        this.#addLog({
          protocol: req.method,
          host: targetHost,
          port: targetPort,
          route: route.action,
          rule: route.matchedRule?.domain || route.reason,
          proxyLabel: 'ERROR',
          latencyMs: Date.now() - start,
          status: 'error',
          error: err.message,
          isNewDomain: route.isNewDomain,
        });
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'text/plain' });
          res.end(err.message);
        }
      }
    });

    server.on('clientError', (_err, sock) => {
      if (!sock.destroyed) sock.destroy();
    });

    return server;
  }

  #handleSocks5Inbound(clientSock, initialChunk) {
    let buf = initialChunk;
    let state = 'greeting';

    const onData = async (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      await processBuffer();
    };

    const processBuffer = async () => {
      if (state === 'greeting') {
        if (buf.length < 2) return;
        const nmethods = buf[1];
        if (buf.length < 2 + nmethods) return;
        buf = buf.slice(2 + nmethods);
        state = 'request';
        // Reply: no authentication required (0x00)
        clientSock.write(Buffer.from([0x05, 0x00]));
      }

      if (state === 'request') {
        if (buf.length < 4) return;
        const ver = buf[0];
        const cmd = buf[1];
        const atyp = buf[3];
        if (ver !== 0x05) { clientSock.destroy(); return; }
        if (cmd !== 0x01) {
          // Only CONNECT supported
          clientSock.end(Buffer.from([0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          return;
        }

        let targetHost = '';
        let addrEnd = 4;
        if (atyp === 0x01) {
          if (buf.length < 10) return;
          targetHost = `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`;
          addrEnd = 8;
        } else if (atyp === 0x03) {
          if (buf.length < 5) return;
          const len = buf[4];
          if (buf.length < 5 + len + 2) return;
          targetHost = buf.slice(5, 5 + len).toString('utf8');
          addrEnd = 5 + len;
        } else if (atyp === 0x04) {
          if (buf.length < 22) return;
          const parts = [];
          for (let i = 4; i < 20; i += 2) {
            parts.push(buf.readUInt16BE(i).toString(16));
          }
          targetHost = parts.join(':');
          addrEnd = 20;
        } else {
          clientSock.end(Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          return;
        }

        const targetPort = buf.readUInt16BE(addrEnd);
        const remaining = buf.slice(addrEnd + 2);
        state = 'tunneling';
        clientSock.removeListener('data', onData);

        const start = Date.now();
        const geoBlocked = this.#healthMonitor ? this.#healthMonitor.isBlocked() : false;
        const route = resolveRoute(targetHost, this.#configStore.data, geoBlocked);

        if (route.action === 'BLOCKED') {
          this.#addLog({
            protocol: 'SOCKS5',
            host: targetHost,
            port: targetPort,
            route: 'BLOCKED',
            rule: route.reason,
            proxyLabel: 'Geo-Guard',
            latencyMs: Date.now() - start,
            status: 503,
            error: route.reason,
            isNewDomain: false,
          });
          if (!clientSock.destroyed) {
            clientSock.end(Buffer.from([0x05, 0x02, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          }
          return;
        }

        if (this.#isSelfTarget(targetHost, targetPort)) {
          clientSock.end(Buffer.from([0x05, 0x02, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          return;
        }

        try {
          const { sock: upstreamSock, proxyLabel } = await this.#openOutbound(route, targetHost, targetPort);
          const latencyMs = Date.now() - start;
          if (clientSock.destroyed) {
            upstreamSock.destroy();
            return;
          }

          clientSock.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          if (remaining.length > 0) {
            this.#recordUp(remaining.length);
            upstreamSock.write(remaining);
          }

          const logEntry = this.#addLog({
            protocol: 'SOCKS5',
            host: targetHost,
            port: targetPort,
            route: route.action,
            rule: route.matchedRule?.domain || route.reason,
            proxyLabel,
            latencyMs,
            status: 'ok',
            error: null,
            isNewDomain: route.isNewDomain,
          });

          const conn = this.#trackConnection(clientSock, upstreamSock, {
            protocol: 'SOCKS5',
            host: targetHost,
            port: targetPort,
            route: route.action,
            rule: route.matchedRule?.domain || route.reason,
            proxyLabel,
          }, logEntry);

          pipeSockets(clientSock, upstreamSock, {
            onUp: (n) => { this.#recordUp(n); conn.upBytes += n; },
            onDown: (n) => { this.#recordDown(n); conn.downBytes += n; },
          });
        } catch (err) {
          this.#addLog({
            protocol: 'SOCKS5',
            host: targetHost,
            port: targetPort,
            route: route.action,
            rule: route.matchedRule?.domain || route.reason,
            proxyLabel: 'ERROR',
            latencyMs: Date.now() - start,
            status: 'error',
            error: err.message,
            isNewDomain: route.isNewDomain,
          });
          if (!clientSock.destroyed) {
            clientSock.end(Buffer.from([0x05, 0x04, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          }
        }
      }
    };

    clientSock.on('data', onData);
    processBuffer().catch(() => clientSock.destroy());
  }

  listen(portOverride, hostOverride) {
    const host = hostOverride || this.#configStore.data.listenHost || '127.0.0.1';
    const port = portOverride ?? this.#configStore.data.listenPort ?? 17890;

    this.#httpServer = this.#createHttpServer();

    return new Promise((resolve, reject) => {
      this.#netServer = net.createServer((clientSock) => {
        clientSock.once('error', () => {
          if (!clientSock.destroyed) clientSock.destroy();
        });

        clientSock.once('data', (firstChunk) => {
          if (!firstChunk || firstChunk.length === 0) {
            clientSock.destroy();
            return;
          }
          if (firstChunk[0] === 0x05) {
            this.#handleSocks5Inbound(clientSock, firstChunk);
          } else {
            // Put first chunk back so standard http.Server parser sees the full request
            clientSock.pause();
            clientSock.unshift(firstChunk);
            this.#httpServer.emit('connection', clientSock);
            clientSock.resume();
          }
        });
      });

      this.#netServer.once('error', (err) => {
        this.#listening = false;
        this.#listenError = err.message;
        reject(err);
      });

      this.#netServer.listen(port, host, () => {
        const addr = this.#netServer.address();
        this.#listening = true;
        this.#listenError = null;
        this.#lastSampleAt = Date.now();
        this.#lastSampleUp = this.#totalUpBytes;
        this.#lastSampleDown = this.#totalDownBytes;
        if (this.#rateTimer) clearInterval(this.#rateTimer);
        this.#rateTimer = setInterval(() => {
          const now = Date.now();
          const dtSec = Math.max(0.2, (now - this.#lastSampleAt) / 1000);
          this.#uploadBps = Math.round((this.#totalUpBytes - this.#lastSampleUp) / dtSec);
          this.#downloadBps = Math.round((this.#totalDownBytes - this.#lastSampleDown) / dtSec);
          this.#lastSampleUp = this.#totalUpBytes;
          this.#lastSampleDown = this.#totalDownBytes;
          this.#lastSampleAt = now;
        }, 1000);
        this.#rateTimer.unref?.();
        resolve(addr);
      });
    });
  }

  close() {
    if (this.#rateTimer) {
      clearInterval(this.#rateTimer);
      this.#rateTimer = null;
    }
    this.#uploadBps = 0;
    this.#downloadBps = 0;
    return new Promise((resolve) => {
      this.#listening = false;
      if (!this.#netServer) return resolve();
      this.#netServer.close(() => {
        this.#netServer = null;
        this.#httpServer = null;
        resolve();
      });
    });
  }
}
