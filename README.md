# LXD Fleet Manager ／ 服务器管理面板

A local-only ops dashboard for a fleet of LXD hosts: storage & quotas, health checks, an in-browser container shell, port/forwarding ledgers, GPU/cluster health — read-only by default, and every "fix" is a command you copy, never something the tool runs for you.

面向一台/多台 **LXD 宿主机**的运维面板，跑在你自己电脑上（后端只听 `127.0.0.1`）。默认只读；体检、端口、配额查出的问题都只**生成命令**，不代执行。

> 适合：实验室/工作室里用 LXD 给成员开容器账户，机器和容器一多就记不清谁是谁、谁满、谁坏的环境。
> 不适合：公网 SaaS、需要多用户登录鉴权的场景（它没有用户体系，默认等于“你这台电脑的本人”）。

---

## 功能

| 版块 | 做什么 |
|---|---|
| **总览** | 6 张指标卡 + 「需要你处理」清单：把体检失败、配额告急、集群告警、端口不通、转发 IP 错、迁移残留、挂载源缺失合成一件事一条，带证据、修法和跳转 |
| **空间占用** | 每台 LXD 存储池的真实容量与使用率；每个容器的已用/配额/剩余；按人汇总；共享 NAS 单独一块（整设备 vs 共享内容量两个口径分开标） |
| **账户体检** | 9 项只读检查（显卡驱动一致性、GPU 设备节点、CUDA 挂载、配额、sshd、tmux、出网与 DNS、僵尸进程、torch 可见性），可单个/单机/全集群批量，逐项给命令、退出码、原始输出与修法 |
| **端口与配额** | 从 LXD `proxy` 设备生成端口台账；一键「探测并定责」分清**路由器缺转发**还是 **proxy 没生效**；「核对转发 IP」比对 `connect` 与容器实际 IP，能识别地址互换/串到别的容器；配额预警与扩容命令 |
| **集群与显卡** | 成员状态、角色与 quorum、LXD 版本、`snap hold`、时钟偏差、开机时长；宿主驱动矩阵；每张卡的显存/利用率/温度/功耗与**谁在用哪张卡**；default profile 体检 |
| **容器抽屉** | 任何地方点容器名 → 右侧抽屉：配额、端口、逐项体检、**WebSocket 容器终端**（里面套 tmux，关掉页面不会杀进程） |

深色/浅色主题、窄屏自适应、哈希深链（`#/overview`、`#/space`、`#/ports`、`#/infra`、`#/health?container=NAME&server=s0`）。

---

## 环境要求

- Node.js **20+**
- 被管理的机器：Linux + **LXD 5.x**（4.x 大概率也能跑，未验证），SSH 可登录
- 可选：
  - `zfsutils-linux` + 一条**只读**受限 sudo 规则 → 能读到停着的容器的磁盘用量（不装就退化成 `lxc exec + df`，只能看运行中的）
  - `nvidia-smi`（显卡相关版块）
  - `tmux`（容器终端会用它保持会话）

## 快速开始

```bash
git clone <this-repo> && cd server-manager
npm install

cp servers.example.json servers.json   # 改成你自己的机器清单（见下）
npm run install-key                    # 一次性：把公钥装到每台机器
npm run dev                            # 打开 http://localhost:5173
```

`servers.json`（已在 `.gitignore` 里，**不要提交**）：

```json
{
  "servers": [
    { "id": "s0", "host": "192.168.1.10", "port": 2222, "user": "s0" },
    { "id": "s1", "host": "192.168.1.10", "port": 122,  "user": "s1" }
  ]
}
```

`id` 建议和 LXD 的成员名一致（集群模式下要按 `location` 把容器归回各台）。所有机器共用同一个入口 IP、用不同端口区分也可以（示例就是这样）。

### 一次性配置

```bash
npm run install-key    # 交互输入一次密码，公钥写入 ~/.ssh/authorized_keys 并验证免密
npm run setup-root     # 可选：装 zfsutils-linux + 只读 sudoers（仅 zfs/zpool 的 list*）
npm run trust          # 看已记录的 SSH 主机指纹（首次连接自动记录）
```

`setup-root` 只放行**只读**子命令，不会给 `NOPASSWD ALL`，也不改 `/dev/zfs` 权限。

## 常用命令

```bash
npm run dev            # 后端 :8787 + 前端 :5173
npm run stop           # 释放端口（含 Ctrl+C 没杀干净的残留）
npm run probe          # 不开界面，终端里看采集结果
npm run check -- --container NAME      # 不开界面跑体检
npm run check -- --all --json          # 全集群体检（机器可读）
npm run term-smoke -- s0 NAME          # 无头验证容器终端（走浏览器同一条 WS）
npm run audit          # 数据正确性审计（孤儿数据集、界面值 vs 现场值、驱动/版本漂移、端口对账）
npm test               # 124 条离线测试（解析、判定、脚本守卫、主题对比度）
npm run build          # 生产构建
```

端口/域名想换：`.env` 里改 `API_PORT`、`GATEWAY_HOST`（外部访问入口，默认用 `servers.json` 第一台的 host）。

