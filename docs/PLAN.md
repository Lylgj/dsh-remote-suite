# dsh-remote-suite 详解

> 一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件：把 **WSL 发行版、
> SSH 主机、Docker 容器、远端常驻会话** 四类远程目标收敛到同一个 `Backend` 接缝、同一把 `remote`
> 工具和一个侧栏入口，用来替代此前并存的 `dsh-wsl-workspace` + `dsh-wsl-tool` +
> `@zhangfengshun/dsh-remote-ssh`。

**状态（2026-11-12）：M0 + M1a + M2a + M2b + M3a + M3b + M4a + M4b（常驻会话）+ M4c（端口转发 /
内嵌远端 UI）完成；M5 进行中。** npm 包名 `dsh-remote-suite`（未被占用），`npm pack` 产出 27 个文件
约 175 kB。

---

## 1. 它解决什么问题

同一台机器上，远程能力原本被三个插件各切一块：

| 旧插件 | 它做了什么 | 冲突点 |
|---|---|---|
| `dsh-wsl-workspace` | 把整个会话切换进某个 WSL 发行版 | 与第二个 WSL 插件重复实现 |
| `dsh-wsl-tool` | 按操作拆成一族工具，另加一个 PTY | 进程级注册 `wsl` 等工具名，与新版撞名 |
| `@zhangfengshun/dsh-remote-ssh` | SSH 目标 + 文件路由 | 重写侧栏文件路由与终端 shell，无法与上面共存 |

三者的共同病根是**把传输方式泄漏进了上层**：工具名、文件路径、终端实现各写一套。本插件的做法是
收成一个抽象——上层只认"目标"和"后端"，不认底下是 9p、SFTP 还是 `docker exec`。

由此得到三个直接收益：

1. **一把工具**：`remote`（`action` + `target`），模型不需要知道工作区在哪种传输上。
2. **一套语义**：`read` / `write` / `edit` / `grep` / `glob` / `exec` 在五类目标上行为一致。
3. **一个入口**：添加工作区对话框同时提供本机 / WSL / Docker / SSH 四类。

## 2. 能力速览

- **目标**：`local`、`wsl:<发行版>`、`ssh:<别名>`、`daemon:<别名>`、`docker:<容器名>`。
- **命令**：在目标内跑 shell 命令，返回 stdout / stderr / 退出码，支持超时与工作目录。
- **文件**：读（带行窗口）、整体写、原地 `edit`（默认要求唯一匹配）、`stat`、`list`。
- **搜索**：`grep`（内容，可带 `glob` 过滤）与 `glob`（按模式找文件），优先用目标上的 `rg`。
- **工作区**：`(目标, 目录)` 持久化；此后用 `workspace` 代替 `target`，路径变相对、`exec` 默认落到该目录。
- **凭据**：SSH 密码单独存 `secrets.json`（0600），不进 `state.json`。
- **镜像**：远端目录的本地副本，`pull` / `push`，带 mtime 护栏与 `dryRun`。
- **终端**：本地 PowerShell、WSL bash、ssh2 shell、`docker exec -it`，走 Host PTY + xterm。
- **隧道**：任意 SSH 主机的端口转发到 loopback，足以把远端 `dsh web` 嵌进本地界面。

---

## 3. 架构

### 3.1 两层

```
┌──────────────── client.js（浏览器半，无构建步骤）───────────────┐
│ 「添加工作区」接管（directoryFlow）+ 可选工作区视图              │
│   目标切换 / 文件树 / 编辑器页签 / 命令控制台 / xterm / web 页签 │
└──────────────┬──────────────────────────────────────────────────┘
               │  POST /remote-suite/api/*（JSON，需 x-remote-suite:1）
               │  WS   /remote-suite/pty（同源校验）
               │  GET  /remote-suite/assets/*（xterm.js 等）
┌──────────────▼──────────── host 半（index.js）─────────────────┐
│ registry（lib/backends/index.js）                               │
│   local │ wsl │ ssh │ docker │ daemon                           │
│   每个 backend：exec / read / write / stat / list               │
│                + grep / glob / probe / openTerminal             │
│ 可选服务：webServer（路由）、subprocess（PTY）、MirrorService    │
│           CredentialStore、StateStore                           │
└─────────────────────────────────────────────────────────────────┘
```

