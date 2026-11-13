# dsh-remote-suite

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件，统一管理远程工作区：
WSL 发行版、SSH 主机、Docker 容器和远端常驻会话，全部收敛到同一个 `Backend` 接缝、同一把
`remote` 工具和一个侧栏入口。

**当前状态：M0 + M1a + M2a + M2b + M3a + M3b + M4a + M4b（常驻会话）+ M4c（端口转发）+ 镜像同步均已完成。**
本机、WSL、SSH、Docker、daemon 五类目标都能用（执行命令、文件读/写/编辑/stat/list、grep 与 glob、
保存工作区、目录镜像）；浏览器半自带工作区视图：目标切换、文件树、编辑器页签、命令控制台、
基于 Host PTY 的真终端页签（xterm），以及把远端页面内嵌进来的 web 页签。SSH 支持密钥 / agent /
密码认证与多跳 `ProxyJump`；Docker 容器通过 `docker` CLI 访问；`daemon:<别名>` 让每台主机保持一个
shell 会话，于是 `cd` 与 `export` 能跨命令保留——把远端 `dsh web` 跑起来再嵌进本地，靠的正是它。

## 为什么做这个插件

这台机器上原本有三个插件覆盖同一片空间，而且互相重叠：其中两个各自把 WSL 实现了一遍
（`dsh-wsl-workspace` 把整个会话切进发行版，`dsh-wsl-tool` 暴露按操作拆分的工具加一个 PTY），
SSH 那个则重写了侧栏的文件路由和终端 shell，因此无法与它们共存。本插件用一份可互换后端的注册表
把这三个一起替代掉。

## 安装（本地开发）

```powershell
dsh plugin --profile desktop add "file:D:\lgj\dsh_tool\dsh-remote-suite"
```

然后完全重启 DeepSeek Harness。侧栏会多出「远程」入口，每个 agent preset 都会获得 `remote` 工具。

为避免旧插件注册同名工具，先卸载它们：

```powershell
dsh plugin --profile desktop remove dsh-wsl-tool
dsh plugin --profile desktop remove dsh-wsl-workspace
dsh plugin --profile desktop remove @zhangfengshun/dsh-remote-ssh
```

## 添加工作区

插件接管 Host 自带的「添加工作区」流程（工作区列表旁的 `＋`），注册进
`sidebar.workspaces.directoryFlow` 与 `conversation.hero.workspace.directoryFlow` 两个 slot，
`priority: -100`，做法与 `dsh-remote-ssh` 一致。没有额外的 rail 入口，也没有额外的 `＋`。

对话框提供四类工作区：

- **本机 / Local** —— 本机上的目录；Host 按普通工作区创建。
- **WSL** —— 自动列出已安装发行版（`wsl.exe -l -q`）；工作区打开在该目录的真实 UNC 路径
  （`\\wsl.localhost\<发行版>\<路径>`）上，因此 DSH 自带的文件树与终端都能直接用。
- **Docker** —— 自动列出运行中的容器（`docker ps`）；工作区打开在本地镜像目录上，
  `remote` 工具以 `docker:<容器名>` 寻址该容器。
- **远程 SSH / Remote SSH** —— 主机来自 `~/.ssh/config` 以及在此新增的条目（别名、主机、用户、
  端口、密钥文件、可选密码，存入 `secrets.json`）；同样是镜像目录那一套，`remote` 工具以
  `ssh:<别名>` 或 `daemon:<别名>` 寻址。别名可用中文（只要不含空格、冒号、斜杠），它只是本插件
  内部的标识，不会写回 `~/.ssh/config`。在下拉里选中一台主机后点「删除」即可移除：对话框里新增的
  主机连同存储的密码一起删掉；`~/.ssh/config` 里的主机只从列表里隐藏（那是用户自己的文件，插件
  不会改写它），从 `state.json` 的 `hiddenProfiles` 里去掉该别名即可恢复。

把路径交回 Host 之前，浏览器半会先调用 `prepare-path`：校验目标目录存在，并返回 DSH 应当打开的路径
（路径本身、WSL UNC 路径，或刚创建好的镜像目录）。

## 工作区视图（可选）

`client.js` 仍然自带一个独立的「远程」面板——目标切换、文件树、编辑器、走 `/remote-suite/pty` 的
xterm 终端，以及端口转发出来的 web 页签——但它默认不再注册：插件对外可见的入口就是上面的添加工作区
流程。想恢复它，只需在 `apply()` 里加两行（`sidebar.panellist` + `main`）。

## `remote` 工具

