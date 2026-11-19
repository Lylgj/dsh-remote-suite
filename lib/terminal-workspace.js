//#region remote-workspace.js
/**
 * 远端工作区标记识别（宿主半边的纯函数，单独成文件便于测试）。
 *
 * 认两类 SSH 工作区标记：
 *   - `.remote-ssh.json`：@zhangfengshun/dsh-remote-ssh 写在本地工作区目录里的
 *     标记，自带 `host` / `user` / `keyPath`，可以拼出完整 ssh 参数；
 *   - `.dsh-remote.json`：@lylgj/dsh-remote-suite 写在本地镜像目录里的标记，
 *     形状是 `{ targetId: "ssh:<alias>", path: "~/项目" }`，只记「哪个远端、哪个
 *     目录」，主机参数得去 `~/.ssh/config`（或 remote-suite 自己的 state.json）里查。
 *
 * 两种标记的落点换算规则一致：本地工作区目录对应远端标记里的目录，子目录按相对
 * 路径拼在后面。
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, normalize } from "node:path";

/** remote-suite 写进每一个本地镜像目录的标记文件名。 */
export const REMOTE_SUITE_MARKER = ".dsh-remote.json";

/** 向上最多找几层工作区标记（与 lib/index.js 里的 MAX_UP_LEVELS 保持一致）。 */
const MAX_UP_LEVELS = 10;

/**
 * 把配置里的 `~` 展开成用户目录。
 * @param value - 配置值（如 `~/.ssh/id_ed25519`）。
 * @param home - 用户目录，默认取 homedir()。
 * @returns 展开后的路径；不含 `~` 时原样返回。
 */
export function expandHomePath(value, home = homedir()) {
  if (typeof value !== "string" || value === "") return "";
  if (value === "~") return home;
  if (value.startsWith("~/") || value.startsWith("~\\")) return join(home, value.slice(2));
  return value;
}

/**
 * 解析 OpenSSH 配置文本，返回每个 Host 块里我们关心的字段。
 * 通配符别名（`Host *`、`Host 192.168.*`）不参与匹配，`Match` 块整段跳过。
 * @param text - ~/.ssh/config 的内容。
 * @returns { aliases, fields } 数组：fields 是「小写关键字 -> 第一次出现的值」。
 */
export function parseSshConfigBlocks(text) {
  const blocks = [];
  let current = null;
  if (typeof text !== "string") return blocks;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, "").replace(/^#.*$/, "").trim();
    if (line === "") continue;
    const space = line.search(/\s/);
    const keyword = (space === -1 ? line : line.slice(0, space)).toLowerCase();
    const value = space === -1 ? "" : line.slice(space + 1).trim();
    if (keyword === "host") {
      current = {
        aliases: value
          .split(/\s+/)
          .filter((alias) => alias !== "" && !alias.includes("*") && !alias.includes("?")),
        fields: new Map(),
      };
      blocks.push(current);
      continue;
    }
    if (keyword === "match") {
      current = null;
      continue;
    }
    if (current === null || value === "") continue;
    if (!current.fields.has(keyword)) current.fields.set(keyword, value.replace(/^"(.*)"$/, "$1"));
  }
  return blocks;
}

/**
 * 把 SSH 配置里的 Host 块换算成连接参数。
 * @param blocks - parseSshConfigBlocks 的结果。
 * @param alias - 目标别名（也可能是 IP，只要配置里有对应 Host 行）。
 * @returns { host, user, port, keyPath, proxyJump } 或 null。
 */
export function profileFromBlocks(blocks, alias, home = homedir()) {
  const block = blocks.find((candidate) => candidate.aliases.includes(alias));
  if (block === undefined) return null;
  const port = Number(block.fields.get("port"));
  return {
    host: block.fields.get("hostname") ?? alias,
    user: block.fields.get("user") ?? "",
    port: Number.isInteger(port) && port > 0 ? port : 0,
    keyPath: expandHomePath(block.fields.get("identityfile") ?? "", home),
    proxyJump: block.fields.get("proxyjump") === "none" ? "" : (block.fields.get("proxyjump") ?? ""),
  };
}