### 3.2 设计原则

1. **工具层只认 backend**。目标 id 是稳定字符串，`local` / `wsl:<发行版>` / `ssh:<别名>` /
   `docker:<容器>` / `daemon:<主机>`；注册表按需创建、按 TTL 缓存发现结果、统一 `dispose`。
2. **一把 `remote` 工具**，而不是 `wsl_*` / `ssh_*` 两族；`targets` 列出存在什么，其余动作只吃
   `target`（或 `workspace`）。
3. **可选服务一律运行时探测**。`tools` 是硬依赖，`webServer` / `subprocess` / `slots` 都是
   "有就用、没有就降级"，因此裸 CLI Host 也能挂载本插件。
4. **错误必须抛出**，由 `lib/errors.js` 统一翻译成人话（`explain` / `withHint`），不静默吞掉。
5. **默认不镜像远端文件**；需要本地编辑器 / 搜索 / `git` 时才开镜像模式。

### 3.3 Backend 契约（`lib/backends/base.js`）

```js
exec({ command, workdir?, timeoutMs?, stdin? })
  -> { stdout, stderr, exitCode, timedOut, truncated }
read({ path, maxBytes? })   -> string (utf8)
write({ path, data })       -> { bytes }
stat({ path })              -> { type, size, mtimeMs, mode? }
list({ path, limit? })      -> { entries: [{ name, type, size }] }
home()                      -> string        // 可选：展开 `~`
probe()                     -> env facts     // 可选
dispose()
```

外加 `grep` / `glob` / `openTerminal` 三个可选能力，由 `lib/backends/index.js` 在目标不支持时
统一报错或降级。输出统一截断到 `MAX_OUTPUT_BYTES = 64 KiB`，且按字符边界切，标记不会落在码点中间。

### 3.4 模块清单

| 文件 | 职责与实现要点 |
|---|---|
| `index.js` | host 入口：`inject(['tools','subprocess'])`，注册 `remote` 工具；`ctx.inject(['webServer'])` 里挂 `/remote-suite/api`、`/remote-suite/assets`、`/remote-suite/pty`；返回幂等 disposer |
| `lib/backends/index.js` | 目标注册表：`local` + `wsl:*` + `ssh:*` + `daemon:*` + `docker:*`，各自 TTL 缓存发现结果 |
| `lib/backends/local.js` | 本机后端，接缝的参考实现（exec / read / write / stat / list / grep / glob / probe） |
| `lib/backends/wsl.js` | WSL 后端：脚本经发行版内 `/tmp` 暂存再执行（规避 `wsl.exe` 对 `--` 之后命令行的二次求值）、UTF-8 处理、`--cd`、9p 读、发行版内写入与 rg/grep/find、distro 发现 |
| `lib/backends/ssh.js` | SSH 后端：ssh2 连接复用与断线重连；多把 key → ssh-agent → 密码（`keyboard-interactive`/`password`，`tryKeyboard`）依次尝试；任意跳数 ProxyJump；SFTP 文件；远端 rg/grep/find；`~` 展开；`persistent:true` 时额外提供 `daemon:<别名>` 常驻 bash 会话 |
| `lib/backends/docker.js` | Docker 后端：`docker exec -i <容器> sh -lc`，POSIX shell 即契约（busybox 够用），CLI 可被 `DSH_DOCKER` 覆盖 |
| `lib/backends/base.js` | 契约文档 + 输出截断 |
| `lib/fs-util.js` | glob→正则、目录遍历（跳过 `.git` / `node_modules`）、路径归一 |
| `lib/ssh-config.js` | 解析 `~/.ssh/config`（Host / HostName / User / Port / IdentityFile / ProxyJump；跳过 `Match` 与通配别名） |
| `lib/secrets.js` | SSH 密码存储：`$DSH_HOME/remote-suite/secrets.json`（0600，`DSH_REMOTE_SUITE_SECRETS` 覆盖），按 `user@host` 查找（端口无关） |
| `lib/state.js` | `$DSH_HOME/remote-suite/state.json` 读写（workspaces + mirrors + profiles），`DSH_REMOTE_SUITE_STATE` 可覆盖 |
| `lib/mirror.js` | 本地镜像：`dd … \| base64` 分块双向传输，远端无需 tar/rsync |
| `lib/tunnel.js` | SSH 端口转发：loopback 监听 + `forwardOut` 双向管道；`waitForTunnel` 轮询探测 |
| `lib/scope.js` | 作用域解析（workspace/target → backend + base），工具与 HTTP API 共用 |
| `lib/api.js` | 浏览器半的 JSON API（见 §6.3） |
| `lib/pty.js` / `lib/pty-server.js` | Host PTY provider 适配 + `/remote-suite/pty` WebSocket 桥（open/data/resize/exit） |
| `lib/assets.js` | 同源静态资源路由（xterm.js / xterm.css / addon-fit.js） |
| `lib/tool-remote.js` | `remote` 工具 schema、参数校验、结果格式化 |
| `lib/errors.js` | 错误翻译与提示拼接 |
| `client.js` | 浏览器半：接管添加工作区流程；内含可选工作区视图（rail 图标、文件树、编辑器、xterm、web 页签） |
| `cordis.patch.yml` | 进程级 insert 一行 `remote-suite`，让 `remote` 工具到达所有 preset |
| `assets/` | 随包附带的 xterm.js（约 488 KB）、xterm.css、addon-fit.js |
| `test/*.mjs` | 见 §10 测试矩阵 |

