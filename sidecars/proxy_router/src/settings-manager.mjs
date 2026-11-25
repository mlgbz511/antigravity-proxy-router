// settings-manager.mjs — Manage Antigravity User/settings.json and Windows user env vars safely
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Strip // line comments, block comments, and trailing commas without corrupting URLs inside strings.
 */
export function parseJsonc(raw) {
  if (!raw || !raw.trim()) return {};
  let stripped = '';
  let i = 0;
  let inString = false;
  let escaped = false;

  while (i < raw.length) {
    const ch = raw[i];
    const next = raw[i + 1];

    if (inString) {
      stripped += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      i++;
      continue;
    }

    if (ch === '"') {
      inString = true;
      stripped += ch;
      i++;
      continue;
    }

    if (ch === '/' && next === '/') {
      i += 2;
      while (i < raw.length && raw[i] !== '\n') i++;
      continue;
    }

    if (ch === '/' && next === '*') {
      i += 2;
      while (i < raw.length && !(raw[i] === '*' && raw[i + 1] === '/')) i++;
      i += 2;
      continue;
    }

    stripped += ch;
    i++;
  }

  // Remove trailing commas outside strings
  let noTrailing = '';
  inString = false;
  escaped = false;
  for (let j = 0; j < stripped.length; j++) {
    const ch = stripped[j];
    if (inString) {
      noTrailing += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      noTrailing += ch;
      continue;
    }
    if (ch === ',') {
      // Look ahead for closing } or ]
      let k = j + 1;
      while (k < stripped.length && /\s/.test(stripped[k])) k++;
      if (stripped[k] === '}' || stripped[k] === ']') {
        continue;
      }
    }
    noTrailing += ch;
  }

  return JSON.parse(noTrailing || '{}');
}

const USER_ENV_KEY = 'HKCU\\Environment';

function parseRegEnvBlock(stdout) {
  const map = new Map();
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const m = line.match(/^\s*([^\s]+)\s+REG_(?:SZ|EXPAND_SZ)\s+(.*)$/);
    if (m) map.set(m[1].toUpperCase(), m[2].trim());
  }
  return map;
}

function defaultEnvAdapter() {
  let cache = { at: 0, map: null };

  function readAllSync() {
    if (process.platform !== 'win32') return new Map();
    const now = Date.now();
    if (cache.map && now - cache.at < 4000) return cache.map;
    try {
      const out = execFileSync('reg.exe', ['query', USER_ENV_KEY], {
        encoding: 'utf8', windowsHide: true, timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'],
      });
      const map = parseRegEnvBlock(out);
      cache = { at: now, map };
      return map;
    } catch {
      return new Map();
    }
  }

  async function readAllAsync() {
    if (process.platform !== 'win32') return new Map();
    const now = Date.now();
    if (cache.map && now - cache.at < 4000) return cache.map;
    try {
      const { stdout } = await execFileAsync('reg.exe', ['query', USER_ENV_KEY], {
        encoding: 'utf8', windowsHide: true, timeout: 3000,
      });
      const map = parseRegEnvBlock(stdout);
      cache = { at: Date.now(), map };
      return map;
    } catch {
      return new Map();
    }
  }

  return {
    get(name) {
      return readAllSync().get(String(name).toUpperCase()) ?? null;
    },
    async getAllAsync() {
      return readAllAsync();
    },
    set(name, value) {
      if (process.platform !== 'win32') return;
      const valExpr = value === null || value === undefined
        ? '$null'
        : `'${String(value).replace(/'/g, "''")}'`;
      execFileSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', `[Environment]::SetEnvironmentVariable('${name}', ${valExpr}, 'User')`],
        { encoding: 'utf8', windowsHide: true, timeout: 5000 }
      );
      cache = { at: 0, map: null };
    },
  };
}

export class SettingsManager {
  #settingsPath;
  #envAdapter;

