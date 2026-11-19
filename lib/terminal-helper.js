//#region lib/helper.js
/**
 * 终端面板插件 —— 独立终端服务进程。
 *
 * 为什么需要它：`dsh web` 只有一条事件循环。逐 token 的流式解析、会话投影
 * 更新、zstd 压缩落盘与随之而来的 GC 都排在它上面；如果终端的 PTY 按键回显
 * 也排在同一条队列里，模型长时间输出时按键就会几百毫秒甚至几十秒没有回显
 * （实测：空闲 0.7 ms，重载时 p95 2469 ms、最坏 4967 ms 无回显）。
 *
 * 所以把 PTY + WebSocket 挪进这个独立进程：终端与 dsh 主进程彻底解耦，
 * 宿主再忙也不影响按键回显。浏览器半边直连本进程端口；本进程不可达时，
 * 前端会自动回退到宿主半边提供的同源路由（见 lib/index.js），保证不会失联。
 *
 * 对外契约（与宿主半边保持一致）：
 *   GET  /healthz                     存活与版本探测（宿主据此决定是否复用/替换）
 *   GET  /info                        能力与默认值
 *   GET  /shutdown                    请求退出（仅监听本机；宿主替换旧版本实例时使用）
 *   WS   /ws?cols=&rows=&cwd=         PTY 桥
 *     浏览器 → 本进程：{t:'i', d} 输入  |  {t:'r', c, r} 尺寸
 *     本进程 → 浏览器：纯文本（PTY 原始输出），或 {t:'e', d} 错误提示
 */
import { spawn } from "node-pty";
import { WebSocketServer } from "ws";
import { createServer } from "node:http";
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { sshSelectionSpec, windowsPathToWsl, workspaceSshSpec, wslUncShellSpec } from "./terminal-workspace.js";

/** 协议版本：宿主半边用它判断常驻实例是否过期，过期则替换。 */
export const VERSION = "0.2.1";

const PORT = Number(process.env.DSH_TERMINAL_PORT ?? 3111);
const HOST = process.env.DSH_TERMINAL_HOST ?? "127.0.0.1";
/** 同时存活的 PTY 上限，防止异常情况下无限堆积。 */
const MAX_SESSIONS = 12;
/**
 * PTY 输出合批窗口。终端里 `ls -l` 这类命令会瞬间产出几十上百个 chunk，
 * 逐个发 WS 帧会让前端逐帧重排；合并成少数几帧后渲染压力显著下降。
 *
 * 注意：只有在「刚刚才冲刷过」的爆发期才等这个窗口。孤立的一个 chunk
 * （典型场景就是按键回显）会立刻冲刷，避免给打字加上固定延迟。
 */
const FLUSH_MS = 8;
/** 距上次冲刷超过这个时间就认为爆发已经结束，下个 chunk 直接发。 */
const IDLE_GAP_MS = 4;
/** 单条 WS 帧的软上限：超过就直接冲刷，避免大输出被延迟。 */
const FLUSH_BYTES = 256 * 1024;

/** 当前存活的 PTY 会话集合。 */
const sessions = new Set();

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
 * 解析默认工作目录：优先 DSH_TERMINAL_CWD，其次本进程 cwd。
 * @returns 绝对路径形式的默认工作目录。
 */
function defaultCwd() {
	return process.env.DSH_TERMINAL_CWD ?? process.cwd();
}

/**
 * 解析前端请求的工作目录：必须是真实存在的目录，否则回退默认值，
 * 避免工作区被删除/移动后 PTY 直接启动失败。
 * @param requested - 前端通过 ?cwd= 传入的路径。
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

/** 向上最多找几层 .dsh-docker.json（与 lib/index.js 保持一致）。 */
const MAX_UP_LEVELS = 10;

/** Docker CLI 的常见安装位置（Windows 只看 Docker Desktop 的默认路径）。 */
const DOCKER_CANDIDATES = [
	join(process.env.ProgramFiles ?? "C:\\Program Files", "Docker", "Docker", "resources", "bin", "docker.exe"),
	"/usr/local/bin/docker",
	"/usr/bin/docker",
];

/**
 * 找到 docker CLI：先看 DSH_DOCKER 覆盖，再按常见安装位置找，最后退回命令名。
 * @returns docker 可执行文件路径或命令名。
 */
function dockerExecutable() {
	if (process.env.DSH_DOCKER) return process.env.DSH_DOCKER;
	for (const candidate of DOCKER_CANDIDATES) {
		try {
			if (statSync(candidate).isFile()) return candidate;
		} catch {
			/* 这个位置没有。 */
		}
	}
	return "docker";
}