---

## 4. 五类目标

### 4.1 `local`

本机。Windows 上用 PowerShell，macOS / Linux 用 `$SHELL`。它是整个接缝的参考实现：其它后端只要
和它的行为一致，上层的工具/API/UI 就无需区分。搜索优先 `rg`，缺失时回退 `grep -rnIE` / `find`。

### 4.2 `wsl:<发行版>`

WSL 有三处非显然的坑，都固化在 `lib/backends/wsl.js`：

1. **命令行二次求值**：`wsl.exe` 把 `--` 之后的参数当成一整条命令行重新求值，脚本里的 `$name`、
   `$(…)` 会在 bash 启动之前被展开（通常成空）。所有脚本必须写到发行版内 `/tmp` 再按路径执行
   （`runWslScript`），`test/smoke.mjs` 保留了 `$vars` 与 `$(…)` 的回归断言。
2. **写入不能靠 9p**：9p 不支持原子 rename，就地写会破坏语义；写入走发行版内的 `cat`。
3. **性能**：大目录的 `list` / `glob` 走 UNC 很慢，因此搜索与遍历尽量在发行版内跑 `find` / `rg`。

读取文件仍可用 9p（`\\wsl.localhost\<发行版>\<路径>`），这也是添加工作区时对 DSH 暴露的路径。

### 4.3 `ssh:<别名>`

- **发现**：`~/.ssh/config` 里每个非通配 `Host`（`DSH_SSH_CONFIG` 可换文件）成为一个目标；
  `HostName`、`User`、`Port`、多个 `IdentityFile` 生效；`ProxyJump` 支持任意跳数（别名或
  `user@host:port`，逗号分隔成链）。
- **认证顺序**：`DSH_SSH_IDENTITY`（CI 覆盖，`;` 分隔）→ profile 的 `IdentityFile` →
  `~/.ssh/id_ed25519` / `id_rsa` / `id_ecdsa` → `ssh-agent`（Windows 上是 OpenSSH agent 管道）→
  已存密码（`keyboard-interactive` / `password`，`tryKeyboard`）。
- **连接复用**：按 host 池化；连接级错误自动重连一次。
- **文件**：SFTP；**搜索**：远端 `rg` / `grep` / `find`。
- **不做**：不调系统 `ssh` 二进制——通道、SFTP、PTY 全在 ssh2 里完成，因此不依赖本机 ssh 客户端配置。

### 4.4 `docker:<容器名>`