/**
 * `~/.ssh/config` 的默认路径。
 * @param home - 用户目录。
 * @returns 配置路径。
 */
export function defaultSshConfigPath(home = homedir()) {
  return join(home, ".ssh", "config");
}

/**
 * remote-suite 保存「面板里新增的主机」的 state.json 路径。
 * @param home - 用户目录。
 * @returns state.json 路径。
 */
export function defaultRemoteSuiteStatePath(home = homedir()) {
  const dshHome = process.env.DSH_HOME ?? join(home, ".dsh");
  return join(dshHome, "remote-suite", "state.json");
}

/**
 * 查一个 SSH 目标别名的连接参数：先看 ~/.ssh/config，再看 remote-suite 的 state.json。
 * 后者覆盖「只在 remote-suite 面板里加过、没写进 ssh config」的主机。
 * @param alias - 目标别名（如 `192.168.81.77`）。
 * @param options - configPath / statePath / home 可覆盖，测试用。
 * @returns { host, user, port, keyPath, proxyJump } 或 null。
 */
export function loadSshProfile(alias, options = {}) {
  const home = options.home ?? homedir();
  const configPath = options.configPath ?? defaultSshConfigPath(home);
  if (typeof alias !== "string" || alias === "") return null;

  try {
    const fromConfig = profileFromBlocks(parseSshConfigBlocks(readFileSync(configPath, "utf8")), alias, home);
    if (fromConfig !== null) return fromConfig;
  } catch {
    /* 没有 ssh 配置，继续看 remote-suite 的记录。 */
  }

  try {
    const statePath = options.statePath ?? defaultRemoteSuiteStatePath(home);
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    const profiles = Array.isArray(state?.profiles) ? state.profiles : [];
    const saved = profiles.find((candidate) => candidate?.alias === alias);
    if (saved !== undefined && saved !== null) {
      const port = Number(saved.port);
      return {
        host: String(saved.hostname ?? alias),
        user: typeof saved.user === "string" ? saved.user : "",
        port: Number.isInteger(port) && port > 0 ? port : 0,
        keyPath: Array.isArray(saved.identityFiles) && saved.identityFiles.length > 0 ? String(saved.identityFiles[0]) : "",
        proxyJump: typeof saved.proxyJump === "string" ? saved.proxyJump : "",
      };
    }
  } catch {
    /* 没有 state.json。 */
  }
  return null;
}

/**
 * 从工作区目录向上找 remote-suite 的镜像标记（只认 SSH 目标）。
 * @param start - 工作区目录。
 * @param options - maxUp 可覆盖层数上限。
 * @returns { info, root } 或 null。
 */
