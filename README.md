# Antigravity Proxy Router

Telegram-style domain-aware proxy router for Antigravity, replacing Proxifier + V2rayN's flow interception.

## Features

- **Multi-proxy management** with health checking and auto-switch
- **Domain-based split routing** with 14 preset Antigravity domains
- **Auto domain capture** — unknown domains appear in real-time logs for one-click addition
- **Geo-Guard strict mode** — circuit breaker blocks cloud requests when exit IP lands in restricted regions
- **agy CLI support** — one-click `HTTPS_PROXY` user environment variable takeover
- **Zero dependencies** — pure Node.js stdlib, no npm install needed

## Install

```powershell
pwsh plugins/antigravity-proxy-router/scripts/install.ps1
```

## Uninstall

```powershell
pwsh plugins/antigravity-proxy-router/scripts/install.ps1 -Uninstall
```

## Usage

After installation, restart Antigravity. The **Proxy Router** panel appears in the side pane "+" menu. Configure your upstream proxy (e.g., V2rayN SOCKS5 port), click "Take Over", and disable Proxifier.