运行中的容器通过 `docker ps --format` 发现。后端假定 Linux 容器 + POSIX shell，只通过
`docker exec -i <容器> sh -lc <脚本>` 与它交互——**CLI 就是契约**，所以 Docker Desktop、
`DOCKER_HOST`、rootless 方案都无需额外代码；引擎二进制可用 `DSH_DOCKER` 换成 `podman` / `nerdctl`。
命令、文件读写、stat/list、grep、glob 全部在容器内执行，不需要 daemon 或 API 客户端；终端是
`docker exec -it <容器> sh`。

### 4.5 `daemon:<别名>`

同一台 SSH 主机、同一条连接，但所有 `exec` 共用一条非交互 `bash` 通道，于是 `cd`、`export`、
shell 函数在调用之间保留——相当于一把"一直开着"的终端。文件工具仍走同一条连接上的 SFTP。命令里
写了 `exit` 会终结该 shell，返回值会明说（`the session ended while running this command`），
下一次调用静默重开。

---

## 5. `remote` 工具

`lib/tool-remote.js` 里的动作集合：

| action | 关键参数 | 说明 |
|---|---|---|
| `targets` | — | 列出 `{ id, kind, label }`（如 `local` → 标签「此电脑」） |
| `workspaces` | — | 已保存的 `(目标, 目录)` 对 |
| `workspace-add` | `target` / `path` / `name?` | 校验是目录，id 冲突时自动加后缀 |
| `workspace-remove` | `workspace` | 删除保存项 |
| `probe` | `target` / `workspace` | 目标环境事实（系统、平台、node、cwd） |
| `exec` | `command`、`workdir?`、`timeoutMs?` | 返回 `exit=N`、stdout、stderr、超时/截断标记 |
| `read` | `path`、`offset?` / `limit?` | 带行窗口，返回行号 |
| `write` | `path`、`data` | 整体覆盖 |
| `edit` | `path`、`old`、`new`、`replaceAll?` | 默认要求唯一匹配，否则报错而不是乱改 |
| `stat` / `list` | `path` | 路径信息 / 目录条目 |
| `grep` / `glob` | `pattern`、`glob?` / `root?` | 内容搜索 / 文件名搜索 |
| `secret-set` / `secret-remove` | `target`、`password` | 写 / 删 `secrets.json` |
| `mirrors` / `mirror-add` / `mirror-remove` | `target`、`path`、`name`、`local?` | 镜像登记 |
| `mirror-sync` | `mirror`、`direction`、`force?`、`dryRun?` | `pull` / `push` |

传 `workspace` 而不传 `target` 时，`path` 相对该目录解析，`exec` 默认 cwd 也落在该目录——这是让
长会话不必反复写绝对路径的关键。

---

## 6. 浏览器半（`client.js`）

### 6.1 添加工作区流程（默认可见入口）

Host 用一个 slot 渲染自带的「＋ 添加工作区」对话框。本插件在
`conversation.hero.workspace.directoryFlow` 与 `sidebar.workspaces.directoryFlow` 两个 seat 上以
`priority: -100` 接管（与 `dsh-remote-ssh` 同一套手法），于是官方 `＋` 打开的是本站的四个页签：
本机 / WSL / Docker / 远程 SSH。

选定目标目录后，浏览器先调 `prepare-path` 校验：目录必须存在，然后返回 DSH 应该打开的路径——
本机是路径本身，WSL 是 UNC 路径，Docker / SSH 则是（必要时刚创建的）本地镜像目录。这样 DSH 自带的
文件树和终端在四类目标上都能工作，不需要改 Host 的路由。

SSH 条目（别名、主机、用户、端口、key、可选密码）经 `ssh-profile-add` / `ssh-profile-remove`
落到 `state.json` + `secrets.json`。

### 6.2 可选工作区视图

`client.js` 里另有一整套自带 UI：rail「远程」图标 + `Workspace()` 视图（左侧目标/工作区面板与文件树，
右侧编辑器页签、命令控制台、xterm 终端页签、转发端口后的 web 页签）。它**默认不注册**——插件的
可见面只有上面那个添加流程；想恢复只需在 `apply()` 里补 `sidebar.panellist` 与 `main` 两个 seat，
资源路由与 PTY 桥已经就绪。

