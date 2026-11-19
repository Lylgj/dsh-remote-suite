//#region lib/index.js
/**
 * 终端面板插件 —— 宿主半边（node half）。
 *
 * 这个包是「双面包」(dual-face package)：宿主半边只负责把同源的终端后端挂到
 * DSH 的 webServer 上，浏览器半边通过 package.json 的 `dsh.client` 声明经
 * `exports["./client"]` 自动发现并投递到页面。
 *
 * 宿主半边提供三类路由（全部同源，无需额外进程或端口）：
 *   - GET /remote-suite/terminal/info          能力与默认值（供前端探测是否可用）
 *   - WS  /remote-suite/terminal/ws            PTY WebSocket 桥（node-pty <-> ws）
 *
 * 之所以把后端放进宿主而不是另外起一个服务，是因为 webServer 的路由与升级
 * 通道天然同源、随 dsh web 一起启停、并且可以由 ctx.effect 精确回收。
 */
import { spawn } from "node-pty";
import { WebSocketServer } from "ws";
import { readFileSync, statSync } from "node:fs";
import { spawn as spawnProcess, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { sshHostOfSpec, sshSelectionSpec, windowsPathToWsl, workspaceSshSpec, wslUncShellSpec } from "./terminal-workspace.js";

/** 路由前缀，集中一处便于修改。 */
const PREFIX = "/remote-suite/terminal";
/**
 * 资源路由前缀。注意 webServer 的 prefix 语义是「无尾斜杠」：匹配时会自行补
 * 一个 "/" 再比较（`pathname.startsWith(prefix + "/")`），带上尾斜杠反而永远
 * 匹配不上，会被 SPA 回退吞掉。
 */
const WS_PATH = `${PREFIX}/ws`;
const INFO_PATH = `${PREFIX}/info`;

/** 需要的宿主服务：webServer 提供路由与升级注册。 */
const inject = ["webServer"];

/** 资源根目录（本包内的 assets/）。 */
const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * 独立终端进程（lib/helper.js）的监听地址。
 *
 * 关键设计：终端的 PTY 与 WebSocket 跑在那个**独立进程**里，宿主只负责保证
 * 它在运行，不参与任何数据转发。原因是 dsh web 的单条事件循环会被逐 token
 * 流式解析、会话投影、zstd 压缩落盘与 GC 长时间占满（实测最坏 20 秒无响应），
 * 终端若排在同一条队列上，按键回显就会卡成几秒；隔离之后宿主再忙也不影响。
 * 浏览器半边默认直连该端口，连不上时回退到本文件提供的同源路由。
 */
const HELPER_HOST = process.env.DSH_TERMINAL_HOST ?? "127.0.0.1";
/** 独立终端进程端口，可用 DSH_TERMINAL_PORT 覆盖（前端同样以此为准）。 */
const HELPER_PORT = Number(process.env.DSH_TERMINAL_PORT ?? 3111);
/** 独立终端进程入口脚本。 */
const HELPER_SCRIPT = join(HERE, "terminal-helper.js");
/** 必须与 lib/helper.js 里的 VERSION 保持一致：不一致即视为过期实例并替换。 */
const HELPER_VERSION = "0.2.1";
/** 监管间隔：定期确认独立进程还在，崩了就重新拉起。 */
const HELPER_CHECK_MS = 10_000;

/** 独立终端进程的状态快照，供 /info 与前端诊断使用。 */
const helperState = { host: HELPER_HOST, port: HELPER_PORT, alive: false, version: null, pid: null };

/**
 * 当前存活的 PTY 会话集合。
 *
 * 每个工作区保留一个常驻 shell，因此这里可以同时存在多个会话；只有连接关闭、
 * 进程退出或插件卸载时才回收，切换工作区不会影响其它工作区的 shell。
 */
const sessions = new Set();
/** 每个环境（本机 / 各 WSL 发行版 / 各 SSH 主机）各自允许的 PTY 上限。 */
const MAX_SESSIONS_PER_ENV = 10;

/**
 * 从环境变量解析默认工作目录：优先 DSH_TERMINAL_CWD，其次宿主进程 cwd
 * （dsh web 的 cwd 即用户启动它的目录，通常就是项目根）。
 * @returns 绝对路径形式的默认工作目录。
 */
function defaultCwd() {
	return process.env.DSH_TERMINAL_CWD ?? process.cwd();
}

/**
 * 解析前端请求的工作目录（通常是当前会话的工作区）：必须是真实存在的目录，
 * 否则回退到默认目录，避免工作区被删除/移动后 PTY 直接启动失败。
 * @param requested - 前端通过 ?cwd= 传入的路径，可能为空或非法。
 * @returns 可直接交给 pty.spawn 的目录路径。
 */
function resolveCwd(requested) {
	if (typeof requested !== "string" || requested === "") return defaultCwd();
	try {
		return statSync(requested).isDirectory() ? requested : defaultCwd();
	} catch {
		return defaultCwd();
	}
}

/**
 * 解析终端使用的 shell 可执行文件。
 * @returns shell 的绝对路径或命令名。
 */
function defaultShell() {
	if (process.env.DSH_TERMINAL_SHELL) return process.env.DSH_TERMINAL_SHELL;
	if (process.platform === "win32") return process.env.ComSpec ?? "cmd.exe";
	return process.env.SHELL ?? "/bin/bash";
}

/**
 * 默认 shell 的启动参数：POSIX 登录 shell 用 `-l`，Windows 的 cmd.exe / pwsh 不接受它。
 * @returns 参数数组。
 */
function defaultShellArgs() {
	return process.platform === "win32" ? [] : ["-l"];
}

/**
 * 在 PATH 里找可执行文件。
 * @param names - 候选文件名（不带扩展名）。
 * @returns 绝对路径；找不到返回 null。
 */
function findExecutable(names) {
	const pathValue = process.env.PATH ?? "";
	const dirs = pathValue.split(process.platform === "win32" ? ";" : ":").filter((d) => d !== "");
	const exts = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
	for (const name of names) {
		for (const dir of dirs) {
			for (const ext of exts) {
				const full = join(dir, name + ext);
				try {
					if (statSync(full).isFile()) return full;
				} catch {
					/* 继续找下一个。 */
				}
			}
		}
	}
	return null;
}

/** Git for Windows 的 bash.exe 常常不在 PATH 里，按默认安装位置再找一遍。 */
const GIT_BASH_CANDIDATES = [
	join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe"),
	join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Git", "bin", "bash.exe"),
	join(process.env.LOCALAPPDATA ?? "C:\\Users", "Programs", "Git", "bin", "bash.exe")
];

/** Docker CLI 也可能不在 PATH 上，按 Docker Desktop 的默认安装位置再找一遍。 */
const DOCKER_CANDIDATES = [
	join(process.env.ProgramFiles ?? "C:\\Program Files", "Docker", "Docker", "resources", "bin", "docker.exe"),
	"/usr/local/bin/docker",
	"/usr/bin/docker"
];

/**
 * 本机可用的 bash：优先 PATH，其次 Git for Windows 的常见安装位置。
 * @returns bash 路径；找不到返回 null。
 */
function windowsBash() {
	if (process.platform !== "win32") return findExecutable(["bash"]);
	const found = findExecutable(["bash"]);
	if (found !== null) return found;
	for (const candidate of GIT_BASH_CANDIDATES) {
		try {
			if (statSync(candidate).isFile()) return candidate;
		} catch {
			/* 这个位置没有。 */
		}
	}
	return null;
}

/**
 * 找到 docker CLI：先看 DSH_DOCKER 覆盖，再按 Docker Desktop 的默认安装位置找，
 * 最后退回 PATH 搜索。
 * @returns docker 可执行文件路径；找不到返回 null。
 */
function dockerExecutable() {
	if (process.env.DSH_DOCKER) return process.env.DSH_DOCKER;
	if (process.platform === "win32") {
		// Docker Desktop 只把 CLI 的目录放进用户 PATH，而用户 PATH 未必继承到本进程，
		// 所以先按已知安装位置找，再退回 PATH 搜索。
		for (const candidate of DOCKER_CANDIDATES) {
			try {
				if (statSync(candidate).isFile()) return candidate;
			} catch {
				/* 这个位置没有。 */
			}
		}
	}
	return findExecutable(["docker"]);
}

/** 运行中容器列表缓存（`docker ps` 有成本，不能每次探测都调）。 */
let dockerCache = { at: 0, containers: [] };

/**
 * 列出正在运行的容器（docker ps --format '{{.Names}}'）。
 * @returns 容器名数组；没有 docker 或守护进程不可达时为空数组。
 */
function dockerContainers() {
	if (Date.now() - dockerCache.at < 30_000) return dockerCache.containers;
	const bin = dockerExecutable();
	if (bin === null) {
		dockerCache = { at: Date.now(), containers: [] };
		return dockerCache.containers;
	}
	const containers = [];
	try {
		const result = spawnSync(bin, ["ps", "--format", "{{.Names}}"], {
			encoding: "utf8",
			timeout: 4000,
			windowsHide: true
		});
		if (result.status === 0 && typeof result.stdout === "string") {
			for (const line of result.stdout.split(/\r?\n/)) {
				const name = line.trim();
				if (name !== "") containers.push(name);
			}
		}
	} catch {
		/* 没有 docker 或守护进程没起来。 */
	}
	dockerCache = { at: Date.now(), containers };
	return containers;
}

/**
 * 从工作区目录向上找 Docker 工作区标记（由 dsh-remote-suite 写入）。
 * 标记内容形如 { container: "ubuntu26", path: "/root" }。
 * 层数上限复用上面的 MAX_UP_LEVELS（与 .remote-ssh.json 保持一致）。
 * @param start - 工作区目录。
 * @returns { info, root } 或 null。
 */
function findDockerWorkspace(start) {
	let dir = start;
	for (let i = 0; i < MAX_UP_LEVELS; i += 1) {
		try {
			// 去掉可能存在的 UTF-8 BOM，否则 JSON.parse 会直接抛错（手工创建标记文件时很常见）。
			const text = readFileSync(join(dir, ".dsh-docker.json"), "utf8").replace(/^\uFEFF/, "");
			const info = JSON.parse(text);
			if (info !== null && typeof info === "object" && typeof info.container === "string" && info.container !== "") {
				return { info, root: dir };
			}
		} catch {
			/* 这一层没有标记，继续向上。 */
		}
		const up = dirname(dir);
		if (up === dir) break;
		dir = up;
	}
	return null;
}

/**
 * 由 Docker 工作区信息拼出 `docker exec -it` 启动参数。
 *
 * 用 `sh -lc` 起一层再 exec 到登录 shell，原因有两个：
 *   - 容器里不一定有 bash（busybox / alpine 只有 sh），所以先探测再选；
 *   - `-w` 在目录不存在时会直接报错退出，改成 shell 内 `cd ... || true`
 *     更宽容，容器重建后目录变了也不会让终端打不开。
 * @param container - 容器名。
 * @param workdir - 容器内起始目录，可空。
 * @returns { kind, command, args, container }。
 */
function dockerShellSpec(container, workdir) {
	const bin = dockerExecutable() ?? "docker";
	// 没指定目录就落到容器里的家目录（`docker exec` 默认是 /，对用户不友好）。
	const cd = typeof workdir === "string" && workdir !== "" ? `cd ${bashQuote(workdir)} 2>/dev/null || true; ` : `cd "$HOME" 2>/dev/null || true; `;
	const script = `${cd}if command -v bash >/dev/null 2>&1; then exec bash -l; else exec sh -l; fi`;
	return { kind: "docker", command: bin, args: ["exec", "-it", container, "sh", "-lc", script], container };
}

/** 单引号包裹一个 shell 词（POSIX）。 */
function bashQuote(value) {
	return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** WSL 发行版列表缓存（探测 wsl.exe 有成本）。 */
let wslCache = { at: 0, distros: [] };

/**
 * 列出本机 WSL 发行版（wsl.exe -l -q，输出是 UTF-16LE）。
 * @returns 发行版名字数组；没有 WSL 时为空数组。
 */
function wslDistros() {
	if (process.platform !== "win32") return [];
	if (Date.now() - wslCache.at < 30_000) return wslCache.distros;
	const distros = [];
	try {
		const result = spawnSync("wsl.exe", ["-l", "-q"], { encoding: "buffer", timeout: 4000, windowsHide: true });
		if (result.status === 0 && Buffer.isBuffer(result.stdout)) {
			// 正常是 UTF-16LE；个别版本/终端下可能是 UTF-8，用 NUL 判断。
			let text = result.stdout.toString("utf16le");
			if (text.includes("\u0000")) text = result.stdout.toString("utf8");
			for (const line of text.split(/\r?\n/)) {
				const name = line.replace(/\u0000/g, "").trim();
				if (name !== "") distros.push(name);
			}
		}
	} catch {
		/* 没有安装 WSL。 */
	}
	wslCache = { at: Date.now(), distros };
	return distros;
}

/**
 * 从 ~/.ssh/config 读取可交互的主机别名（忽略通配符条目）。
 * @returns 主机别名数组。
 */
function sshHosts() {
	const hosts = [];
	try {
		const text = readFileSync(join(homedir(), ".ssh", "config"), "utf8");
		for (const line of text.split(/\r?\n/)) {
			const match = /^\s*Host\s+(.+)$/i.exec(line);
			if (match === null) continue;
			for (const alias of match[1].trim().split(/\s+/)) {
				if (alias === "" || alias.includes("*") || alias.includes("?") || alias.startsWith("-")) continue;
				if (!hosts.includes(alias)) hosts.push(alias);
			}
		}
	} catch {
		/* 没有 ssh 配置。 */
	}
	return hosts;
}

/** 向上最多找几层 .dsh-docker.json（与 lib/helper.js 保持一致）。 */
const MAX_UP_LEVELS = 10;

/**
 * 按工作区目录推导默认 shell：Docker 工作区 → 容器内 shell；WSL 目录 → 该发行版 bash；
 * SSH 工作区（dsh-remote-ssh / dsh-remote-suite 标记）→ ssh；其余 → 本机默认 shell。
 * @param cwd - 工作区目录。
 * @returns { kind, command, args }。
 */
function defaultShellSpec(cwd) {
	// Docker 工作区（镜像目录里带 .dsh-docker.json）优先：它是显式标记，最具体。
	const docker = findDockerWorkspace(cwd);
	if (docker !== null) return dockerShellSpec(docker.info.container, docker.info.path);
	if (process.platform === "win32") {
		const wsl = wslUncShellSpec(cwd);
		if (wsl !== null) return wsl;
		const ssh = findExecutable(["ssh"]) ?? "ssh.exe";
		const remote = workspaceSshSpec(cwd, { ssh });
		if (remote !== null) return remote;
	}
	return { kind: "local", command: defaultShell(), args: defaultShellArgs() };
}

/**
 * 可用 shell 目录，供前端下拉选择。
 * @returns { id, label, kind } 数组。
 */
function shellCatalog() {
	const items = [];
	if (process.platform === "win32") {
		items.push({ id: "cmd", label: "Windows：cmd", kind: "local" });
		if (findExecutable(["powershell"]) !== null) items.push({ id: "powershell", label: "Windows：PowerShell", kind: "local" });
		if (findExecutable(["pwsh"]) !== null) items.push({ id: "pwsh", label: "Windows：pwsh", kind: "local" });
		for (const distro of wslDistros()) items.push({ id: `wsl:${distro}`, label: `WSL：${distro}`, kind: "wsl" });
	} else {
		const login = defaultShell();
		items.push({ id: "login", label: `登录 shell（${login}）`, kind: "local" });
		for (const name of ["bash", "zsh", "fish"]) {
			if (!login.endsWith(`/${name}`) && findExecutable([name]) !== null) {
				items.push({ id: name, label: name, kind: "local" });
			}
		}
	}
	// 运行中的容器和 WSL 发行版一样是「点一下就能进」的环境，并列放在下拉框里。
	for (const container of dockerContainers()) {
		items.push({ id: `docker:${container}`, label: `Docker：${container}`, kind: "docker" });
	}
	for (const alias of sshHosts()) items.push({ id: `ssh:${alias}`, label: `SSH：${alias}`, kind: "ssh" });
	return items;
}

/**
 * 把前端选中的 shell id 解析成启动参数；未知 id 回退到工作区默认 shell。
 * @param id - 前端 ?shell= 传入的 id。
 * @param cwd - 工作区目录。
 * @returns { kind, command, args }。
 */
function resolveShellSpec(id, cwd) {
	if (typeof id === "string" && id !== "") {
		// WSL 目录 / Docker 工作区 / remote-ssh 工作区里，本地 shell 进不去，
		// 统一交给工作区默认（容器内 shell / 远端 bash / ssh）。
		const auto = defaultShellSpec(cwd);
		if (id.startsWith("docker:")) {
			// 显式选中了某个容器：落在工作区标记记的目录（若是同一容器），否则容器默认目录。
			const container = id.slice(7);
			const marker = findDockerWorkspace(cwd);
			const workdir = marker !== null && marker.info.container === container ? marker.info.path : "";
			return dockerShellSpec(container, workdir);
		}
		if (id.startsWith("wsl:")) {
			const distro = id.slice(4);
			const linuxCwd = windowsPathToWsl(cwd);
			const args = ["-d", distro];
			if (linuxCwd !== "") args.push("--cd", linuxCwd);
			args.push("-e", "bash", "-l");
			return { kind: "wsl", command: "wsl.exe", args };
		}
		if (id.startsWith("ssh:")) {
			const ssh = process.platform === "win32" ? (findExecutable(["ssh"]) ?? "ssh.exe") : "ssh";
			return sshSelectionSpec(cwd, id.slice(4), { ssh });
		}
		if (auto.kind !== "local") return auto;
		if (id === "bash") {
			if (process.platform === "win32") {
				const bin = windowsBash();
				if (bin !== null) return { kind: "local", command: bin, args: ["-l"] };
				return auto;
			}
			const bin = findExecutable(["bash"]);
			if (bin !== null) return { kind: "local", command: bin, args: ["-l"] };
			return auto;
		}
		if (id === "cmd") return { kind: "local", command: process.env.ComSpec ?? "cmd.exe", args: [] };
		if (id === "powershell") {
			const bin = findExecutable(["powershell"]);
			if (bin !== null) return { kind: "local", command: bin, args: ["-NoLogo"] };
		}
		if (id === "pwsh") {
			const bin = findExecutable(["pwsh"]);
			if (bin !== null) return { kind: "local", command: bin, args: ["-NoLogo"] };
		}
		if (id === "login") return { kind: "local", command: defaultShell(), args: defaultShellArgs() };
		if (id === "zsh" || id === "fish") {
			const bin = findExecutable([id]);
			if (bin !== null) return { kind: "local", command: bin, args: ["-l"] };
		}
	}
	return defaultShellSpec(cwd);
}

/**
 * 由 shell 启动参数推导「环境」标识：本机 local、Docker 容器 docker:<容器>、
 * WSL 发行版 wsl:<发行版>、SSH 主机 ssh:<主机>。前端据此只展示同一环境里的
 * 后台终端，并按环境计数。
 * @param spec - resolveShellSpec / defaultShellSpec 的返回值。
 * @returns 环境 id。
 */
function specEnv(spec) {
	if (spec.kind === "docker") {
		// container 由 dockerShellSpec 直接挂在 spec 上，比从 args 里反推更稳。
		return `docker:${spec.container ?? "unknown"}`;
	}
	if (spec.kind === "wsl") {
		const at = spec.args.indexOf("-d");
		const distro = at >= 0 ? spec.args[at + 1] : "unknown";
		return `wsl:${distro}`;
	}
	if (spec.kind === "ssh") return `ssh:${sshHostOfSpec(spec)}`;
	return "local";
}

/**
 * 归一化传给 PTY 的环境变量。
 *
 * DSH 的 bash 工具会给它启动的 shell 注入 `PAGER=cat` / `GIT_PAGER=cat`
 * （避免 agent 的非交互命令卡在分页器里）。本进程如果恰好是从那种 shell
 * 启动的，这两个变量会一路继承到面板终端 —— 于是 `git log` 之类的输出被
 * 整段刷出来，完全不进分页器。真实终端应该分页，所以这里丢弃「cat 版 pager」，
 * 并给一组适合网页终端的 less 参数：
 *   F  一屏放得下就直接输出（短输出不打扰）
 *   R  保留颜色
 *   X  不用备用屏，退出后内容仍留在回滚缓冲里
 *   K  让 Ctrl+C 直接退出分页器（q 也照旧可用）
 * 想保留继承来的原值可设 DSH_TERMINAL_KEEP_PAGER=1。
 * @param base - 基础环境（通常是 process.env）。
 * @param extra - 额外覆盖的变量。
 * @returns 交给 node-pty 的环境对象。
 */
function ptyEnv(base, extra = {}) {
	const env = { ...base, ...extra };
	if (process.env.DSH_TERMINAL_KEEP_PAGER !== "1") {
		if (env.PAGER === "cat") delete env.PAGER;
		if (env.GIT_PAGER === "cat") delete env.GIT_PAGER;
		if (env.LESS === undefined || env.LESS === "") env.LESS = "FRXK";
	}
	return env;
}

/**
 * 探测独立终端进程是否存活。
 *
 * 超时刻意压到 1.2 秒：宿主事件循环可能正被模型输出占满，这里绝不能再等它，
 * 探测失败就当它不在，交给下面的拉起逻辑处理。
 * @returns 健康信息对象；不可达或响应异常时返回 null。
 */
async function helperStatus() {
	try {
		const res = await fetch(`http://${HELPER_HOST}:${HELPER_PORT}/healthz`, {
			signal: AbortSignal.timeout(1200),
		});
		if (!res.ok) return null;
		const body = await res.json();
		return typeof body?.version === "string" ? body : null;
	} catch {
		return null;
	}
}

/**
 * 让独立终端进程处于运行状态（版本不一致时先请旧实例退出）。
 *
 * 这一步只在插件加载与监管心跳时执行；它失败也不影响终端可用性，
 * 因为宿主半边仍然保留同源 PTY 路由作为回退。
 * @returns 无返回值；结果写入 helperState。
 */
async function ensureHelper() {
	// Windows 下 process.execPath 是 Electron 可执行文件：直接 spawn 会拉起第二个
	// GUI 实例，而裸 node 又解析不到 app.asar 里的 node-pty。这里不启独立进程，
	// 让前端走同源回退 —— 功能完整，只是失去按键回显隔离。
	// 需要时可用 DSH_TERMINAL_HELPER=1 强制打开（自行保证 node-pty/ws 可解析）。
	if (process.platform === "win32" && process.env.DSH_TERMINAL_HELPER !== "1") {
		helperState.alive = false;
		helperState.version = null;
		helperState.pid = null;
		return;
	}
	const status = await helperStatus();
	if (status !== null && status.version === HELPER_VERSION) {
		helperState.alive = true;
		helperState.version = status.version;
		helperState.pid = status.pid ?? null;
		return;
	}
	if (status !== null) {
		// 旧版本实例：请它退出，避免新旧协议混用导致前端拿到不认识的帧。
		try {
			await fetch(`http://${HELPER_HOST}:${HELPER_PORT}/shutdown`, { signal: AbortSignal.timeout(1200) });
		} catch {
			/* 它可能刚好自己退了。 */
		}
		await new Promise((resolve) => setTimeout(resolve, 300));
	}
	try {
		const child = spawnProcess(process.execPath, [HELPER_SCRIPT], {
			detached: true,
			stdio: "ignore",
			env: { ...process.env, DSH_TERMINAL_PORT: String(HELPER_PORT), ELECTRON_RUN_AS_NODE: "1" },
		});
		child.unref();
	} catch (error) {
		ctx.logger?.warn?.("remote-suite: 无法启动独立终端进程");
		ctx.logger?.warn?.(error);
		helperState.alive = false;
		return;
	}
	// 等它监听成功（最多 3 秒）；失败也保留同源回退路径。
	for (let i = 0; i < 15; i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 200));
		const probed = await helperStatus();
		if (probed !== null && probed.version === HELPER_VERSION) {
			helperState.alive = true;
			helperState.version = probed.version;
			helperState.pid = probed.pid ?? null;
			return;
		}
	}
	helperState.alive = false;
}

