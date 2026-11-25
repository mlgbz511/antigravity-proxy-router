// daemon-manager.mjs — Detached background daemon & Windows logon autostart management
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUN_REG_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const RUN_VALUE_NAME = 'AntigravityProxyRouter';

export function resolveNodeExecutable() {
  const candidates = [
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'nodejs', 'node.exe'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  if (process.platform === 'win32') {
    try {
      const out = execFileSync('where.exe', ['node'], {
        encoding: 'utf8', windowsHide: true, timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'],
      }).split(/\r?\n/)[0]?.trim();
      if (out && fs.existsSync(out)) return out;
    } catch {
      // ignore
    }
  }
  return process.execPath;
}

/**
 * Fast, proxy-bypassing HTTP probe using node:http (never inherits HTTPS_PROXY / undici overhead).
 */
export function probeControlEndpoint(controlHost = '127.0.0.1', controlPort = 17891, timeoutMs = 1200) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      resolve(val);
    };

    const req = http.request({
      host: controlHost,
      port: controlPort,
      path: '/api/identity',
      method: 'GET',
      agent: false,
      timeout: timeoutMs,
    }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return finish(null);
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.once('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (data && data.service === 'antigravity-proxy-router') {
            return finish(data);
          }
        } catch {
          // ignore invalid JSON
        }
        finish(null);
      });
    });

    req.on('timeout', () => {
      req.destroy();
      finish(null);
    });
    req.on('error', () => finish(null));
    req.end();
  });
}

function defaultRegistryAdapter() {
  let cachedRun = { at: 0, value: null };
  return {
    getRunEntry() {
      if (process.platform !== 'win32') return null;
      const now = Date.now();
      if (now - cachedRun.at < 5000) return cachedRun.value;
      try {
        const out = execFileSync(
          'reg.exe',
          ['query', RUN_REG_KEY, '/v', RUN_VALUE_NAME],
          { encoding: 'utf8', windowsHide: true, timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }
        );
        const m = out.match(new RegExp(`${RUN_VALUE_NAME}\\s+REG_SZ\\s+(.+)`));
        const val = m ? m[1].trim() : null;
        cachedRun = { at: now, value: val };
        return val;
      } catch {
        cachedRun = { at: now, value: null };
        return null;
      }
    },
    async getRunEntryAsync() {
      if (process.platform !== 'win32') return null;
      const now = Date.now();
      if (now - cachedRun.at < 5000) return cachedRun.value;
      try {
        const { stdout } = await execFileAsync(
          'reg.exe',
          ['query', RUN_REG_KEY, '/v', RUN_VALUE_NAME],
          { encoding: 'utf8', windowsHide: true, timeout: 3000 }
        );
        const m = stdout.match(new RegExp(`${RUN_VALUE_NAME}\\s+REG_SZ\\s+(.+)`));
        const val = m ? m[1].trim() : null;
        cachedRun = { at: Date.now(), value: val };
        return val;
      } catch {
        cachedRun = { at: Date.now(), value: null };
        return null;
      }
    },
    setRunEntry(cmdValue) {
      if (process.platform !== 'win32') return;
      execFileSync(
        'reg.exe',
        ['add', RUN_REG_KEY, '/v', RUN_VALUE_NAME, '/t', 'REG_SZ', '/d', cmdValue, '/f'],
        { encoding: 'utf8', windowsHide: true, timeout: 3000 }
      );
      cachedRun = { at: Date.now(), value: cmdValue };
    },
    deleteRunEntry() {
      if (process.platform !== 'win32') return;
      try {
        execFileSync(
          'reg.exe',
          ['delete', RUN_REG_KEY, '/v', RUN_VALUE_NAME, '/f'],
          { encoding: 'utf8', windowsHide: true, timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }
        );
      } catch {
        // Not found is fine
      }
      cachedRun = { at: Date.now(), value: null };
    },
  };
}

export class DaemonManager {
  #dataDir;
  #pidPath;
  #mainPath;
  #controlHost;
  #controlPort;
  #registry;
  #isDaemonProcess;
  #isBridgeProcess = false;