## 安全模型（请读完再用）

这是一个**本机运维工具**，不是面向公网的服务：

- 后端只监听 `127.0.0.1`；HTTP 和 WebSocket 都会校验 `Host`/`Origin`（挡 DNS rebinding 与第三方网页借你的浏览器调本机 API）。
- SSH 主机密钥采用 **TOFU**：首次连接记下指纹（`.cache/known_hosts.json`），之后不一致直接拒绝，并提示用 `npm run trust -- --forget <host:port>` 处理。想临时关闭：`SSH_VERIFY_HOST=0`。
- 容器终端通过 `lxc exec` 进入，**默认是容器内的 root**；默认不提供宿主机 shell（要 `ALLOW_HOST_TERMINAL=1`）。日志只记会话起止（`logs/sessions.jsonl`，已 gitignore），不录键入内容。
- 所有“修复”都只生成命令：配额、端口、驱动、迁移、重启，一律由人确认后执行。工具不会自动 `stop`/`delete`/`reboot` 任何东西。
- `.cache/`、`logs/`、`servers.json`、`expected-ports.json`、`.env` 都在 `.gitignore` 里——它们会包含主机名、容器名和 IP。

## 数据口径（很重要，别混着比）

1. **LXD 的 ZFS 池不在 `df` 里**（LXD 用 legacy 挂载）。容量要走 `lxc query /1.0/storage-pools/<pool>/resources`，否则会把系统盘当成整机容量。
2. **容器的用量有三条来源**，精度和覆盖面不同：`zfs list`（含停着的容器，需只读授权）> `lxc exec -- df`（只要运行中的）> 未知。界面上每个容器都标了口径。
3. **`lxc list` 在集群里返回全部成员**，必须按 `location` 拆回各台，否则台数会翻好几倍。
4. **共享 NAS 要按挂载源去重**，否则同一份存储会被每台各算一次。`df` 报的是导出方整个卷，`du` 报的是该共享目录树，两者不是一回事。
5. **端口“通”不等于“对”**：TCP 探测只能证明外面进得去；要判断是路由器缺转发还是 proxy 没生效，还得登到成员上看 `ss -ltn`；要判断转发目标对不对，得进容器跑 `hostname -I` 比对 `connect`。
6. **容器里的驱动必须和它所在成员的宿主一致**（容器里装驱动要带 `--no-kernel-module`）。所以判驱动时永远和**容器所在成员**比，不是和发起 SSH 的那台比。

## 踩过的坑（都写成了测试）

- `zfs version` 需要 root 才能跑，不能拿来当“可用性探测”；用 `ldd` 查依赖更靠谱。
- 受限 sudoers 下 `sudo -n true` 必然被拒，不能用它预判“有没有 sudo”，要直接试目标命令。
- 采集脚本里每段输出**必须自带换行**，否则下一段的 `@@SEC` 标记会被粘到同一行，整段丢失。
- `String.raw` 仍会插值 `${}`，模板里的反引号还会截断字符串——shell 脚本里的注释不要写反引号。
- `lxc exec` 的退出码不能被 `| head` 吞掉，否则容器停着也会被当成成功。
- 缓存结论必须按当前配置校正：配置改好之后，旧结论不能继续报错。
- `hostname -I` 会带出 Docker 的 `172.17.0.1`，判地址要按集合比，不能整串比。
- 时钟偏差只能和“同一时刻”比：拿各台自报的 epoch 互减，会算出十几秒的假告警。

## 目录结构

```
server/            采集与 API（Express + ssh2 + ws）
  config.mjs       机器清单、超时、开关
  collect.mjs      单次 SSH 多段采集 + 解析
  lxd.mjs          LXD/ZFS 层（池、实例、数据集、proxy、profile）
  cluster.mjs      集群成员/角色/quorum/版本/时钟/snap
  gpu.mjs          显卡、GPU 进程归属、profile 体检
  ports.mjs        端口台账、TCP 探测定责、转发 IP 核对
  quota.mjs        配额预警与扩容建议
  checks.mjs       体检检查项注册表（9 项）
  terminal.mjs     容器终端（WS ↔ SSH pty ↔ tmux）
  guard.mjs        Host/Origin 本机访问边界
  index.mjs        HTTP API + 作业
scripts/           安装密钥、只读授权、体检 CLI、审计、端口检查、终端冒烟
src/               React 前端（Vite）
  components/      版块与通用组件
  lib/             格式化、请求、toast
```

## 已知限制

- 没有用户体系/多用户隔离，默认信任“本机本人”。
- 集群角色、端口转发、路由器配置都只能读到能读的部分；路由器那条转发规则**无法从 API 读**，所以用 TCP 探测 + 成员侧 `ss` 间接判断。
- 容器终端的“断开不中断”依赖容器里装了 tmux；没装会退化成普通 bash。
- 目前只测过 Ubuntu 22.04 + LXD 5.0.x + ZFS 的组合。

## 贡献

欢迎 issue / PR。提交前请跑 `npm test && npm run build`；不要提交任何真实的 `servers.json`、容器名、内网地址或个人数据。

## License

[MIT](./LICENSE)
