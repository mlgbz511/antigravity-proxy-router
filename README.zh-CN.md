# Antigravity Proxy Router

[English](README.md) | 简体中文

面向 Windows 平台 Antigravity 的域名分流代理网关与 Geo-Guard 地区风控插件，用于替代 Proxifier + V2rayN 的流量接管方案。

## 核心特性

- **底层透明接管（`version.dll`）**：无需 Proxifier、无需 TUN 模式、无需修改系统环境变量，直接接管 Antigravity 前端与 `language_server` 后端流量
- **多代理管理**：支持上游代理健康检查、真连接延迟探测与故障自动切换
- **域名分流**：内置 Antigravity / Google 常用域名规则，支持未知域名实时捕获与一键加规则
- **Geo-Guard 地区风控**：出口 IP 落入受限地区时自动熔断拦截（503），防止账号风控
- **Node.js 零依赖**：纯 Node.js 标准库实现，无需 `npm install`

## 一键安装（Windows）

在 PowerShell 中运行以下命令，将自动完成插件安装、启动后台守护进程、开启 `custom` 分流模式，并自动接管 `settings.json` 与 `version.dll`：

```powershell
irm https://raw.githubusercontent.com/mlgbz511/antigravity-proxy-router/main/scripts/remote-install.ps1 | iex
```

或从本地仓库安装：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/install.ps1
```

## 卸载

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\.gemini\config\plugins\antigravity-proxy-router\scripts\install.ps1" -Uninstall
```

## 使用说明

1. 安装完成后，**重启一次 Antigravity** 使 `version.dll` 生效。
2. 在 Antigravity 侧边栏 `+` 菜单打开 **Proxy Router** 面板（或浏览器访问 `http://127.0.0.1:17891/`），配置上游代理（如 V2rayN SOCKS5 `127.0.0.1:25888`）即可。
3. 若 Antigravity 客户端自动更新后覆盖了 `version.dll`，在控制面板「风控与接管」页签点击一次 **接管** 即可恢复。

## 鸣谢

- 底层透明代理注入组件 `version.dll` 来自开源项目 [yuaotian/antigravity-proxy](https://github.com/yuaotian/antigravity-proxy)（采用 **BSD-2-Clause** 开源协议）。