| action | 含义 |
|---|---|
| `targets` | 列出目标 id（`local`、`wsl:<发行版>`、`ssh:<别名>`、`daemon:<别名>`、`docker:<容器>`） |
| `workspaces` / `workspace-add` / `workspace-remove` | 已保存的 `(目标, 目录)` 对；之后用 `workspace` 代替 `target` |
| `probe` | 目标到底是什么（系统、平台、node、cwd） |
| `exec` | 在目标内执行 shell 命令 |
| `read` / `write` / `edit` | 读文件 / 整体写入 / 原地替换（除非 `replaceAll`，否则要求唯一匹配） |
| `stat` / `list` | 查看路径信息、列出目录 |
| `grep` / `glob` | 搜索文件内容（可带 `glob` 过滤）/ 按模式查找文件 |
| `secret-set` / `secret-remove` | 为目标保存 / 忘记 SSH 密码（0600 文件，不进 `state.json`） |
| `mirrors` / `mirror-add` / `mirror-remove` | 管理远端目录的本地镜像 |
| `mirror-sync` | `direction=pull` 或 `push` 同步镜像（`force`、`dryRun`） |

## SSH 目标

`~/.ssh/config` 中每个非通配 `Host`（可用 `DSH_SSH_CONFIG` 指定别的文件）都会成为一个
`ssh:<别名>` 目标；`HostName`、`User`、`Port` 与多个 `IdentityFile` 都会生效，`ProxyJump`
支持任意跳数（别名或 `user@host:port`，逗号分隔）。

认证按顺序尝试：`DSH_SSH_IDENTITY`（仓库内 / CI 覆盖，`;` 分隔多个路径）→ profile 的
`IdentityFile` → `~/.ssh/id_ed25519`、`id_rsa`、`id_ecdsa` → `ssh-agent`（`SSH_AUTH_SOCK`，
Windows 上是 OpenSSH agent 管道）→ 已保存的密码（CI 用 `DSH_SSH_PASSWORD`，或下面的
`secret-set`，它走 `keyboard-interactive` / `password` 并设置 `tryKeyboard`）。

密码保存在 `$DSH_HOME/remote-suite/secrets.json`（可用 `DSH_REMOTE_SUITE_SECRETS` 覆盖），
权限 0600，独立于 `state.json`，且从不回显：

```powershell
remote action=secret-set target=ssh:box password=…     # 也可以让 agent 询问
remote action=secret-remove target=ssh:box
```

查找按 `user@host`（与端口无关），所以换了端口的主机仍能取回密码；换了用户则是另一个账户，取不到。

```powershell
$env:DSH_SSH_IDENTITY = "$HOME\.ssh\dsh_remote_ed25519"
$env:DSH_SSH_TEST_REQUIRED = "1"
node test/ssh-smoke.mjs
node test/ssh-jump-smoke.mjs   # 经同一主机做 ProxyJump，临时配置
```

## Docker 目标

运行中的容器会成为 `docker:<容器名>` 目标，通过 `docker ps --format '{{.Names}}…'` 发现。
后端假定容器是带 POSIX shell 的 Linux，并且只通过 `docker exec -i <容器> sh -lc <脚本>` 与它对话
——CLI 就是契约，所以 Docker Desktop、`DOCKER_HOST`、rootless 方案都无需额外代码即可工作。
引擎二进制可用 `DSH_DOCKER` 改成 `podman`、`nerdctl` 等。

命令、文件读写、stat/list、grep 与 glob 全部在容器内执行，不需要 daemon 或 API 客户端。
终端通过 Host PTY 打开 `docker exec -it <容器> sh`。

## 常驻会话（daemon）

每个 SSH 配置同时以 `daemon:<别名>` 出现（标签为 `…（会话）`）。主机相同、连接相同，但所有 `exec`
共用一条非交互 `bash` 通道，于是 `cd`、`export` 与 shell 函数能跨调用保留——相当于一把"一直开着"
的终端。文件工具仍走同一条连接上的 SFTP。

调用了 `exit` 的命令会终结这个 shell；这会被如实报告（`the session ended while running this
command`），下一次调用会静默地重开一个新会话。除此之外目标没有任何变化。

## 通过隧道内嵌远端 UI

`daemon:` 会话足以跑起一整套远端界面并嵌到本地：

```powershell
remote action=exec target=daemon:box command="cd ~/app && nohup dsh web --port 8080 >/tmp/dsh.log 2>&1 &"
```

然后在「远程」视图的端口框里填 `8080`、点「转发」。插件在桌面侧开一个 loopback 监听，把每个连接
经 SSH 客户端隧道过去（`forwardOut` → `socket.pipe(stream).pipe(socket)`），工作区再开一个 iframe
页签指向它。关闭页签即关闭隧道；重启面板会丢弃所有转发。远端只需要那个服务本身——不需额外端口、
不需 `ssh -L`、不需代理。

## 镜像同步

镜像是远端目录的可选本地副本（方便在桌面侧用编辑器、搜索和 `git`）：

