// config-store.mjs — Persistent configuration with atomic writes
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export const DEFAULT_ALLOWED_COUNTRIES = ['US', 'JP', 'SG', 'TW', 'GB', 'DE', 'CA', 'AU', 'KR'];
export const DEFAULT_BLOCKED_COUNTRIES = ['CN', 'HK', 'MO', 'RU', 'BY', 'IR', 'KP', 'CU', 'SY'];

const EXTRA_V2_DOMAINS = [
  'antigravity-hub-auto-updater-974169037036.us-central1.run.app',
  'play.googleapis.com',
  'jetski-webchannel.googleapis.com',
  'antigravity.google',
  'aicode.googleapis.com',
  'googleapis.com',
];

const DEFAULT_RULES = [
  'accounts.google.com',
  'generativelanguage.googleapis.com',
  'oauth2.googleapis.com',
  'cloudcode-pa.googleapis.com',
  'daily-cloudcode-pa.googleapis.com',
  'aicode.googleapis.com',
  'googleapis.com',
  'open-vsx.org',
  'antigravity-unleash.goog',
  'antigravity-auto-updater-974169037036.us-central1.run.app',
  'antigravity-hub-auto-updater-974169037036.us-central1.run.app',
  'lh3.googleusercontent.com',
  'antigravity.dev',
  'antigravity.com',
  'antigravity.google',
  'sentry.io',
  'www.googleapis.com',
  'storage.googleapis.com',
  'play.googleapis.com',
  'jetski-webchannel.googleapis.com',
].map(d => ({ id: crypto.randomUUID(), domain: d, type: 'suffix', enabled: true }));

function defaultConfig() {
  return {
    version: 1,
    connectionMode: 'custom',   // 'disabled' | 'custom'
    routingMode: 'rule',        // 'rule' | 'global'
    options: {
      tryIpv6: false,
      autoSwitch: true,
      strictGeoGuard: false,
      geoPolicyMode: 'whitelist', // 'whitelist' | 'blacklist'
      allowedCountries: [...DEFAULT_ALLOWED_COUNTRIES],
      blockedCountries: [...DEFAULT_BLOCKED_COUNTRIES],
      healthCheckIntervalSec: 60,
    },
    proxies: [
      {
        id: crypto.randomUUID(),
        label: 'V2rayN Default',
        protocol: 'socks5',
        host: '127.0.0.1',
        port: 10808,
        username: '',
        password: '',
        enabled: true,
      },
    ],
    activeProxyId: null,
    rules: structuredClone(DEFAULT_RULES),
    settingsBackup: null,
    envBackup: null,
    listenHost: '127.0.0.1',
    listenPort: 17890,
  };
}

export class ConfigStore {
  #path;
  #data;

  constructor(dataDir) {
    const dir = dataDir
      || process.env.ANTIGRAVITY_PLUGIN_DATA
      || path.join(os.homedir(), '.gemini', 'config', 'plugin-data', 'antigravity-proxy-router');
    fs.mkdirSync(dir, { recursive: true });
    this.#path = path.join(dir, 'config.json');
    this.#data = this.#load();
  }

  #load() {
    try {
      const raw = fs.readFileSync(this.#path, 'utf8');
      const parsed = JSON.parse(raw);
      const def = defaultConfig();
      const mergedOptions = { ...def.options, ...(parsed.options || {}) };

      // Smooth migration for V1/V2 configs that only had ['CN']
      if (
        Array.isArray(parsed.options?.blockedCountries) &&
        parsed.options.blockedCountries.length === 1 &&
        parsed.options.blockedCountries[0] === 'CN' &&
        !parsed.options.geoPolicyMode
      ) {
        mergedOptions.blockedCountries = [...DEFAULT_BLOCKED_COUNTRIES];
      }

      // Smooth migration: append newly discovered Antigravity 2.x domains if absent
      const rules = Array.isArray(parsed.rules) ? [...parsed.rules] : structuredClone(DEFAULT_RULES);
      let rulesAdded = false;
      for (const extra of EXTRA_V2_DOMAINS) {
        if (!rules.some(r => String(r.domain).toLowerCase() === extra)) {
          rules.push({ id: crypto.randomUUID(), domain: extra, type: 'suffix', enabled: true });
          rulesAdded = true;
        }
      }

      const loaded = { ...def, ...parsed, rules, options: mergedOptions };
      if (loaded.connectionMode === 'system') {
        loaded.connectionMode = 'custom';
      }
      if (rulesAdded) {
        this.#atomicWrite(loaded);
      }
      return loaded;
    } catch {
      const cfg = defaultConfig();
      cfg.activeProxyId = cfg.proxies[0].id;
      this.#atomicWrite(cfg);
      return cfg;
    }
  }

  #atomicWrite(data) {
    const tmp = this.#path + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, this.#path);
  }

  get data() { return this.#data; }

  save() {
    this.#atomicWrite(this.#data);
  }

  update(partial) {
    Object.assign(this.#data, partial);
    this.save();
    return this.#data;
  }

  updateOptions(partial) {
    Object.assign(this.#data.options, partial);
    this.save();
    return this.#data;
  }

  getActiveProxy() {
    const p = this.#data.proxies.find(p => p.id === this.#data.activeProxyId && p.enabled);
    return p || this.#data.proxies.find(p => p.enabled) || null;
  }

  resetRules() {
    this.#data.rules = structuredClone(DEFAULT_RULES);
    this.save();
  }

  static get DEFAULT_RULES() { return DEFAULT_RULES; }
  static get DEFAULT_ALLOWED_COUNTRIES() { return DEFAULT_ALLOWED_COUNTRIES; }
  static get DEFAULT_BLOCKED_COUNTRIES() { return DEFAULT_BLOCKED_COUNTRIES; }
}
