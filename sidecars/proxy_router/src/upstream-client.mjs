// upstream-client.mjs — SOCKS5 / HTTP CONNECT / DIRECT outbound tunnel
import net from 'node:net';

const DEFAULT_TIMEOUT = 10_000;

/** Direct TCP connection */
export function connectDirect(host, port, timeout = DEFAULT_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port, timeout }, () => {
      sock.setTimeout(0);
      resolve(sock);
    });
    sock.once('error', reject);
    sock.once('timeout', () => { sock.destroy(); reject(new Error('DIRECT connect timeout')); });
  });
}

/**
 * SOCKS5 CONNECT with ATYP=0x03 (domain, remote DNS resolution)
 * Supports 0x00 (no auth) and 0x02 (username/password) auth.
 */
export function connectViaSocks5(upstream, targetHost, targetPort, timeout = DEFAULT_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: upstream.host, port: upstream.port, timeout }, () => {
      sock.setTimeout(0);
      // Phase 1: greeting
      const hasAuth = upstream.username && upstream.password;
      const greeting = hasAuth
        ? Buffer.from([0x05, 0x02, 0x00, 0x02])
        : Buffer.from([0x05, 0x01, 0x00]);
      sock.write(greeting);
    });
    sock.once('error', reject);
    sock.once('timeout', () => { sock.destroy(); reject(new Error('SOCKS5 connect timeout')); });

    let phase = 'greeting';
    let buf = Buffer.alloc(0);

    sock.on('data', onData);

    function onData(chunk) {
      buf = Buffer.concat([buf, chunk]);
      if (phase === 'greeting') {
        if (buf.length < 2) return;
        const ver = buf[0], method = buf[1];
        if (ver !== 0x05) { sock.destroy(); return reject(new Error(`SOCKS5 bad version: ${ver}`)); }
        if (method === 0x02) {
          // Username/Password auth (RFC 1929)
          const uBuf = Buffer.from(upstream.username, 'utf8');
          const pBuf = Buffer.from(upstream.password, 'utf8');
          const auth = Buffer.alloc(3 + uBuf.length + pBuf.length);
          auth[0] = 0x01;
          auth[1] = uBuf.length;
          uBuf.copy(auth, 2);
          auth[2 + uBuf.length] = pBuf.length;
          pBuf.copy(auth, 3 + uBuf.length);
          buf = Buffer.alloc(0);
          phase = 'auth';
          sock.write(auth);
        } else if (method === 0x00) {
          buf = Buffer.alloc(0);
          phase = 'connect';
          sendConnect();
        } else {
          sock.destroy(); reject(new Error(`SOCKS5 unsupported auth method: ${method}`));
        }
      } else if (phase === 'auth') {
        if (buf.length < 2) return;
        if (buf[1] !== 0x00) { sock.destroy(); return reject(new Error('SOCKS5 auth failed')); }
        buf = Buffer.alloc(0);
        phase = 'connect';
        sendConnect();
      } else if (phase === 'connect') {
        if (buf.length < 4) return;
        const rep = buf[1];
        if (rep !== 0x00) { sock.destroy(); return reject(new Error(`SOCKS5 connect refused: rep=${rep}`)); }
        // Parse ATYP to know reply length
        const atyp = buf[3];
        let replyLen;
        if (atyp === 0x01) replyLen = 10;       // IPv4 + port
        else if (atyp === 0x03) replyLen = 7 + buf[4]; // domain + port
        else if (atyp === 0x04) replyLen = 22;  // IPv6 + port
        else { sock.destroy(); return reject(new Error(`SOCKS5 unknown ATYP: ${atyp}`)); }
        if (buf.length < replyLen) return;
        // Tunnel established — remove data handler and pass remaining bytes back
        sock.removeListener('data', onData);
        const remaining = buf.length > replyLen ? buf.slice(replyLen) : null;
        if (remaining && remaining.length) sock.unshift(remaining);
        resolve(sock);
      }
    }

    function sendConnect() {
      const domainBuf = Buffer.from(targetHost, 'utf8');
      const req = Buffer.alloc(7 + domainBuf.length);
      req[0] = 0x05; // VER
      req[1] = 0x01; // CMD: CONNECT
      req[2] = 0x00; // RSV
      req[3] = 0x03; // ATYP: domain
      req[4] = domainBuf.length;
      domainBuf.copy(req, 5);
      req.writeUInt16BE(targetPort, 5 + domainBuf.length);
      sock.write(req);
    }
  });
}

/** HTTP CONNECT tunnel through an HTTP proxy */
export function connectViaHttpProxy(upstream, targetHost, targetPort, timeout = DEFAULT_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: upstream.host, port: upstream.port, timeout }, () => {
      sock.setTimeout(0);
      let connectReq = `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n`;
      if (upstream.username && upstream.password) {
        const cred = Buffer.from(`${upstream.username}:${upstream.password}`).toString('base64');
        connectReq += `Proxy-Authorization: Basic ${cred}\r\n`;
      }
      connectReq += '\r\n';
      sock.write(connectReq);
    });
    sock.once('error', reject);
    sock.once('timeout', () => { sock.destroy(); reject(new Error('HTTP CONNECT timeout')); });

    let buf = Buffer.alloc(0);
    sock.on('data', function onData(chunk) {
      buf = Buffer.concat([buf, chunk]);
      const idx = buf.indexOf('\r\n\r\n');
      if (idx === -1) return;
      const statusLine = buf.slice(0, buf.indexOf(0x0D)).toString('ascii');
      const statusCode = parseInt(statusLine.split(' ')[1], 10);
      if (statusCode !== 200) {
        sock.destroy();
        return reject(new Error(`HTTP CONNECT failed: ${statusLine}`));
      }
      sock.removeListener('data', onData);
      const remaining = buf.slice(idx + 4);
      if (remaining.length) sock.unshift(remaining);
      resolve(sock);
    });
  });
}

/** Connect to target through an upstream proxy (auto-selects protocol) */
export function connectViaProxy(upstream, targetHost, targetPort, timeout = DEFAULT_TIMEOUT) {
  if (upstream.protocol === 'socks5') {
    return connectViaSocks5(upstream, targetHost, targetPort, timeout);
  }
  return connectViaHttpProxy(upstream, targetHost, targetPort, timeout);
}

/** Probe upstream reachability: connect through proxy to test host, measure latency */
export async function probeUpstream(upstream, testHost = 'accounts.google.com', testPort = 443, timeout = 5000) {
  const start = Date.now();
  let sock;
  try {
    sock = await connectViaProxy(upstream, testHost, testPort, timeout);
    const latency = Date.now() - start;
    sock.destroy();
    return { ok: true, latencyMs: latency };
  } catch (err) {
    if (sock) sock.destroy();
    return { ok: false, error: err.message };
  }
}
