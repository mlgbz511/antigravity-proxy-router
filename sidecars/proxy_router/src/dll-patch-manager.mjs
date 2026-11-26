// dll-patch-manager.mjs — Manage version.dll transparent proxy injection for Antigravity on Windows
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

export function getBundledDllPath() {
  return path.resolve(__dirname, '..', '..', '..', 'assets', 'bin', 'version.dll');
}

export function findAntigravityInstallDir() {
  if (process.platform !== 'win32') return null;
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) return null;
  const candidates = [
    path.join(localAppData, 'Programs', 'antigravity'),
    path.join(localAppData, 'Programs', 'Antigravity IDE'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'Antigravity.exe')) || fs.existsSync(path.join(dir, 'Antigravity IDE.exe'))) {
      return dir;
    }
  }
  return null;
}

export function getDllStatus({ listenHost = '127.0.0.1', listenPort = 17890, installDirOverride = null } = {}) {
  const bundledPath = getBundledDllPath();
  const bundledExists = fs.existsSync(bundledPath);
  const installDir = installDirOverride || findAntigravityInstallDir();

  if (!installDir) {
    return {
      supported: process.platform === 'win32',
      bundledExists,
      installDir: null,
      dllExists: false,
      dllInSync: false,
      configPointingToUs: false,
      enabled: false,
    };
  }

  const targetDll = path.join(installDir, 'version.dll');
  const targetCfg = path.join(installDir, 'config.json');
  const dllExists = fs.existsSync(targetDll);

  let dllInSync = false;
  if (dllExists && bundledExists) {
    try {
      dllInSync = sha256File(targetDll) === sha256File(bundledPath);
    } catch {
      dllInSync = false;
    }
  }

  let configPointingToUs = false;
  if (fs.existsSync(targetCfg)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(targetCfg, 'utf8'));
      const p = parsed?.proxy || {};
      configPointingToUs =
        String(p.host || '').toLowerCase() === String(listenHost).toLowerCase() &&
        Number(p.port) === Number(listenPort);
    } catch {
      configPointingToUs = false;
    }
  }

  return {
    supported: process.platform === 'win32',
    bundledExists,
    installDir,
    dllExists,
    dllInSync,
    configPointingToUs,
    enabled: dllExists && configPointingToUs,
  };
}

export function enableDllPatch({ listenHost = '127.0.0.1', listenPort = 17890, installDirOverride = null } = {}) {
  const bundledPath = getBundledDllPath();
  if (!fs.existsSync(bundledPath)) {
    throw new Error(`Bundled version.dll not found at ${bundledPath}`);
  }
  const installDir = installDirOverride || findAntigravityInstallDir();
  if (!installDir) {
    throw new Error('Antigravity installation directory not found');
  }

  const targetDll = path.join(installDir, 'version.dll');
  const targetCfg = path.join(installDir, 'config.json');

  fs.copyFileSync(bundledPath, targetDll);
  const cfgObj = {
    proxy: {
      type: 'http',
      host: listenHost,
      port: Number(listenPort) || 17890,
    },
  };
  fs.writeFileSync(targetCfg, JSON.stringify(cfgObj, null, 2) + '\n', 'utf8');

  return getDllStatus({ listenHost, listenPort, installDirOverride: installDir });
}

export function disableDllPatch({ listenHost = '127.0.0.1', listenPort = 17890, installDirOverride = null } = {}) {
  const installDir = installDirOverride || findAntigravityInstallDir();
  if (!installDir) {
    return getDllStatus({ listenHost, listenPort });
  }
  const targetDll = path.join(installDir, 'version.dll');
  const targetCfg = path.join(installDir, 'config.json');

  if (fs.existsSync(targetDll)) fs.unlinkSync(targetDll);
  if (fs.existsSync(targetCfg)) fs.unlinkSync(targetCfg);

  return getDllStatus({ listenHost, listenPort, installDirOverride: installDir });
}