```powershell
remote action=mirror-add target=wsl:Ubuntu path=/srv/app name=app
remote action=mirror-sync mirror=mir-app direction=pull
remote action=mirror-sync mirror=mir-app direction=push
```

镜像默认放在 `$DSH_HOME/remote-suite/mirrors/<id>`（可用 `local=` 覆盖）。文件以 32 KB 的
`dd … | base64` 分块走目标自身的 `exec` 传输，因此远端不需要 `tar`/`rsync`，也不需要额外端口，
二进制内容完好无损。pull 从不删除本地文件；push 在远端副本比本地新超过两秒时跳过该文件
（为网络文件系统留 2 秒 mtime 余量）并报告冲突，除非 `force=true`。`dryRun=true` 只报告计划、不落盘。

## 测试

```powershell
npm test                      # Host 冒烟 + API + 客户端渲染 + PTY 桥 + Docker 接缝 + 凭据 + 镜像
node test/ssh-smoke.mjs       # 真实主机，需要 ~/.ssh/config 与密钥
node test/ssh-jump-smoke.mjs  # 真实 ProxyJump 链，需要 DSH_SSH_IDENTITY
node test/daemon-smoke.mjs    # 针对真实主机的常驻会话
node test/tunnel-smoke.mjs    # 转发真实远端 HTTP 服务（需要主机上有 python3）
node test/docker-smoke.mjs    # 只测 docker 接缝，需要 WSL 发行版，不需要 Docker
```

`npm test` 用 stub `ctx` 挂载 Host 插件（工具 + 路由 + PTY upgrade），跑本地后端和每个已安装的
WSL 发行版，再跑浏览器半调用的 API 方法，用 `react-dom/server` 渲染两个客户端 seat，通过真实
socket 对 fake backend 驱动 PTY WebSocket 协议，把 Docker 后端的脚本经 WSL 接缝跑一遍，最后检查
凭据与镜像记账。

**为什么脚本从不以 argv 形式进入 `wsl.exe`：** `--` 之后的一切会被当成一整条命令行重新求值，
所以作为参数传入的脚本里的 `$name` 会在 bash 启动之前就被展开（通常展开成空）。WSL 后端把每个脚本
暂存到发行版的 `/tmp` 再按路径执行；`test/smoke.mjs` 保留了针对 `$vars` 与 `$(…)` 的回归断言。

## 兼容性

| 组件 | 要求 |
|---|---|
| DeepSeek Harness | Host API `>= 0.2.1-rc.2`（在 `0.2.2-rc.1` 上开发）；只要求 `ctx.tools.register`、`ctx.inject(['webServer'])`、`webServer.register` / `registerUpgrade`，`ctx.get('subprocess').spawnTerminal` 是可选的（缺失时终端降级为控制台页签） |
| Node（Host 进程） | `>= 20` |
| Windows 10/11 | 本机 PowerShell 目标、WSL2 目标、SSH 目标、经 `docker` CLI 的 Docker 目标、隧道 |
| macOS / Linux | 本机 `$SHELL` 目标、SSH / Docker 目标；WSL 后端仅 Windows |
| 搜索 | 目标上有 `rg` 时 `grep`/`glob` 更快；没有则回退到 `grep -rnIE` / `find` |

`npm pack` 产出单个 tarball（27 个文件，约 175 kB），包含 host 半、浏览器半、随包附带 xterm 资源与
patch；测试与 `docs/` 不随包发布。

## 故障排查

- **装好后侧栏没有「远程」入口**：profile 在启动时读取 `cordis.patch.yml` —— 请完全重启 DeepSeek
  Harness，然后检查 profile 里的插件条目。
- **`tool "wsl" is already registered`**：旧的 WSL 插件还装着，按[安装](#安装本地开发)一节卸掉再重启。
- **没有 WSL 目标**：`wsl -l -q` 必须能列出该发行版；插件运行期间被移除的发行版会在下一次 10 秒
  刷新时消失。
- **没有 Docker 目标**：`docker ps` 必须能应答（Docker Desktop 在跑、`DOCKER_HOST` 已设，
  或 `DSH_DOCKER` 指向 `podman` / `nerdctl`）。
- **终端页签一片空白**：Host 没有 `spawnTerminal` provider，或 `assets/xterm.js` 没有随包发布；
  该页签会退回命令控制台，文件功能不受影响。
- **SSH: all authentication methods failed**：依次检查密钥（`IdentityFile` / `DSH_SSH_IDENTITY`）、
  ssh-agent、`secret-set` 密码；`remote action=probe` 可确认解析到的是哪个别名。
- **转发后 web 页签空白**：远端服务必须监听该主机的 `127.0.0.1`/`0.0.0.0`，且 `https` 页面不能内嵌
  `http` iframe —— 可先转发，再直接打开 loopback 地址。

## 许可证

MIT
