# Antigravity Proxy Router

Domain-aware proxy router and Geo-Guard gateway for Antigravity on Windows, replacing Proxifier + V2rayN flow interception.

## Features

- **Transparent `version.dll` Takeover** — intercepts Antigravity frontend & `language_server` backend traffic without Proxifier, TUN mode, or environment variable hacks (powered by `yuaotian/antigravity-proxy`, BSD-2-Clause)
- **Multi-proxy Management** — health checking, latency probing, and auto-switch
- **Domain-based Split Routing** — preset Antigravity & Google domains with real-time unknown domain capture
- **Geo-Guard Strict Mode** — circuit breaker blocks cloud requests when exit IP lands in restricted regions
- **Zero Node.js Dependencies** — pure Node.js stdlib, no `npm install` needed

## One-Click Install (Windows)

Run in PowerShell (auto-installs plugin, starts daemon, enables `custom` mode, and applies `settings.json` + `version.dll` takeover):

```powershell
irm https://raw.githubusercontent.com/mlgbz511/antigravity-proxy-router/main/scripts/remote-install.ps1 | iex
```

Or from a local clone:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/install.ps1
```

## Uninstall

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\.gemini\config\plugins\antigravity-proxy-router\scripts\install.ps1" -Uninstall
```

## Usage

After installation, restart Antigravity once so `version.dll` takes effect. Open the **Proxy Router** panel (or `http://127.0.0.1:17891/`) to manage upstream proxies, routing rules, Geo-Guard, and live logs.