export function findRemoteSuiteWorkspace(start, options = {}) {
  const maxUp = options.maxUp ?? MAX_UP_LEVELS;
  let dir = start;
  for (let i = 0; i < maxUp; i += 1) {
    try {
      const info = JSON.parse(readFileSync(join(dir, REMOTE_SUITE_MARKER), "utf8"));
      if (
        info !== null &&
        typeof info === "object" &&
        typeof info.targetId === "string" &&
        info.targetId.startsWith("ssh:")
      ) {
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
 * 把「本地工作区目录相对镜像根的位置」换算成远端目录。
 * @param info - 标记内容，`path` 是远端目录。
 * @param root - 镜像根目录。
 * @param cwd - 当前工作区目录。
 * @returns 远端路径（可能以 `~/` 开头）。
 */
export function remotePathOf(info, root, cwd) {
  const rel = normalize(cwd)
    .slice(normalize(root).length)
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");
  const base = String(info.path ?? "~").replace(/\/+$/, "");
  if (rel === "" || rel === ".") return base === "" ? "~" : base;
  return `${base}/${rel}`;
}

/**
 * 把远端目录换算成 `cd` 表达式（`~` 展开成 `$HOME`，其余原样引用）。
 * @param target - 远端路径。
 * @returns 可以塞进双引号的路径表达式。
 */
export function cdExpression(target) {
  if (target === "~") return "$HOME";
  if (target.startsWith("~/")) return `$HOME/${target.slice(2)}`;
  return target;
}

/**
 * 由主机参数与落点拼 ssh 启动参数。
 * @param profile - { host, user, port, keyPath, proxyJump }。
 * @param target - 远端目录。
 * @param options - ssh 可执行文件路径。
 * @returns { kind, command, args }。
 */
function sshSpec(profile, target, options) {
  const ssh = options.ssh ?? (process.platform === "win32" ? "ssh.exe" : "ssh");
  const args = ["-tt", "-o", "StrictHostKeyChecking=no", "-o", "ExitOnForwardFailure=no"];
  if (profile.proxyJump !== "") args.push("-J", String(profile.proxyJump));
  if (profile.port > 0) args.push("-p", String(profile.port));
  if (profile.keyPath !== "") args.push("-i", profile.keyPath);
  args.push(profile.user === "" ? profile.host : `${profile.user}@${profile.host}`);
  args.push(`cd "${cdExpression(target)}" 2>/dev/null || cd "$HOME"; exec "\${SHELL:-/bin/bash}" -l`);
  return { kind: "ssh", command: ssh, args };
}

/**
 * 由 remote-suite 工作区标记拼出 ssh 启动参数（落点映射到远端对应目录）。
 * @param remote - findRemoteSuiteWorkspace 的结果。
 * @param cwd - 当前工作区目录。
 * @param options - ssh 可执行文件路径、profile 覆盖，测试用。
 * @returns { kind, command, args } 或 null（查不到主机参数时）。
 */
export function remoteSuiteShellSpec(remote, cwd, options = {}) {
  if (remote === null || typeof remote !== "object") return null;
  const { info, root } = remote;
  const alias = String(info.targetId ?? "").slice(4);
  if (alias === "") return null;
  const profile = Object.prototype.hasOwnProperty.call(options, "profile")
    ? options.profile
    : loadSshProfile(alias, options);
  if (profile === null) return null;
  return sshSpec(profile, remotePathOf(info, root, cwd), options);
}

/** dsh-remote-ssh（@zhangfengshun/dsh-remote-ssh）写在工作区目录里的标记文件名。 */
export const REMOTE_SSH_MARKER = ".remote-ssh.json";

/**
 * 从工作区目录向上找 dsh-remote-ssh 的工作区标记（自带 host/user/keyPath）。
 * @param start - 工作区目录。
 * @param options - maxUp 可覆盖层数上限。
 * @returns { info, root } 或 null。
 */
export function findRemoteSshWorkspace(start, options = {}) {
  const maxUp = options.maxUp ?? MAX_UP_LEVELS;
  let dir = start;
  for (let i = 0; i < maxUp; i += 1) {
    try {
      const info = JSON.parse(readFileSync(join(dir, REMOTE_SSH_MARKER), "utf8"));
      if (info !== null && typeof info === "object" && info.host && info.user && info.keyPath) {
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
 * 由 dsh-remote-ssh 工作区标记拼出 ssh 启动参数。
 * @param remote - findRemoteSshWorkspace 的结果。
 * @param cwd - 当前工作区目录。
 * @param options - ssh 可执行文件路径。
 * @returns { kind, command, args }。
 */
export function remoteSshShellSpec(remote, cwd, options = {}) {
  const { info, root } = remote;
  const profile = {
    host: String(info.host),
    user: String(info.user),
    port: Number.isInteger(Number(info.port)) && Number(info.port) > 0 ? Number(info.port) : 22,
    keyPath: String(info.keyPath),
    proxyJump: typeof info.proxyJump === "string" ? info.proxyJump : "",
  };
  const rel = normalize(cwd)
    .slice(normalize(root).length)
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");
  const base = String(info.remotePath ?? "~").replace(/\/+$/, "");
  const target = rel === "" || rel === "." ? base : `${base}/${rel}`;
  return sshSpec(profile, target === "" ? "~" : target, options);
}

/**
 * 工作区目录 → SSH 启动参数：先认 dsh-remote-ssh 的标记，再认 remote-suite 的镜像标记。
 * @param cwd - 工作区目录。
 * @param options - ssh 可执行文件路径、maxUp 等。
 * @returns { kind, command, args } 或 null（不是 SSH 工作区）。
 */
export function workspaceSshSpec(cwd, options = {}) {
  const direct = findRemoteSshWorkspace(cwd, options);
  if (direct !== null) return remoteSshShellSpec(direct, cwd, options);
  const mirror = findRemoteSuiteWorkspace(cwd, options);
  if (mirror !== null) return remoteSuiteShellSpec(mirror, cwd, options);
  return null;
}

/**
 * 从 SSH 启动参数里取出主机名（`user@host` 的 host 部分）。
 * @param spec - SSH 启动参数。
 * @returns 主机名；取不到时给 "remote"。
 */
export function sshHostOfSpec(spec) {
  const args = Array.isArray(spec?.args) ? spec.args : [];
  const hostArg = args.find((arg) => typeof arg === "string" && arg.includes("@"));
  if (hostArg !== undefined) return hostArg.slice(hostArg.indexOf("@") + 1);
  return typeof args[1] === "string" ? args[1] : "remote";
}

/**
 * 前端在下拉框里显式选了一台 SSH 主机 → 启动参数。
 * 选的正是当前 SSH 工作区那台主机时，沿用工作区的 key、跳板与远端目录；
 * 否则只做 `ssh -tt <主机>`（按 ~/.ssh/config 连接）。
 * @param cwd - 工作区目录。
 * @param alias - 选中的主机（ssh:<主机> 里的那一段）。
 * @param options - ssh 可执行文件路径、maxUp 等。
 * @returns { kind, command, args }。
 */
export function sshSelectionSpec(cwd, alias, options = {}) {
  const workspace = workspaceSshSpec(cwd, options);
  if (workspace !== null && sshHostOfSpec(workspace) === alias) return workspace;
  const ssh = options.ssh ?? (process.platform === "win32" ? "ssh.exe" : "ssh");
  return { kind: "ssh", command: ssh, args: ["-tt", alias] };
}

/**
 * 把 Windows 盘符路径换成 WSL 的 /mnt 路径。
 * @param dir - Windows 路径（如 D:\work\demo_project）。
 * @returns WSL 路径；不是盘符路径时为空串。
 */
export function windowsPathToWsl(dir) {
  if (typeof dir !== "string") return "";
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(dir);
  if (match === null) return "";
  return `/mnt/${match[1].toLowerCase()}/${match[2].replace(/\\/g, "/")}`;
}

/**
 * Windows 的 WSL UNC 工作区（`\\wsl.localhost\<发行版>\...`）→ wsl.exe 启动参数。
 * @param cwd - 工作区目录。
 * @returns { kind, command, args } 或 null。
 */
export function wslUncShellSpec(cwd) {
  if (process.platform !== "win32" || typeof cwd !== "string") return null;
  const match = /^\\\\(?:wsl(?:\.localhost|\$)|wsl\.localhost)\\([^\\]+)(?:\\(.*))?$/i.exec(cwd);
  if (match === null) return null;
  const rest = (match[2] ?? "").replace(/\\/g, "/");
  return {
    kind: "wsl",
    command: "wsl.exe",
    args: ["-d", match[1], "--cd", rest === "" ? "/" : `/${rest}`, "-e", "bash", "-l"],
  };
}
//#endregion