/**
 * 插件主体：注册静态资源路由、信息路由，以及 PTY 的 WebSocket 升级路由。
 * @param ctx - 宿主插件上下文（携带 webServer）。
 */
function apply(ctx) {
		ctx.effect(
		() =>
			ctx.webServer.register({
				kind: "exact",
				path: INFO_PATH,
				handler: (req, res) => {
					res.writeHead(200, {
						"content-type": "application/json; charset=utf-8",
						"cache-control": "no-cache",
					});
					const requestedCwd = resolveCwd(new URL(req.url ?? "/", "http://x").searchParams.get("cwd"));
					const defaultSpec = defaultShellSpec(requestedCwd);
					const catalog = shellCatalog();
					const detectedId =
						defaultSpec.kind === "docker"
							? `docker:${defaultSpec.container ?? ""}`
							: defaultSpec.kind === "wsl"
								? `wsl:${defaultSpec.args[1]}`
								: defaultSpec.kind === "ssh"
									? `ssh:${sshHostOfSpec(defaultSpec)}`
									: process.platform === "win32"
										? "cmd"
										: "login";
					const detectedShell = catalog.find((item) => item.id === detectedId) ?? {
						id: detectedId,
						label:
							defaultSpec.kind === "docker"
								? `Docker：${defaultSpec.container ?? "容器"}`
								: defaultSpec.kind === "ssh"
									? `SSH：${sshHostOfSpec(defaultSpec)}`
									: defaultSpec.command,
						kind: defaultSpec.kind,
					};
					res.end(
						JSON.stringify({
							shell: defaultSpec.command,
							// 工作区默认环境（local / wsl:<发行版> / ssh:<主机>），前端据此只展示同一环境的后台终端。
							env: specEnv(defaultSpec),
							// 可用 shell 目录：Windows 的 cmd / PowerShell / pwsh / WSL 发行版 / SSH 主机，
							// POSIX 的登录 shell / bash / zsh / fish / SSH 主机。
							shells: catalog,
							detectedShell,
							cwd: defaultCwd(),
							busy: sessions.size > 0,
							// 前端据此决定连哪个后端：优先独立进程，连不上再回退同源路由。
							helper: {
								host: helperState.host,
								port: helperState.port,
								alive: helperState.alive,
								version: helperState.version,
							},
						}),
					);
				},
			}),
		"remote-suite: info",
	);

	/** 每条 WS 连接对应一个 PTY；连接关闭时一并回收。 */
	const wss = new WebSocketServer({ noServer: true });

	ctx.effect(
		() =>
			ctx.webServer.registerUpgrade({
				path: WS_PATH,
				handler: (req, socket, head) => {
					wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
				},
			}),
		"remote-suite: pty websocket",
	);

	wss.on("connection", (ws, req) => {
		// 每个工作区一个常驻 PTY：这里刻意不顶掉既有连接，
		// 否则切换工作区会杀掉另一个工作区仍在运行的 shell。
		// 允许前端通过查询参数覆盖工作目录与尺寸。
		const url = new URL(req.url ?? "/", "http://x");
		const cols = Number(url.searchParams.get("cols") ?? 80) || 80;
		const rows = Number(url.searchParams.get("rows") ?? 24) || 24;
		const cwd = resolveCwd(url.searchParams.get("cwd"));
		// 工作区选中的 shell；空值表示按工作区目录自动选择（WSL 目录→该发行版 bash，remote-ssh→ssh，
		// 其余 Windows 用 cmd、POSIX 用登录 shell）。
		const spec = resolveShellSpec(url.searchParams.get("shell") ?? "", cwd);
		const env = specEnv(spec);
		// 每个环境单独限流：本机 10 个、每个 WSL 发行版 10 个、每台 SSH 主机 10 个。
		let sameEnv = 0;
		for (const item of sessions) if (item.env === env) sameEnv += 1;
		if (sameEnv >= MAX_SESSIONS_PER_ENV) {
			ws.send(JSON.stringify({ t: "e", d: `当前环境终端数量已达上限（${MAX_SESSIONS_PER_ENV} 个），请先关闭该环境中的部分终端。` }));
			ws.close();
			return;
		}
		// 只有本地 shell 用工作区目录当 cwd；WSL/SSH 的落点由它们自己的参数决定。
		const spawnCwd = spec.kind === "local" ? cwd : defaultCwd();

		let pty;
		try {
			pty = spawn(spec.command, spec.args, {
				name: "xterm-256color",
				cols,
				rows,
				cwd: spawnCwd,
				env: ptyEnv(process.env, { TERM: "xterm-256color", COLORTERM: "truecolor", DSH_TERMINAL: "1" }),
			});
		} catch (error) {
			ws.send(JSON.stringify({ t: "e", d: `无法启动 shell（${spec.command}）: ${String(error?.message ?? error)}` }));
			ws.close();
			return;
		}

		/** 本条连接对应的会话记录，供退出/关闭时精确回收。 */
		const session = { ws, pty, cwd, env };
		sessions.add(session);
		// 告知前端本会话所属环境（local / wsl:<发行版> / ssh:<主机>）：
		// 前端据此只展示同一环境里的「后台终端」并按环境计数。
		ws.send(JSON.stringify({ t: "s", env, kind: spec.kind }));

		// PTY -> 浏览器：原始文本直通。
		pty.onData((data) => {
			if (ws.readyState === ws.OPEN) ws.send(data);
		});
		pty.onExit(({ exitCode }) => {
			sessions.delete(session);
			if (ws.readyState === ws.OPEN) {
				ws.send(`\r\n\x1b[2m[进程已退出，退出码 ${exitCode}]\x1b[0m\r\n`);
				ws.close();
			}
		});

		// 浏览器 -> PTY：JSON 控制帧 {t:'i'} 输入 / {t:'r'} 尺寸。
		ws.on("message", (raw) => {
			let msg;
			try {
				msg = JSON.parse(String(raw));
			} catch {
				return;
			}
			if (msg.t === "i") pty.write(msg.d);
			else if (msg.t === "r") {
				const c = Math.max(2, Number(msg.c) || 80);
				const r = Math.max(1, Number(msg.r) || 24);
				try {
					pty.resize(c, r);
				} catch {
					/* 尺寸竞争时 pty 可能已退出，忽略。 */
				}
			}
		});

		ws.on("close", () => {
			sessions.delete(session);
			try {
				pty.kill();
			} catch {
				/* 已经退出。 */
			}
		});
	});

	ctx.effect(
		() => () => {
			for (const s of sessions) {
				try {
					s.pty.kill();
				} catch {
					/* 已经退出。 */
				}
			}
			sessions.clear();
			wss.close();
		},
		"remote-suite: close pty server",
	);

	/**
	 * 保证独立终端进程在跑。刻意不阻塞插件加载：探测与拉起都在后台进行，
	 * 失败也不会让终端失联——前端会自动回退到上面的同源 PTY 路由。
	 *
	 * 注意：插件卸载时**不**杀掉独立进程。它是终端会话的宿主，dsh 重启后
	 * 已有终端可以继续存活；版本升级靠 /healthz 的版本比对来替换实例。
	 */
	void ensureHelper();
	const supervisor = setInterval(() => void ensureHelper(), HELPER_CHECK_MS);
	supervisor.unref?.();
	ctx.effect(() => () => clearInterval(supervisor), "remote-suite: helper supervisor");
}
//#endregion
export { apply, inject };