### 6.3 JSON API 与安全

`POST /remote-suite/api/<method>`，方法集合：
`targets`、`workspaces`、`workspace-add`、`workspace-remove`、`workspace-create`、`prepare-path`、
`ssh-profiles`、`ssh-profile-add`、`ssh-profile-remove`、`tree`、`home`、`roots`、`read`、`write`、
`stat`、`exec`、`forward`、`forwards`、`forward-close`。

三道约束：

1. **只接受 POST**，且必须带 `x-remote-suite: 1` 头——自定义头无法跨站发出，等于 CSRF 防护。
2. **请求体上限 8 MiB**（够一整个编辑器缓冲）。
3. **WebSocket upgrade 校验同源**（无 `Origin` 的测试客户端放行）。

响应统一 `{ ok, result | error }`，错误经 `explain()` 翻成可读文本；`index.js` 还会把实际到达的
请求记到 `$DSH_HOME/remote-suite/debug.log`（自定义 scheme 页面到不了路由时，这是唯一证据）。

### 6.4 PTY 桥协议

`/remote-suite/pty?target=…&cols=…&rows=…` 升级成 WebSocket 后，消息为
`open` / `data` / `resize` / `exit`；尺寸被夹取到合法区间，`dispose` 时关掉所有会话。前端用随包的
xterm；若 Host 没有 `spawnTerminal` provider，页签回退到命令控制台，文件功能不受影响。

---

## 7. 状态与凭据

| 文件 | 内容 | 说明 |
|---|---|---|
| `$DSH_HOME/remote-suite/state.json` | workspaces、mirrors、ssh profiles | `DSH_REMOTE_SUITE_STATE` 可覆盖；原子写 |
| `$DSH_HOME/remote-suite/secrets.json` | `user@host` → 密码 | 0600；`DSH_REMOTE_SUITE_SECRETS` 可覆盖；从不回显 |
| `$DSH_HOME/remote-suite/mirrors/<id>/` | 镜像内容 | `local=` 可覆盖 |
| `$DSH_HOME/remote-suite/debug.log` | 到达 API/WS 的请求摘要 | 排障用 |

密码按 `user@host` 查找、与端口无关：换了端口的主机仍能取回密码，换了用户则是另一个账户、取不到。
Windows 上 0600 是 no-op，实际保护依赖 profile 目录 ACL。

---

## 8. 镜像同步

镜像是远端目录的可选本地副本，供桌面侧编辑器、搜索与 `git` 使用：

```powershell
remote action=mirror-add target=wsl:Ubuntu path=/srv/app name=app
remote action=mirror-sync mirror=mir-app direction=pull
remote action=mirror-sync mirror=mir-app direction=push
```

传输以 32 KB 的 `dd … | base64` 分块，走目标自身的 `exec`，所以远端不需要 `tar` / `rsync`、不需要
额外端口，二进制内容完好（测试里用 100 KB 二进制比对 sha256）。

护栏：

- **pull 从不删本地文件**（只补新、更新旧）。
- **push 跳过远端更新更晚的文件**：远端 mtime 比本地新超过 2 秒即视为冲突并报告，除非 `force=true`
  （2 秒余量是给网络文件系统的时钟抖动留的）。
- **`dryRun=true`** 只报告计划，不落盘。

---

## 9. 端口转发与内嵌远端 UI

`daemon:` 会话足以承载一整套远端界面：

```powershell
remote action=exec target=daemon:box command="cd ~/app && nohup dsh web --port 8080 >/tmp/dsh.log 2>&1 &"
```

然后在「远程」视图填端口、点「转发」：插件在桌面侧开 loopback 监听，每个连接经 SSH 客户端隧道
（`forwardOut` → `socket.pipe(stream).pipe(socket)`），工作区开一个 iframe 页签指向它。关页签即关
隧道；重启面板丢弃所有转发。远端只需要那个服务本身——不需额外端口、不需 `ssh -L`、不需代理。

注意：转发出来的页面是另一个源（`127.0.0.1:<port>`），拿不到 DSH 的 cookie/令牌，所以远端服务必须
自己可访问或自带登录；`https` 页面也不能内嵌 `http` iframe。

