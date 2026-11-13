// JSON API for the browser half.
//
// The panel is deliberately dumb: it never talks to a backend directly, it asks
// these methods. That keeps path rules (`~` expansion, workspace-relative
// paths, symlink-free limits) in one implementation that the model's `remote`
// tool and the tree/editor share.
//
// Every method takes a plain object and returns JSON-serialisable data or
// throws. The route layer in `index.js` turns a throw into `{ok:false,error}`.

import { homedir } from 'node:os'
import { access, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { dataDir, loadState, makeWorkspaceId, saveState } from './state.js'
import { requireString, resolveScope, resolvePath } from './scope.js'
import { readSshConfig } from './ssh-config.js'
import { setPassword, removePassword } from './secrets.js'

/** Entries a tree listing may return before it is marked truncated. */
const TREE_LIMIT = 2000
/** An editor buffer has to fit in memory and in one HTTP response. */
const READ_MAX_BYTES = 4 * 1024 * 1024

function toEntry(entry, backend, dir) {
  return {
    name: entry.name,
    path: backend.join(dir, entry.name),
    type: entry.type,
    size: entry.size ?? 0,
    mtime: entry.mtime ?? null,
  }
}

/** Directory entries first, then files, each by name. */
function sortEntries(entries) {
  return entries.sort((a, b) => {
    if (a.type === 'dir' && b.type !== 'dir') return -1
    if (b.type === 'dir' && a.type !== 'dir') return 1
    return a.name.localeCompare(b.name)
  })
}

/** `\\wsl.localhost\<distro>\home\me\project` for a POSIX path inside a distro. */
function wslUncPath(distro, posixPath) {
  const tail = posixPath.replace(/^\/+/, '').replace(/\/+/g, '\\')
  return `\\\\wsl.localhost\\${distro}\\${tail}`
}

function profileAlias(value) {
  const alias = String(value).trim()
  // Any script is fine: the alias is an identifier inside this plugin (a target
  // id, a state key), never a `Host` line written back to ~/.ssh/config, so
  // 「云服务器」 is as workable as `prod-1`. Only what would break the target id
  // (`ssh:<alias>`), the secrets key or a file name stays out: spaces, colons,
  // slashes and control characters.
  if (!/^[\p{L}\p{N}._-]{1,64}$/u.test(alias)) {
    throw new Error(
      'remote: alias must be 1-64 letters (any language), digits, dot, dash or underscore — no spaces, colons or slashes',
    )
  }
  return alias
}

/** `~/.ssh/id_rsa`, typed by hand, expanded against the host's home directory. */
function expandHome(value) {
  if (!/^~(?=[\\/]|$)/.test(value)) return value
  return join(homedir(), value.slice(1).replace(/^[\\/]+/, ''))
}

export function createApi({ registry }) {
  const forwards = new Map()
  let forwardCounter = 0

  /** `{ target }` or `{ workspace }` plus a scope-relative path. */
  async function tree(args) {
    const scope = await resolveScope(registry, args)
    const path = resolvePath(scope.backend, scope, args)
    const result = await scope.backend.list({ path, limit: TREE_LIMIT })
    return {
      path,
      base: scope.base ?? null,
      entries: sortEntries(result.entries).map((entry) => toEntry(entry, scope.backend, path)),
      truncated: result.truncated === true,
    }
  }

  async function home(args) {
    const backend = await registry.backend(requireString(args, 'target'))
    return { home: await backend.home() }
  }

  /**
   * Mount points a file picker can start from. On Windows `os.homedir()` is
   * whatever the host process was handed, which inside the desktop app can be
   * the DSH profile directory rather than the user's home, so the picker also
   * needs a way to reach the other drives.
   */
  async function roots() {
    if (process.platform !== 'win32') return [{ label: '/', path: '/' }]
    const found = []
    for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
      const path = `${letter}:\\`
      try {
        await access(path)
        found.push({ label: path, path })
      } catch {
        // no such drive
      }
    }
    return found
  }

  async function read(args) {
    const scope = await resolveScope(registry, args)
    const path = resolvePath(scope.backend, scope, args)
    const stat = await scope.backend.stat({ path })
    if (stat.type !== 'file') throw new Error(`remote: ${path} is not a regular file`)
    if (stat.size > READ_MAX_BYTES) {
      throw new Error(`remote: ${path} is ${stat.size} bytes, over the ${READ_MAX_BYTES} byte editor limit`)
    }
    const text = await scope.backend.read({ path, maxBytes: READ_MAX_BYTES })
    return { path, text, size: stat.size, mtime: stat.mtime ?? null }
  }

  async function write(args) {
    const scope = await resolveScope(registry, args)
    const path = resolvePath(scope.backend, scope, args)
    const data = typeof args.data === 'string' ? args.data : ''
    const { bytes } = await scope.backend.write({ path, data })
    return { path, bytes }
  }

  async function stat(args) {
    const scope = await resolveScope(registry, args)
    const path = resolvePath(scope.backend, scope, args)
    const result = await scope.backend.stat({ path })
    return { path, ...result }
  }

  async function exec(args) {
    const scope = await resolveScope(registry, args)
    const workdir = typeof args.workdir === 'string' && args.workdir !== '' ? args.workdir : scope.base
    const result = await scope.backend.exec({
      command: requireString(args, 'command'),
      workdir,
      timeoutMs: Number.isFinite(args.timeoutMs) ? Math.max(1000, Math.trunc(args.timeoutMs)) : 120_000,
    })
    return result
  }

  /**
   * Forward one remote port to a loopback URL on this machine.
   *
   * Only SSH targets can do this (the tunnel rides their ssh2 connection), and
   * the listener is bound to loopback only — the remote port is never exposed.
   */
  async function forward(args) {
    const targetId = requireString(args, 'target')
    const backend = await registry.backend(targetId)
    if (typeof backend.openTunnel !== 'function') {
      throw new Error('remote: port forwarding needs an SSH or daemon target')
    }
    const port = Number(args.port)
    const host = typeof args.host === 'string' && args.host !== '' ? args.host : '127.0.0.1'
    const tunnel = await backend.openTunnel({ host, port })
    const id = `fwd-${++forwardCounter}`
    forwards.set(id, { ...tunnel, target: targetId, remotePort: port })
    return { id, url: tunnel.url, port: tunnel.port, remotePort: port, target: targetId }
  }

  function closeForward(id) {
    const tunnel = forwards.get(id)
    if (tunnel === undefined) throw new Error(`remote: unknown forward ${JSON.stringify(id)}`)
    tunnel.close()
    forwards.delete(id)
    return { closed: id }
  }

  /** Every SSH host the panel may offer: `~/.ssh/config` first, then saved ones. */
  async function sshProfiles() {
    const state = await loadState()
    let config = []
    try {
      config = await readSshConfig()
    } catch {
      config = []
    }
    const known = new Set(config.map((profile) => profile.alias))
    const hidden = new Set(state.hiddenProfiles)
    return [
      ...config
        .filter((profile) => !hidden.has(profile.alias))
        .map((profile) => ({ ...profile, source: 'config' })),
      ...state.profiles
        .filter((profile) => !known.has(profile.alias) && !hidden.has(profile.alias))
        .map((profile) => ({ ...profile, source: 'saved' })),
    ]
  }

  async function sshProfileAdd(args) {
    const alias = profileAlias(requireString(args, 'alias'))
    const hostname = String(requireString(args, 'hostname')).trim()
    if (!/^[A-Za-z0-9._:-]{1,255}$/.test(hostname)) throw new Error('remote: host must look like a host name or an IP address')
    const user = typeof args.user === 'string' && args.user.trim() !== '' ? args.user.trim() : undefined
    if (user !== undefined && !/^[A-Za-z0-9._-]{1,64}$/.test(user)) throw new Error('remote: user must look like a login name')
    let port
    if (args.port !== undefined && args.port !== null && args.port !== '') {
      port = Number(args.port)
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('remote: port must be between 1 and 65535')
    }
    const identityFile =
      typeof args.identityFile === 'string' && args.identityFile.trim() !== ''
        ? expandHome(args.identityFile.trim())
        : undefined
    const state = await loadState()
    if (state.profiles.some((profile) => profile.alias === alias)) {
      throw new Error(`remote: a saved profile named ${JSON.stringify(alias)} already exists`)
    }
    const profile = {
      alias,
      hostname,
      user,
      port,
      identityFiles: identityFile === undefined ? [] : [identityFile],
    }
    state.profiles.push(profile)
    await saveState(state)
    if (typeof args.password === 'string' && args.password !== '') await setPassword(profile, args.password)
    registry.refreshProfiles?.()
    return profile
  }

  async function sshProfileRemove(args) {
    const alias = requireString(args, 'alias').trim()
    const state = await loadState()
    const saved = state.profiles.find((entry) => entry.alias === alias)
    if (saved !== undefined) {
      state.profiles = state.profiles.filter((entry) => entry.alias !== alias)
      await saveState(state)
      // A stored password outliving its host would silently authenticate the
      // next profile that happens to reuse the alias, so it goes with the entry.
      const secretRemoved = await removePassword(saved)
      registry.refreshProfiles?.()
      return { removed: alias, source: 'saved', secretRemoved }
    }
    // A host that comes from `~/.ssh/config` is not ours to rewrite: remember
    // the alias instead, so the panel stops offering it without the plugin ever
    // editing the user's own file.
    let config = []
    try {
      config = await readSshConfig()
    } catch {
      config = []
    }
    if (!config.some((entry) => entry.alias === alias)) {
      throw new Error(`remote: no SSH host named ${JSON.stringify(alias)}`)
    }
    const hidden = new Set(state.hiddenProfiles)
    hidden.add(alias)
    state.hiddenProfiles = [...hidden]
    await saveState(state)
    registry.refreshProfiles?.()
    return { removed: alias, source: 'config', hidden: true }
  }

  /**
   * Register a remote directory as a workspace and answer the local path a DSH
   * workspace can be opened on.
   *
   * WSL directories are real directories on this machine through the 9p share,
   * so the workspace points at the UNC path. SSH and Docker directories are not,
   * so the workspace opens on a local mirror directory instead, and the remote
   * path stays in the plugin state.
   */
  async function workspaceCreate(args) {
    const targetId = requireString(args, 'target')
    const backend = await registry.backend(targetId)
    const path = requireString(args, 'path')
    const stat = await backend.stat({ path })
    if (stat.type !== 'dir') throw new Error(`remote: workspace path is not a directory: ${path}`)
    const state = await loadState()
    const name =
      typeof args.name === 'string' && args.name !== ''
        ? args.name
        : path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'workspace'
    const id = makeWorkspaceId(name, state.workspaces)

    let dshPath = path
    let localPath = null
    const kind = targetId.split(':')[0]
    if (kind === 'wsl') {
      dshPath = wslUncPath(targetId.slice(4), path)
    } else if (kind !== 'local') {
      localPath = join(dataDir(), 'mirrors', id)
      await mkdir(localPath, { recursive: true })
      dshPath = localPath
    }

    const workspace = {
      id,
      name,
      targetId,
      path,
      localPath,
      createdAt: new Date().toISOString(),
    }
    state.workspaces.push(workspace)
    await saveState(state)
    return { workspace, dshPath }
  }

  async function preparePath(args) {
    const targetId = requireString(args, 'target')
    const backend = await registry.backend(targetId)
    const path = requireString(args, 'path')
    const stat = await backend.stat({ path })
    if (stat.type !== 'dir') throw new Error(`remote: workspace path is not a directory: ${path}`)
    const kind = targetId.split(':')[0]
    if (kind === 'wsl') return { dshPath: wslUncPath(targetId.slice(4), path) }
    if (kind === 'local') return { dshPath: path }
    // SSH, daemon and Docker targets have no Windows-resolvable path, so the
    // host gets a local mirror directory; the remote side stays canonical.
    const name = path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'mirror'
    const id = makeWorkspaceId(name, [])
    const localPath = join(dataDir(), 'mirrors', id)
    await mkdir(localPath, { recursive: true })
    return { dshPath: localPath }
  }

  return {
    targets: () => registry.listTargets(),
    workspaces: async () => (await loadState()).workspaces,    forward,
    forwards: () =>
      Array.from(forwards, ([id, tunnel]) => ({
        id,
        url: tunnel.url,
        localPort: tunnel.port,
        remotePort: tunnel.remotePort,
        target: tunnel.target,
      })),
    'forward-close': (args) => closeForward(requireString(args, 'forward')),
    'ssh-profiles': () => sshProfiles(),
    'ssh-profile-add': (args) => sshProfileAdd(args),
    'ssh-profile-remove': (args) => sshProfileRemove(args),
    'workspace-create': (args) => workspaceCreate(args),
    'prepare-path': (args) => preparePath(args),

    dispose: () => {
      for (const tunnel of forwards.values()) {
        try {
          tunnel.close()
        } catch {
          // already closed
        }
      }
      forwards.clear()
    },

    'workspace-add': async (args) => {
      const targetId = requireString(args, 'target')
      const backend = await registry.backend(targetId)
      const path = requireString(args, 'path')
      const stat = await backend.stat({ path })
      if (stat.type !== 'dir') throw new Error(`remote: workspace path is not a directory: ${path}`)
      const state = await loadState()
      const name =
        typeof args.name === 'string' && args.name !== ''
          ? args.name
          : path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'workspace'
      const workspace = {
        id: makeWorkspaceId(name, state.workspaces),
        name,
        targetId,
        path,
        createdAt: new Date().toISOString(),
      }
      state.workspaces.push(workspace)
      await saveState(state)
      return workspace
    },

    'workspace-remove': async (args) => {
      const id = requireString(args, 'workspace')
      const state = await loadState()
      const before = state.workspaces.length
      state.workspaces = state.workspaces.filter((w) => w.id !== id)
      if (state.workspaces.length === before) throw new Error(`remote: unknown workspace ${JSON.stringify(id)}`)
      await saveState(state)
      return { removed: id }
    },

    tree,
    home,
    roots,
    read,
    write,
    stat,
    exec,
  }
}