  constructor({ settingsPath, envAdapter } = {}) {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    this.#settingsPath = settingsPath
      || process.env.ANTIGRAVITY_USER_SETTINGS_PATH
      || path.join(appData, 'Antigravity', 'User', 'settings.json');
    this.#envAdapter = envAdapter || defaultEnvAdapter();
  }

  get settingsPath() { return this.#settingsPath; }

  #readSettings() {
    try {
      const raw = fs.readFileSync(this.#settingsPath, 'utf8');
      return parseJsonc(raw);
    } catch (err) {
      if (err.code === 'ENOENT') return {};
      throw err;
    }
  }

  #writeSettings(obj) {
    fs.mkdirSync(path.dirname(this.#settingsPath), { recursive: true });
    const tmp = this.#settingsPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 4) + '\n', 'utf8');
    fs.renameSync(tmp, this.#settingsPath);
  }

  getExpectedUrl(listenHost = '127.0.0.1', listenPort = 17890) {
    return `http://${listenHost}:${listenPort}`;
  }

  getTakeoverStatus(listenHost = '127.0.0.1', listenPort = 17890, configStore = null) {
    const expected = this.getExpectedUrl(listenHost, listenPort);
    let currentHttpProxy = null;
    let currentProxySupport = null;
    let settingsExists = fs.existsSync(this.#settingsPath);

    try {
      const s = this.#readSettings();
      currentHttpProxy = s['http.proxy'] ?? null;
      currentProxySupport = s['http.proxySupport'] ?? null;
    } catch {
      // ignore parse errors in status probe
    }

    const envHttpsProxy = this.#envAdapter.get('HTTPS_PROXY');
    const envHttpProxy = this.#envAdapter.get('HTTP_PROXY');
    const envNoProxy = this.#envAdapter.get('NO_PROXY');

    return {
      settingsPath: this.#settingsPath,
      settingsExists,
      expectedUrl: expected,
      settingsTakenOver: currentHttpProxy === expected,
      currentHttpProxy,
      currentProxySupport,
      hasSettingsBackup: Boolean(configStore?.data?.settingsBackup),
      envTakenOver: envHttpsProxy === expected && envHttpProxy === expected,
      envHttpsProxy,
      envHttpProxy,
      envNoProxy,
      hasEnvBackup: Boolean(configStore?.data?.envBackup),
    };
  }

  async getTakeoverStatusAsync(listenHost = '127.0.0.1', listenPort = 17890, configStore = null) {
    const expected = this.getExpectedUrl(listenHost, listenPort);
    let currentHttpProxy = null;
    let currentProxySupport = null;
    const settingsExists = fs.existsSync(this.#settingsPath);

    try {
      const s = this.#readSettings();
      currentHttpProxy = s['http.proxy'] ?? null;
      currentProxySupport = s['http.proxySupport'] ?? null;
    } catch {
      // ignore
    }

    const envMap = typeof this.#envAdapter.getAllAsync === 'function'
      ? await this.#envAdapter.getAllAsync()
      : null;
    const envHttpsProxy = envMap ? (envMap.get('HTTPS_PROXY') ?? null) : this.#envAdapter.get('HTTPS_PROXY');
    const envHttpProxy = envMap ? (envMap.get('HTTP_PROXY') ?? null) : this.#envAdapter.get('HTTP_PROXY');
    const envNoProxy = envMap ? (envMap.get('NO_PROXY') ?? null) : this.#envAdapter.get('NO_PROXY');

    return {
      settingsPath: this.#settingsPath,
      settingsExists,
      expectedUrl: expected,
      settingsTakenOver: currentHttpProxy === expected,
      currentHttpProxy,
      currentProxySupport,
      hasSettingsBackup: Boolean(configStore?.data?.settingsBackup),
      envTakenOver: envHttpsProxy === expected && envHttpProxy === expected,
      envHttpsProxy,
      envHttpProxy,
      envNoProxy,
      hasEnvBackup: Boolean(configStore?.data?.envBackup),
    };
  }

  enableTakeover(listenHost, listenPort, configStore) {
    const expected = this.getExpectedUrl(listenHost, listenPort);
    const settings = this.#readSettings();

    if (!configStore.data.settingsBackup) {
      configStore.update({
        settingsBackup: {
          hasHttpProxy: Object.prototype.hasOwnProperty.call(settings, 'http.proxy'),
          httpProxy: settings['http.proxy'] ?? null,
          hasProxySupport: Object.prototype.hasOwnProperty.call(settings, 'http.proxySupport'),
          proxySupport: settings['http.proxySupport'] ?? null,
        },
      });
    }

    settings['http.proxy'] = expected;
    settings['http.proxySupport'] = 'on';
    this.#writeSettings(settings);

    return this.getTakeoverStatus(listenHost, listenPort, configStore);
  }

  restoreTakeover(listenHost, listenPort, configStore) {
    const expected = this.getExpectedUrl(listenHost, listenPort);
    const settings = this.#readSettings();
    const backup = configStore.data.settingsBackup;

    if (backup) {
      if (backup.hasHttpProxy) {
        settings['http.proxy'] = backup.httpProxy;
      } else {
        delete settings['http.proxy'];
      }
      if (backup.hasProxySupport) {
        settings['http.proxySupport'] = backup.proxySupport;
      } else {
        delete settings['http.proxySupport'];
      }
      configStore.update({ settingsBackup: null });
    } else if (settings['http.proxy'] === expected) {
      delete settings['http.proxy'];
      if (settings['http.proxySupport'] === 'on') {
        delete settings['http.proxySupport'];
      }
    }

    this.#writeSettings(settings);
    return this.getTakeoverStatus(listenHost, listenPort, configStore);
  }

  enableEnvTakeover(listenHost, listenPort, configStore) {
    const expected = this.getExpectedUrl(listenHost, listenPort);

    if (!configStore.data.envBackup) {
      configStore.update({
        envBackup: {
          HTTPS_PROXY: this.#envAdapter.get('HTTPS_PROXY'),
          HTTP_PROXY: this.#envAdapter.get('HTTP_PROXY'),
          NO_PROXY: this.#envAdapter.get('NO_PROXY'),
        },
      });
    }

    const existingNoProxy = this.#envAdapter.get('NO_PROXY') || '';
    const noProxyParts = existingNoProxy
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    for (const mustHave of ['127.0.0.1', 'localhost', '::1']) {
      if (!noProxyParts.includes(mustHave)) noProxyParts.push(mustHave);
    }

    this.#envAdapter.set('HTTPS_PROXY', expected);
    this.#envAdapter.set('HTTP_PROXY', expected);
    this.#envAdapter.set('NO_PROXY', noProxyParts.join(','));

    return this.getTakeoverStatus(listenHost, listenPort, configStore);
  }

  restoreEnvTakeover(listenHost, listenPort, configStore) {
    const expected = this.getExpectedUrl(listenHost, listenPort);
    const backup = configStore.data.envBackup;

    if (backup) {
      this.#envAdapter.set('HTTPS_PROXY', backup.HTTPS_PROXY);
      this.#envAdapter.set('HTTP_PROXY', backup.HTTP_PROXY);
      this.#envAdapter.set('NO_PROXY', backup.NO_PROXY);
      configStore.update({ envBackup: null });
    } else {
      if (this.#envAdapter.get('HTTPS_PROXY') === expected) {
        this.#envAdapter.set('HTTPS_PROXY', null);
      }
      if (this.#envAdapter.get('HTTP_PROXY') === expected) {
        this.#envAdapter.set('HTTP_PROXY', null);
      }
    }

    return this.getTakeoverStatus(listenHost, listenPort, configStore);
  }

  checkEnvironmentConflicts(listenHost = '127.0.0.1', listenPort = 17890) {
    const expected = this.getExpectedUrl(listenHost, listenPort);
    const keys = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'];
    const conflicts = [];
    for (const key of keys) {
      const val = process.env[key];
      if (val && val.trim() && val.trim() !== expected) {
        conflicts.push({ key, value: val.trim() });
      }
    }
    return conflicts;
  }
}
