---
name: proxy-router
description: Antigravity Proxy Router 状态查询、域名分流排查与代理健康诊断。当用户询问代理状态、连接问题或域名是否走代理时调用。
---

# proxy-router

## 何时用

- 用户询问 Antigravity 代理/网络/连接状态
- 排查某域名是否命中代理规则
- 检查代理出口地区或健康状态

## 操作

1. 在 Antigravity 侧边栏打开控制台：[Proxy Router](sidecar://antigravity-proxy-router/proxy_router/)
2. 通过本地接口 `http://127.0.0.1:${SIDECAR_PORT}/api/status` 获取实时状态辅助诊断。
3. 通过 `POST /api/test-domain` 传入 `{ "domain": "xxx" }` 可检查某域名的命中路由。