  constructor({
    dataDir,
    controlHost = '127.0.0.1',
    controlPort = 17891,
    isDaemonProcess = false,
    registryAdapter,
  } = {}) {
    this.#dataDir = dataDir
      || process.env.ANTIGRAVITY_PLUGIN_DATA
      || path.join(os.homedir(), '.gemini', 'config', 'plugin-data', 'antigravity-proxy-router');
    fs.mkdirSync(this.#dataDir, { recursive: true });
    this.#pidPath = path.join(this.#dataDir, 'daemon.pid');
    this.#mainPath = path.resolve(__dirname, 'main.mjs');
    this.#controlHost = controlHost;
    this.#controlPort = controlPort;
    this.#isDaemonProcess = isDaemonProcess;
    this.#registry = registryAdapter || defaultRegistryAdapter();
  }

  get pidPath() { return this.#pidPath; }
  get controlUrl() { return `http://${this.#controlHost}:${this.#controlPort}`; }

  setBridgeMode(val) {
    this.#isBridgeProcess = Boolean(val);
  }

  writePidFile(pid = process.pid) {
    fs.writeFileSync(this.#pidPath, JSON.stringify({
      pid,
      controlHost: this.#controlHost,
      controlPort: this.#controlPort,
      startedAt: Date.now(),
    }, null, 2), 'utf8');
  }