---

## 10. 测试矩阵

| 测试 | 覆盖 | 是否需要外部环境 |
|---|---|---|
| `test/smoke.mjs` | 工具注册 + 路由 + CSRF 校验 + local exec/读写/edit/probe + read 行窗口 + grep/glob + workspace 增删用 + 错误路径 + 三个 WSL 发行版 + `$vars` 回归 | 需要 WSL |
| `test/api-smoke.mjs` | tree/read/write/stat/exec/workspace 作用域（local backend + stub registry） | 否 |
| `test/client-smoke.mjs` | 浏览器半：`window.__ModuleLoader__` 加载 + `react-dom/server` 渲染两个 seat | 否 |
| `test/pty-smoke.mjs` | PTY 桥：真实 http upgrade + ws 客户端，fake backend 驱动（尺寸夹取、data 往返、resize、exit、错误、dispose） | 否 |
| `test/docker-smoke.mjs` | Docker 后端的脚本经 WSL 接缝真实执行（write/read/offset/limit/stat/list/exec/退出码/缺目录/grep/glob/probe） | 需要 WSL，不需要 Docker |
| `test/secrets-smoke.mjs` | 密码 set/lookup/overwrite/remove、端口无关、用户不串、0600 | 否 |
| `test/mirror-smoke.mjs` | pull（含 100 KB 二进制 sha256 一致）、未变更跳过、push 写回、冲突护栏、force、dryRun、列表/删除 | 需要 WSL |
| `test/errors-smoke.mjs` | 错误翻译与提示 | 否 |
| `test/ssh-smoke.mjs` | 真实主机上的 exec/文件/edit/grep/glob/工作区；无主机时 skip | 需要 SSH 主机 |
| `test/ssh-jump-smoke.mjs` | 临时 `DSH_SSH_CONFIG`（jump + target），两跳 ProxyJump 下的 targets/probe/exec/文件往返/工作区 | 需要 SSH 主机 |
| `test/daemon-smoke.mjs` | cwd/环境变量跨调用、文件工具共用连接、退出码、`exit` 后重开、坏 workdir | 需要 SSH 主机 |
| `test/tunnel-smoke.mjs` | 远端 `python3 -m http.server` + `openTunnel` + loopback fetch + `close()` 后连接被拒 | 需要 SSH 主机 + python3 |

`npm test` 跑前八项（不含 `ssh` / `daemon` / `tunnel` / `jump` 四个真实主机测试，它们各有独立
script 入口）。

---

## 11. 里程碑与验证记录

| 阶段 | 内容 | 状态 |
|---|---|---|
| M0 骨架 | 包结构、patch、backend 契约、local + WSL 后端、`remote` 工具、侧栏接线、smoke | ✅ |
| M1a 后端补齐 | grep/glob、工作区持久化、edit、probe、read 行窗口 | ✅ |
| M2a SSH 后端 | `~/.ssh/config` 发现、ssh2 复用与重连、多 key/agent、单跳 ProxyJump、SFTP、远端搜索 | ✅ 真实主机验证 |
| M2b SSH 凭据 | 密码（`keyboard-interactive`/`password`）+ secret-set/remove（0600）、任意跳数 ProxyJump、镜像同步 | ✅ 真实主机验证 |
| M3a 自带 UI | 工作区视图：目标/工作区切换、文件树、编辑器页签、命令控制台 + JSON API | ✅ |
| M3b 真终端 | xterm 前端（同源资源）+ WebSocket PTY、本地 PowerShell / WSL bash / ssh2 shell、尺寸与回退 | ✅ |
| M4a Docker 后端 | `docker ps` 发现、`docker exec -i … sh -lc`、grep/glob、spawnPty；`DSH_DOCKER` 可换引擎 | ✅ 脚本级验证（本机无 Docker 运行时） |
| M4b 常驻会话 | `daemon:<别名>`：cd/export 跨调用保留，`exit` 后自动重开 | ✅ 真实主机验证 |
| M4c 内嵌远端 UI | 常驻会话里拉起远端 `dsh`，SSH 端口转发到本地，iframe 内嵌 | ✅ 真实主机验证 |
| M5 发布 | 兼容矩阵、错误恢复、文档、npm 打包 | 🔶 npm pack ✅、兼容矩阵与排障入 README ✅、ssh2 连接级自动重连 ✅；截图与真实 GUI 验证待装 profile |

