# OpenMeet

开源、可自托管的桌面会议应用。Electron 客户端 + Node.js 服务端，音视频走 WebRTC 点对点，会议聊天与历史只保存在本机 SQLite。

- **本地优先**：账号令牌用系统安全存储（Windows DPAPI / macOS Keychain / libsecret）加密，会议记录与聊天写入本机，不上传服务器
- **局域网优先的连接**：同一网络内 IPv4 / IPv6 直连，跨网络走 STUN，复杂网络可启用 TURN 桥接
- **两种开会方式**：登录自托管服务器创建房间，或主机在本机直接起一个临时局域网会议（无需账号）
- **访问控制**：房间密码、等候室准入、房间锁定、举手、主持者 / 联席主持、静音与移出
- **完全可自托管**：服务端只有一个入口文件，依赖只有 `ws`

## 界面

中文界面，覆盖登录注册、首页、预览页、会议中、历史记录与设置。

## 快速开始

环境要求：Node.js ≥ 22.5（开发使用 24），npm ≥ 10。

```bash
npm install

# 终端 1：启动自托管服务器（默认 http://127.0.0.1:8787）
npm run dev:server

# 终端 2：启动桌面客户端（开发模式）
npm run dev:desktop
```

在登录页填入 `http://localhost:8787`，注册第一个账号（该账号会成为管理员），即可创建房间并把「邀请」里的 `OM1.` 文本发给其他人。

只想在同一网络里快速开会：首页点 **局域网会议**，主机会在本机起一个临时服务（默认端口 45871），把邀请发给同事，对方粘贴即可加入；主机离开会议后服务自动关闭。

> 端口 8787 若被占用，用 `OPENMEET_PORT=18787 npm run dev:server` 换端口。

## 自托管部署

```bash
npm run build:server
OPENMEET_DATA_DIR=/var/lib/openmeet node packages/server/dist/index.mjs
```

或使用容器：

```bash
docker compose up -d --build
```

全部环境变量（监听地址、注册开关、STUN/TURN、日志级别等）见 [docs/05-部署与运维.md](docs/05-部署与运维.md)。

TURN 桥接两种模式：`OPENMEET_TURN_MODE=embedded` 使用进程内嵌的 TURN 服务（需 `node-turn`），`=coturn` 则对接外部 coturn 的 `static-auth-secret` 并下发短时凭据。客户端也可在「设置 → 网络连接」里自行填写 TURN。

## 构建安装包

```bash
npm run build            # 服务端 + 客户端
npm run package:win      # Windows x64（electron-builder，输出到 packages/desktop/release）
npm run typecheck        # 全仓库类型检查
npm test                 # 服务端集成测试
```

## 仓库结构

```
packages/
  shared/    协议与类型的单一来源：房间、消息、邀请编解码、房间码规则
  server/    自托管服务端：账号、房间、信令、LAN 模式、可选 TURN
  gateway/   互通网关：SIP 信令、RTP↔SRTP 媒体桥、G.711↔Opus、房间参与者
  desktop/   Electron 客户端：主进程 + 预加载 + React 渲染层
docs/
  01-概要设计.md      目标、组件划分、网络拓扑、技术选型
  02-详细设计.md      模块与状态机细节、WebRTC 协商、安全边界
  03-接口规范.md      HTTP / WebSocket / IPC / 邀请格式契约
  04-数据模型.md      SQLite 表结构、令牌与历史存储
  05-部署与运维.md    环境变量、反向代理、TURN、备份与排障
  06-互通网关.md      SIP/H.323 接入架构、编码策略、验证状态清单
```

## SIP / H.323 互通（进行中）

新增 `packages/gateway`：让电话终端与会议系统接入 OpenMeet 房间。网关以**普通参与者**身份入会，
受同样的密码、等候室、锁定与主持者权限约束，服务端与客户端行为不变。

已验证：网关与 Chromium 真实 WebRTC 栈双向媒体互通、网关加入真实房间并收发音频、
Node 上的 SIP/UDP 事务、G.711 与 Opus↔G.711 全链路（含频域断言）。

**尚未完成：SIP 入呼接通**（sip.js 会话生命周期接线问题，测试以 `skip` 标注原因保留）。
H.323 不自研协议栈，按业界通行方式经外部 H.323↔SIP 网关落到本网关的 SIP 侧。

架构、编码策略、验证与未验证清单见 [docs/06-互通网关.md](docs/06-互通网关.md)。

```bash
npm run build:gateway
node packages/gateway/scripts/e2e-bridge.mjs   # 自建临时环境跑全链路验证
```

## 已知边界

- 采用 Mesh 拓扑，房间人数上限 12 人；更大规模需要引入 SFU
- 会议聊天只落盘本机，且仅保存自己发送的消息，服务器不留存
- 局域网邀请只发布可被 URL 解析的地址（IPv4 与全局 IPv6）；链路本地 `fe80::` 需要 zone id，无法作为邀请地址
- 单场会议的远端音视频按参与者两两直连，带宽与解码压力随人数平方增长

## 许可

MIT，见 [LICENSE](LICENSE)。