  removePidFile() {
    try {
      const raw = fs.readFileSync(this.#pidPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed.pid === process.pid) {
        fs.unlinkSync(this.#pidPath);
      }
    } catch {
      // ignore
    }
  }

  isAutostartEnabled() {
    return Boolean(this.#registry.getRunEntry());
  }

  async isAutostartEnabledAsync() {
    if (typeof this.#registry.getRunEntryAsync === 'function') {
      return Boolean(await this.#registry.getRunEntryAsync());
    }
    return Boolean(this.#registry.getRunEntry());
  }

  /** Ensure silent VBS launcher exists in dataDir for hidden logon autostart */
  ensureHiddenLauncherVbs() {
    const nodeExe = resolveNodeExecutable();
    fs.mkdirSync(this.#dataDir, { recursive: true });
    const vbsPath = path.join(this.#dataDir, 'start-hidden.vbs');
    const escapedNode = nodeExe.replace(/"/g, '""');
    const escapedMain = this.#mainPath.replace(/"/g, '""');
    const content =
      'Set sh = CreateObject("Wscript.Shell")\r\n' +
      `sh.Run """${escapedNode}"" ""${escapedMain}"" --daemon", 0, False\r\n`;
    fs.writeFileSync(vbsPath, content, 'utf8');
    return vbsPath;
  }

  setAutostart(enabled) {
    if (enabled) {
      const vbsPath = this.ensureHiddenLauncherVbs();
      const cmd = `wscript.exe //B //Nologo "${vbsPath}"`;
      this.#registry.setRunEntry(cmd);
    } else {
      this.#registry.deleteRunEntry();
    }
    return this.isAutostartEnabled();
  }

  async getStatus() {
    const [live, autostartEnabled] = await Promise.all([
      this.#isDaemonProcess
        ? Promise.resolve({ pid: process.pid })
        : probeControlEndpoint(this.#controlHost, this.#controlPort, 800),
      this.isAutostartEnabledAsync(),
    ]);
    return {
      running: Boolean(live),
      daemonPid: live?.pid ?? null,
      mode: this.#isBridgeProcess ? 'bridge' : (this.#isDaemonProcess ? 'daemon' : 'sidecar'),
      controlUrl: this.controlUrl,
      autostartEnabled,
    };
  }

  /**
   * Launch detached daemon via WMI Win32_Process.Create (zero console window, outlives Antigravity).
   */
  async startDaemon() {
    const existing = await probeControlEndpoint(this.#controlHost, this.#controlPort, 800);
    if (existing) return { started: false, alreadyRunning: true, pid: existing.pid };

    if (process.platform !== 'win32') {
      throw new Error('Detached daemon launch via WMI is supported on Windows only');
    }

    const nodeExe = resolveNodeExecutable();
    const cmdLine = `"${nodeExe}" "${this.#mainPath}" --daemon`;
    const psScript = [
      '$si = ([wmiclass]"Win32_ProcessStartup").CreateInstance()',
      '$si.ShowWindow = 0',
      `$cmd = '${cmdLine.replace(/'/g, "''")}'`,
      `$res = ([wmiclass]"Win32_Process").Create($cmd, '${path.dirname(this.#mainPath).replace(/'/g, "''")}', $si)`,
      'if ($res.ReturnValue -ne 0) { throw "Win32_Process.Create failed: $($res.ReturnValue)" }',
      'Write-Output $res.ProcessId',
    ].join('; ');

    const pidOut = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', psScript],
      { encoding: 'utf8', windowsHide: true, timeout: 5000 }
    ).trim();

    let lastProbe = null;
    for (let i = 0; i < 30; i++) {
      const probe = await probeControlEndpoint(this.#controlHost, this.#controlPort, 500);
      if (probe) {
        lastProbe = probe;
        if (probe.proxyListening) {
          return { started: true, pid: probe.pid };
        }
      }
      await new Promise(r => setTimeout(r, 200));
    }

    if (lastProbe) {
      return { started: true, pid: lastProbe.pid, warning: 'Daemon control ready; gateway still initializing' };
    }
    return { started: true, pid: parseInt(pidOut, 10) || null, warning: 'Daemon spawned but control port not ready yet' };
  }

  /**
   * Gracefully stop running daemon; automatically restores HTTPS_PROXY if it pointed to this gateway
   * so user never gets stranded with a dead proxy env var.
   */
  async stopDaemon({ settingsManager, configStore } = {}) {
    let envRestored = false;
    if (settingsManager && configStore) {
      const cfg = configStore.data;
      const st = await settingsManager.getTakeoverStatusAsync(cfg.listenHost, cfg.listenPort, configStore);
      if (st.envTakenOver) {
        settingsManager.restoreEnvTakeover(cfg.listenHost, cfg.listenPort, configStore);
        envRestored = true;
      }
    }

    if (this.#isDaemonProcess) {
      return { stopping: true, self: true, envRestored };
    }

    const live = await probeControlEndpoint(this.#controlHost, this.#controlPort, 800);
    if (!live) {
      return { stopping: false, alreadyStopped: true, envRestored };
    }

    try {
      await new Promise((resolve) => {
        const req = http.request({
          host: this.#controlHost,
          port: this.#controlPort,
          path: '/api/shutdown',
          method: 'POST',
          agent: false,
          timeout: 1200,
        }, (res) => { res.resume(); resolve(); });
        req.on('error', resolve);
        req.on('timeout', () => { req.destroy(); resolve(); });
        req.end();
      });
    } catch {
      if (live.pid) {
        try { process.kill(live.pid, 'SIGTERM'); } catch {}
      }
    }
    return { stopping: true, pid: live.pid, envRestored };
  }

  /**
   * Launch or restart Antigravity.exe via detached PowerShell helper that explicitly injects
   * HTTPS_PROXY / HTTP_PROXY / NO_PROXY into the new process environment (works without Windows reboot).
   */
  launchAntigravity({ settingsManager, configStore, restart = true } = {}) {
    if (process.platform !== 'win32') {
      throw new Error('Antigravity proxy launcher is supported on Windows only');
    }
    if (settingsManager && configStore) {
      const cfg = configStore.data;
      settingsManager.enableEnvTakeover(cfg.listenHost, cfg.listenPort, configStore);
    }

    const pluginRoot = path.resolve(__dirname, '..', '..', '..');
    const launcherPath = path.join(pluginRoot, 'scripts', 'launch-antigravity.ps1');
    if (!fs.existsSync(launcherPath)) {
      throw new Error(`Launcher script not found: ${launcherPath}`);
    }

    const port = configStore?.data?.listenPort || 17890;
    const args = `-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${launcherPath}" -ListenPort ${port}${restart ? ' -Restart' : ''}`;
    const psScript = [
      '$si = ([wmiclass]"Win32_ProcessStartup").CreateInstance()',
      '$si.ShowWindow = 0',
      `$cmd = 'powershell.exe ${args.replace(/'/g, "''")}'`,
      '$res = ([wmiclass]"Win32_Process").Create($cmd, $null, $si)',
      'if ($res.ReturnValue -ne 0) { throw "Win32_Process.Create failed: $($res.ReturnValue)" }',
      'Write-Output $res.ProcessId',
    ].join('; ');

    const pidOut = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', psScript],
      { encoding: 'utf8', windowsHide: true, timeout: 5000 }
    ).trim();

    return { launching: true, launcherPid: parseInt(pidOut, 10) || null, restart };
  }

  getShortcutStatus({ configStore } = {}) {
    const backup = configStore?.data?.shortcutBackup;
    return {
      takenOver: Array.isArray(backup) && backup.length > 0,
      count: Array.isArray(backup) ? backup.length : 0,
      paths: Array.isArray(backup) ? backup.map(b => b.path) : [],
    };
  }

  /**
   * Take over existing Desktop & Start Menu Antigravity.lnk shortcuts (with full backup for 1-click restore).
   */
  takeoverShortcuts({ configStore, listenPort = 17890 } = {}) {
    if (process.platform !== 'win32') {
      throw new Error('Shortcut takeover is supported on Windows only');
    }
    const pluginRoot = path.resolve(__dirname, '..', '..', '..');
    const launcherPath = path.join(pluginRoot, 'scripts', 'launch-antigravity.ps1');
    if (!fs.existsSync(launcherPath)) {
      throw new Error(`Launcher script not found: ${launcherPath}`);
    }

    fs.mkdirSync(this.#dataDir, { recursive: true });
    const vbsPath = path.join(this.#dataDir, 'launch-antigravity-hidden.vbs');
    const escapedLauncher = launcherPath.replace(/"/g, '""');
    const vbsContent =
      'Set sh = CreateObject("Wscript.Shell")\r\n' +
      `sh.Run "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ""${escapedLauncher}"" -ListenPort ${parseInt(listenPort, 10) || 17890}", 0, False\r\n`;
    fs.writeFileSync(vbsPath, vbsContent, 'utf8');

    const localAgyExe = path.join(
      process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
      'Programs',
      'antigravity',
      'Antigravity.exe'
    );
    const iconLoc = fs.existsSync(localAgyExe) ? `${localAgyExe},0` : '';

    const psScript = [
      '$ErrorActionPreference = "Stop"',
      '$desktop = [Environment]::GetFolderPath("Desktop")',
      '$startMenu = Join-Path $env:APPDATA "Microsoft\\Windows\\Start Menu\\Programs"',
      '$candidates = @((Join-Path $desktop "Antigravity.lnk"), (Join-Path $startMenu "Antigravity.lnk"))',
      '$sh = New-Object -ComObject WScript.Shell',
      '$backed = @()',
      'foreach ($lnk in $candidates) {',
      '  if (-not (Test-Path $lnk)) { continue }',
      '  $sc = $sh.CreateShortcut($lnk)',
      '  $backed += [pscustomobject]@{ path=$lnk; targetPath=$sc.TargetPath; arguments=$sc.Arguments; workingDirectory=$sc.WorkingDirectory; iconLocation=$sc.IconLocation }',
      '  $sc.TargetPath = "wscript.exe"',
      `  $sc.Arguments = '//B //Nologo "${vbsPath.replace(/'/g, "''")}"'`,
      `  $sc.WorkingDirectory = '${path.dirname(vbsPath).replace(/'/g, "''")}'`,
      iconLoc ? `  if (-not $sc.IconLocation -or $sc.IconLocation -eq ',0') { $sc.IconLocation = '${iconLoc.replace(/'/g, "''")}' }` : '',
      '  $sc.Save()',
      '}',
      'ConvertTo-Json -InputObject @($backed) -Compress',
    ].filter(Boolean).join('; ');

    const raw = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', psScript],
      { encoding: 'utf8', windowsHide: true, timeout: 6000 }
    ).trim();
    const items = JSON.parse(raw || '[]');
    if (configStore && !configStore.data.shortcutBackup && items.length > 0) {
      configStore.update({ shortcutBackup: items });
    }
    return this.getShortcutStatus({ configStore });
  }

  /**
   * Restore backed-up Desktop & Start Menu Antigravity.lnk shortcuts.
   */
  restoreShortcuts({ configStore } = {}) {
    if (process.platform !== 'win32') {
      throw new Error('Shortcut restore is supported on Windows only');
    }
    const backup = configStore?.data?.shortcutBackup;
    if (!Array.isArray(backup) || backup.length === 0) {
      return this.getShortcutStatus({ configStore });
    }

    const b64 = Buffer.from(JSON.stringify(backup), 'utf8').toString('base64');
    const psScript = [
      `$items = ConvertFrom-Json ([System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')))`,
      '$sh = New-Object -ComObject WScript.Shell',
      'foreach ($item in $items) {',
      '  if (-not (Test-Path $item.path)) { continue }',
      '  $sc = $sh.CreateShortcut($item.path)',
      '  $sc.TargetPath = [string]$item.targetPath',
      '  $sc.Arguments = [string]$item.arguments',
      '  $sc.WorkingDirectory = [string]$item.workingDirectory',
      '  if ($item.iconLocation) { $sc.IconLocation = [string]$item.iconLocation }',
      '  $sc.Save()',
      '}',
    ].join('; ');

    execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', psScript],
      { encoding: 'utf8', windowsHide: true, timeout: 6000 }
    );
    configStore.update({ shortcutBackup: null });
    return this.getShortcutStatus({ configStore });
  }
}