已被真实执行验证过的路径（对应上面各里程碑）：WSL 三发行版的 exec + 写入 + grep + glob；对
`192.168.81.77` 的 SSH exec/退出码/`~` 展开/SFTP 往返/edit/read 窗口/grep/glob/工作区相对路径；
两跳 ProxyJump 下的整套文件与命令；`daemon:box` 的 cwd 与环境变量跨调用、文件工具共用连接、`exit`
后重开；镜像 pull/push 的二进制一致性、冲突护栏与 dryRun；PTY WebSocket 协议；隧道的
`openTunnel` → `fetch` → `close()` 全链路。

---

## 12. 兼容性

| 组件 | 要求 |
|---|---|
| DeepSeek Harness | Host API `>= 0.2.1-rc.2`（在 `0.2.2-rc.1` 上开发）；必需 `ctx.tools.register`、`ctx.inject(['webServer'])`、`webServer.register` / `registerUpgrade`；`ctx.get('subprocess').spawnTerminal` 可选 |
| Node（Host 进程） | `>= 20` |
| Windows 10/11 | 本机 PowerShell、WSL2、SSH、Docker（CLI）、隧道 |
| macOS / Linux | 本机 `$SHELL`、SSH、Docker；WSL 后端仅 Windows |
| 搜索 | 目标有 `rg` 时更快；否则回退 `grep -rnIE` / `find` |

`npm pack` 只带 `index.js`、`lib/`、`client.js`、`assets/`、`cordis.patch.yml`、`README.md`、
`LICENSE`；测试与 `docs/` 不随包发布。

---

## 13. 已知限制与风险

1. **工具名冲突**：旧 `dsh-wsl-tool` 以进程级 insert 注册 `wsl` 等名字。新插件注册 `remote` 不撞名，
   但两套并存时模型会看到十几把语义重复的工具，共存期建议只启用一套。
2. **DSH 0.2.x 迭代**：`ctx.slots`、tool schema 子集、`inject` 语义都在变（remote-ssh 已踩过
   `ctx.webRuntime` → `ctx.webStartup`）。对策：可选服务一律运行时探测，缺服务时降级而非崩溃。
3. **9p 性能**：大目录 `list` / `glob` 走 UNC 会慢；WSL 后端在发行版内跑 `find` / `rg` 规避。
4. **`wsl.exe` 二次求值**：见 §4.2，已用 `/tmp` 暂存 + 回归断言固化。
5. **终端依赖 Host provider**：不自带 node-pty，本地/WSL 走 `ctx.subprocess.spawnTerminal`，SSH 走
   ssh2 `shell`；Host 没有该 provider 时终端不可用，但文件工具不受影响。
6. **凭据**：密码存 0600 JSON，Windows 上 0600 是 no-op，依赖 profile 目录 ACL；接 Windows 凭据管理器
   需要额外的原生/CLI 依赖，暂不做。
7. **转发页面跨源**：拿不到 DSH 的 cookie/令牌；隧道跟随 SSH 连接生命周期，断线后需重新转发。
8. **Docker 未在真实运行时验证**：本机（含三个发行版）都没有 Docker daemon，只有脚本经 WSL 接缝的
   执行级验证。

---

## 14. 下一步

1. **装进 desktop profile 验证**（唯一未验证的层）：`dsh plugin --profile desktop add "file:D:\lgj\dsh_tool\dsh-remote-suite"`，
   在真实 GUI 里看添加工作区四个页签、文件树、编辑器、xterm、转发 iframe 是否正常（目前只有渲染与协议
   测试覆盖）。
2. **M5 剩余**：截图；WSL / Docker 的会话级错误恢复（目前只有 ssh2 连接级自动重连一次）；npm 发布流程
   （用户要求暂不上架，可先跳过）。