/**
 * 从工作区目录向上找 Docker 工作区标记（由 dsh-remote-suite 写入）。
 * @param start - 工作区目录。
 * @returns { container, path } 或 null。
 */
function findDockerWorkspace(start) {
	let dir = start;
	for (let i = 0; i < MAX_UP_LEVELS; i += 1) {
		try {
			// 去掉可能存在的 UTF-8 BOM，否则 JSON.parse 会直接抛错。
			const text = readFileSync(join(dir, ".dsh-docker.json"), "utf8").replace(/^\uFEFF/, "");
			const info = JSON.parse(text);
			if (info !== null && typeof info === "object" && typeof info.container === "string" && info.container !== "") {
				return { container: info.container, path: typeof info.path === "string" ? info.path : "" };
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

/** 单引号包裹一个 shell 词（POSIX）。 */
function bashQuote(value) {
	return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * 解析要启动的 shell：Docker 工作区（或显式选了 docker:<容器>）进容器；
 * 远程工作区（dsh-remote-ssh / dsh-remote-suite 标记）与 WSL UNC 目录交给对应客户端；
 * 显式选了 ssh:<别名> / wsl:<发行版> 时按选择启动；其余沿用本机默认 shell。
 * 与 lib/index.js 的 defaultShellSpec 保持一致。
 * @param cwd - 工作区目录。
 * @param shellId - 前端显式选择的 shell id（可空）。
 * @returns { command, args }。
 */
function resolveShell(cwd, shellId) {
	const marker = findDockerWorkspace(cwd);
	let container = "";
	let workdir = "";
	if (typeof shellId === "string" && shellId.startsWith("docker:")) {
		container = shellId.slice("docker:".length);
		if (marker !== null && marker.container === container) workdir = marker.path;
	} else if (marker !== null) {
		container = marker.container;
		workdir = marker.path;
	}
	if (container !== "") {
		const cd = workdir !== "" ? `cd ${bashQuote(workdir)} 2>/dev/null || true; ` : `cd "$HOME" 2>/dev/null || true; `;
		const script = `${cd}if command -v bash >/dev/null 2>&1; then exec bash -l; else exec sh -l; fi`;
		return { command: dockerExecutable(), args: ["exec", "-it", container, "sh", "-lc", script] };
	}
	// 显式选了远程环境（下拉里的 ssh:<别名> / wsl:<发行版>）就交给对应客户端。
	if (typeof shellId === "string" && shellId.startsWith("ssh:")) {
		const ssh = process.platform === "win32" ? "ssh.exe" : "ssh";
		return sshSelectionSpec(cwd, shellId.slice(4), { ssh });
	}
	if (typeof shellId === "string" && shellId.startsWith("wsl:")) {
		const linuxCwd = windowsPathToWsl(cwd);
		const args = ["-d", shellId.slice(4)];
		if (linuxCwd !== "") args.push("--cd", linuxCwd);
		args.push("-e", "bash", "-l");
		return { command: "wsl.exe", args };
	}
	// 远程工作区（dsh-remote-ssh / dsh-remote-suite 标记）与 WSL UNC 目录：本地 shell 进不去。
	const wsl = wslUncShellSpec(cwd);
	if (wsl !== null) return wsl;
	const remote = workspaceSshSpec(cwd, { ssh: process.platform === "win32" ? "ssh.exe" : "ssh" });
	if (remote !== null) return remote;
	return { command: defaultShell(), args: defaultShellArgs() };
}

/**
 * 把会话缓冲里的 PTY 输出合并成一条 WS 帧发出去。
 * @param session - 会话记录（含 ws 与缓冲）。
 * @returns 无返回值。
 */
function flush(session) {
	if (session.timer !== null) {
		clearTimeout(session.timer);
		session.timer = null;
	}
	if (session.buffer.length === 0) return;
	const text = session.buffer.join("");
	session.buffer.length = 0;
	session.lastFlushAt = performance.now();
	if (session.ws.readyState === session.ws.OPEN) session.ws.send(text);
}

const info = () => ({
	ok: true,
	version: VERSION,
	pid: process.pid,
	port: PORT,
	shell: defaultShell(),
	cwd: defaultCwd(),
	sessions: sessions.size,
});

const server = createServer((req, res) => {
	const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
	if (pathname === "/healthz" || pathname === "/info") {
		res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-cache" });
		res.end(JSON.stringify(info()));
		return;
	}
	if (pathname === "/shutdown") {
		res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
		res.end(JSON.stringify({ ok: true, stopping: true }));
		// 先让响应发出去，再回收 PTY 并退出。
		setTimeout(() => shutdown(), 30);
		return;
	}
	res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
	res.end(JSON.stringify({ ok: false, error: "not found" }));
});

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
	const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
	if (pathname !== "/ws") {
		socket.destroy();
		return;
	}
	wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

wss.on("connection", (ws, req) => {
	if (sessions.size >= MAX_SESSIONS) {
		ws.send(JSON.stringify({ t: "e", d: `终端数量已达上限（${MAX_SESSIONS}），请先关闭部分工作区的终端。` }));
		ws.close();
		return;
	}

	const url = new URL(req.url ?? "/", "http://localhost");
	const cols = Number(url.searchParams.get("cols") ?? 80) || 80;
	const rows = Number(url.searchParams.get("rows") ?? 24) || 24;
	const cwd = resolveCwd(url.searchParams.get("cwd"));
	const shellSpec = resolveShell(cwd, url.searchParams.get("shell"));

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

	let pty;
	try {
		pty = spawn(shellSpec.command, shellSpec.args, {
			name: "xterm-256color",
			cols,
			rows,
			cwd,
			env: ptyEnv(process.env, { TERM: "xterm-256color", COLORTERM: "truecolor", DSH_TERMINAL: "1" }),
		});
	} catch (error) {
		ws.send(JSON.stringify({ t: "e", d: `无法启动 shell: ${String(error?.message ?? error)}` }));
		ws.close();
		return;
	}

	/** 本条连接对应的会话记录，供退出/关闭时精确回收。 */
	const session = { ws, pty, cwd, buffer: [], timer: null, lastFlushAt: 0 };
	sessions.add(session);

	// PTY -> 浏览器：孤立的 chunk（按键回显）立即发；爆发式输出合批后再发。
	pty.onData((data) => {
		session.buffer.push(data);
		let bytes = 0;
		for (const chunk of session.buffer) bytes += chunk.length;
		if (bytes >= FLUSH_BYTES) {
			flush(session);
			return;
		}
		if (performance.now() - session.lastFlushAt >= IDLE_GAP_MS) {
			flush(session);
			return;
		}
		if (session.timer === null) session.timer = setTimeout(() => flush(session), FLUSH_MS);
	});
	pty.onExit(({ exitCode }) => {
		sessions.delete(session);
		flush(session);
		if (ws.readyState === ws.OPEN) {
			ws.send(`\r\n\x1b[2m[进程已退出，退出码 ${exitCode}]\x1b[0m\r\n`);
			ws.close();
		}
	});

	// 浏览器 -> PTY：JSON 控制帧。
	ws.on("message", (raw) => {
		let msg;
		try {
			msg = JSON.parse(String(raw));
		} catch {
			return;
		}
		if (msg.t === "i") {
			pty.write(String(msg.d ?? ""));
			return;
		}
		if (msg.t === "r") {
			const c = Math.max(2, Number(msg.c) || 80);
			const r = Math.max(1, Number(msg.r) || 24);
			try {
				pty.resize(c, r);
			} catch {
				/* 进程可能刚好退出。 */
			}
		}
	});

	ws.on("close", () => {
		sessions.delete(session);
		if (session.timer !== null) clearTimeout(session.timer);
		session.timer = null;
		try {
			pty.kill();
		} catch {
			/* 已经退出。 */
		}
	});
});

/**
 * 回收全部 PTY 并退出进程。
 * @returns 无返回值。
 */
function shutdown() {
	for (const session of sessions) {
		try {
			session.pty.kill();
		} catch {
			/* 已经退出。 */
		}
	}
	sessions.clear();
	wss.close();
	server.close(() => process.exit(0));
	// 兜底：连接未及时关闭时也要退出。
	setTimeout(() => process.exit(0), 500).unref();
}

server.on("error", (error) => {
	if (error.code === "EADDRINUSE") {
		console.error(`[remote-suite-terminal] 端口 ${PORT} 已被占用，退出（宿主会复用已在运行的实例）。`);
		process.exit(0);
	}
	console.error(`[remote-suite-terminal] 监听失败: ${String(error?.message ?? error)}`);
	process.exit(1);
});

process.on("SIGTERM", () => shutdown());
process.on("SIGINT", () => shutdown());

server.listen(PORT, HOST, () => {
	console.log(`[remote-suite-terminal] v${VERSION} 监听 ${HOST}:${PORT}（pid ${process.pid}）`);
});

export { server, wss };
//#endregion
