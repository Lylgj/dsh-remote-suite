# dsh-ssh-remote

**给 DeepSeek Harness（dsh）加上 ZCode 风格的远程工作区：SSH、WSL、Docker。**

[简体中文](README.md) · [English](README.en.md)

远程机器上跑一个常驻的 dsh，本机只负责选目录、聊天、看状态。关掉本地 dsh，远程 agent 和正在生成的回答都继续跑。

> 适用版本：DeepSeek Harness Desktop `0.2.1-rc.5`（已在 AlmaLinux 9.5 的 SSH 主机上端到端验证）

---

## 效果演示

截图来自真实运行的 dsh 和真实 SSH 主机，设备名与 IP 已替换为文档保留地址。

### 远程设备管理

![远程设备管理](docs/demo-devices.png)

一台设备一行：状态云朵、`root@host:22`、最近在线时间、项目数。搜索框可按设备名、地址或项目过滤。

### 设备菜单

![设备行菜单](docs/demo-device-menu.png)

编辑、断开、重装 / 重启 / 停止远端服务、移除设备。断开只断本机连接，远程任务照常运行。

### 新建连接

![新建连接](docs/demo-new-connection.png)

SSH / WSL / Docker 三类统一入口，支持从 `~/.ssh/config` 导入。macOS 上不出现任何 WSL 入口。

### 创建项目

![创建项目](docs/demo-create-project.png)

项目名 + 设备 + 文件夹。设备下拉第一项是「此电脑」，后面是已保存的远程设备，也能直接添加新设备。

### 选择远程文件夹

![远程文件夹浏览器](docs/demo-folder-picker.png)

远程没有本地路径可浏览，所以用内嵌的 SFTP 文件夹浏览器：输入路径、显示隐藏目录、逐级进入。

### 原生侧栏里的远程工作区

![远程工作区行](docs/demo-workspace-row.png)

远程工作区直接出现在 dsh 原生侧栏：云朵（在线 / 启动中 / 离线 / 异常）+ 项目名 + 设备名。

![远程工作区行菜单](docs/demo-workspace-menu.png)

`...` 菜单可新建任务、查看文件、编辑项目、置顶、删除项目。删除只清本机投影和远端服务，**远程项目文件夹保留**。

### 流式会话

![流式远程会话](docs/demo-streaming.png)

回答在远端生成、本地逐字出现，和本地会话一样顺滑。agent 进程、工具调用和文件读写都发生在远程主机上。

---

## 能做什么

| | |
|---|---|
| 目标 | SSH（密码 / 私钥 / agent）、Windows 上的 WSL 发行版、Docker 容器 |
| 添加设备 | 与 ZCode 一致的新建连接向导，支持从 SSH config 导入 |
| 创建项目 | 主界面一个表单：项目名、设备、文件夹；本机弹系统对话框，远程用内嵌浏览器 |
| 原生集成 | 远程工作区投影到原生侧栏，云朵 + 项目名 + 设备名，行内菜单编辑 / 删除 |
| 会话 | 远端流式返回，支持思考、工具调用、取消；关闭本地不中断 |
| 状态 | 运行中 / 启动中 / 已停止 / 异常 / 不可达，以及 PID、运行时长、内存、CPU、HTTP 状态 |
| 部署 | 自动安装 Node 与 dsh、同步模型凭证、注册 systemd（或 setsid）服务 |
| 平台 | macOS 上不提供 WSL，与 ZCode 一致 |

---

## 安装

在 DeepSeek Harness 至少启动过一次之后：

```bash
# macOS / Linux / WSL
node <插件目录>/bin/install.mjs --profile desktop
```

```powershell
# Windows
node <插件目录>\bin\install.mjs --profile desktop
```

然后完全退出并重新启动 DeepSeek Harness，侧边栏出现「SSH 远程」即安装成功。

卸载：`node <插件目录>\bin\uninstall.mjs --profile desktop`。只移除本地插件，远程服务需在界面上删除项目。

---

## 使用

1. **添加设备**：设置 → 远程设备 → 新建连接，填地址和账号后测试并保存。
2. **创建项目**：主界面「创建项目」→ 选设备 → 选文件夹 → 确认信任并创建。首次会在远端安装 dsh，之后复用。
3. **开始对话**：点侧栏里的远程工作区直接聊天，回答在远端流式生成。
4. **管理**：悬停远程行，`...` 里可编辑名称或删除项目；删除保留远程目录。

左侧「SSH 远程」面板只管理设备，工作区统一在主界面创建。

---

## 数据与安全

- 设备与设置保存在本机 `$DSH_HOME/ssh-remote/state.json`（POSIX 上为 0600；Windows 依赖用户配置目录的 ACL），不写入远程；
- SSH 密码与私钥口令优先存进系统凭据库：Windows 凭据管理器、macOS 钥匙串、Linux libsecret（`secret-tool`）。`state.json` 只留下 `auth.secretBackend` 标记，密码不落盘；凭据跟随系统账户，换一台电脑需要重新输入密码。系统没有可用凭据库时退回 0600 文件，`GET /ssh-remote/health` 的 `secrets` 检查会给出告警；
- 远程 dsh 只监听 `127.0.0.1`，不向局域网暴露端口；
- 首次连接记录主机指纹，之后指纹变化会拒绝连接；
- 可选把本机模型凭证以 0600 同步到远程工作区。

---

## 限制

- 远程目标需要 Linux 环境，Node ≥ 22 或能下载便携运行时，且能访问 npm 镜像；
- 每个会话首轮要付一次约 3 秒的远端进程启动，之后追问即时；
- 本地不镜像远程文件，agent 与工具都在目标环境执行；
- WSL 需要 Windows + 已安装 WSL；Docker 需要运行中的容器；不支持 Windows 远程主机。

## License

MIT

## 社区

本开源项目已链接并认可 [LINUX DO](https://linux.do/) 社区。

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
