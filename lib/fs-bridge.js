// Serve our remote workspaces through DSH's own `ctx.fs` service.
//
// An SSH (or stopped-Docker) workspace is opened on an empty local mirror
// directory, so DSH's built-in file panel 鈥?which reads through `ctx.fs` 鈥?sees
// nothing. This bridge wraps the live `fs` service and answers every call whose
// path falls inside one of our mirror directories from the remote backend, and
// delegates everything else untouched.
//
// Targets travel as opaque handles: `{ targetKey, displayPath }`, where our
// targetKey is `rss:<targetId>:<remote path>`. Only our own keys are decoded;
// anything else is handed straight back to the host implementation.

import { isAbsolute, normalize, resolve as resolvePath, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readdir, readFile } from 'node:fs/promises'
import { StringDecoder } from 'node:string_decoder'

const PREFIX = 'rss:'
const CHUNK = 45 * 1024
const ROOT_TTL_MS = 2000

/** Quote one shell argument for a POSIX shell. */
function shellArg(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

function slashPath(value) {
  const text = String(value).replace(/\\/g, '/')
  return text.length > 1 ? text.replace(/\/+$/, '') : text
}

function isOurs(target) {
  return target !== null && typeof target === 'object' && typeof target.targetKey === 'string' && target.targetKey.startsWith(PREFIX)
}

/** Split `rss:<encoded targetId>:<remote>`; the id is percent-encoded because ids carry a colon. */
function decode(target) {
  const rest = target.targetKey.slice(PREFIX.length)
  const cut = rest.indexOf(':')
  return { targetId: decodeURIComponent(rest.slice(0, cut)), remote: rest.slice(cut + 1) }
}

function encode(targetId, remote) {
  return `${PREFIX}${encodeURIComponent(targetId)}:${remote}`
}

async function execText(backend, command, timeoutMs = 30000) {
  const result = await backend.exec({ command, timeoutMs })
  if (result.exitCode !== 0) {
    const detail = (result.stderr || result.stdout || '').trim() || `exit ${result.exitCode}`
    throw Object.assign(new Error(detail), { code: 'FS_IO_ERROR', exitCode: result.exitCode })
  }
  return result.stdout
}

const TYPE_OF_FIND = { d: 'directory', f: 'file', l: 'symlink', c: 'other', b: 'other', p: 'pipe', s: 'socket' }

/** Read the marker inside one mirror directory, whichever shape wrote it. */
async function markerOf(directory) {
  try {
    const remote = JSON.parse(await readFile(join(directory, '.dsh-remote.json'), 'utf8'))
    if (typeof remote.targetId === 'string' && remote.targetId !== '') return { targetId: remote.targetId, path: typeof remote.path === 'string' ? remote.path : '' }
  } catch {
    // No marker, or an unreadable one: fall through to the docker shape.
  }
  try {
    const docker = JSON.parse(await readFile(join(directory, '.dsh-docker.json'), 'utf8'))
    if (typeof docker.container === 'string' && docker.container !== '') return { targetId: `docker:${docker.container}`, path: typeof docker.path === 'string' ? docker.path : '' }
  } catch {
    // Neither marker: not one of ours.
  }
  return null
}

/**
 * Walk `mirrors/` for marker files. This is the durable source of truth: the
 * `state.json` list has been reset before and left older mirrors unmapped, but
 * the directories themselves carry their target.
 */
async function scanMirrors(mirrorsDir) {
  const found = []
  let level1
  try {
    level1 = await readdir(mirrorsDir, { withFileTypes: true })
  } catch {
    return found
  }
  for (const entry of level1) {
    if (!entry.isDirectory()) continue
    const parent = join(mirrorsDir, entry.name)
    const direct = await markerOf(parent)
    if (direct !== null) {
      found.push({ localPath: parent, ...direct })
      continue
    }
    let level2
    try {
      level2 = await readdir(parent, { withFileTypes: true })
    } catch {
      continue
    }
    for (const child of level2) {
      if (!child.isDirectory()) continue
      const leaf = join(parent, child.name)
      const marker = await markerOf(leaf)
      if (marker !== null) found.push({ localPath: leaf, ...marker })
    }
  }
  return found
}

/**
 * Wrap the host `fs` service so our mirror directories are backed by their
 * remote target.
 *
 * @param {object} options
 * @param {object} options.fs live `ctx.fs` service instance
 * @param {{backend: (id: string) => Promise<object>}} options.registry backend registry
 * @param {() => Promise<Array<{ localPath: string | null, targetId: string, path: string }>>} options.workspaces current workspaces
 * @param {(message: string, error?: unknown) => void} [options.log] diagnostics sink
 * @returns {() => void} dispose: restores the original methods
 */
export function installFsBridge({ fs, registry, workspaces, mirrorsDir, log = () => {}, note = () => {} }) {
  const saved = new Map()
  let roots = []
  let loadedAt = 0
  let loading = null
  const misses = new Set()

  async function refresh(force = false) {
    if (!force && Date.now() - loadedAt < ROOT_TTL_MS) return
    if (loading !== null) return loading
    loading = (async () => {
      try {
        const [list, scanned] = await Promise.all([
          workspaces().catch(() => []),
          typeof mirrorsDir === 'string' ? scanMirrors(mirrorsDir) : [],
        ])
        const byPath = new Map()
        const add = (localPath, targetId, remote) => {
          if (typeof localPath !== 'string' || localPath === '' || typeof targetId !== 'string' || targetId === '') return
          byPath.set(slashPath(localPath).toLowerCase(), { localPath: slashPath(localPath), targetId, remote: slashPath(remote ?? '') })
        }
        for (const entry of list) add(entry.localPath, entry.targetId, entry.path)
        for (const entry of scanned) add(entry.localPath, entry.targetId, entry.path)
        roots = [...byPath.values()].map((entry) => ({ ...entry, key: entry.localPath.toLowerCase() }))
        note(`bridge roots=${roots.length}`)
      } catch (error) {
        log('remote-suite: cannot read workspaces for the fs bridge', error)
      } finally {
        loadedAt = Date.now()
        loading = null
      }
    })()
    return loading
  }

  /** Longest matching mirror directory for an absolute local path. */
  function match(absolute) {
    const key = slashPath(absolute).toLowerCase()
    let best = null
    for (const root of roots) {
      if (key === root.key || key.startsWith(`${root.key}/`)) {
        if (best === null || root.key.length > best.key.length) best = root
      }
    }
    if (best === null) {
      // A path inside our mirrors that no record claims: that is the one failure
      // mode with no visible symptom (an empty panel), so it leaves a breadcrumb.
      const marker = 'remote-suite/mirrors/'
      if (key.includes(marker) && !misses.has(key)) {
        misses.add(key)
        note(`bridge miss ${absolute} roots=${roots.length} ${roots.map((root) => root.localPath).join(',')}`)
      }
      return null
    }
    const relative = slashPath(absolute).slice(best.localPath.length).replace(/^\/+/, '')
    return { root: best, relative }
  }

  function joined(root, relative) {
    if (relative === '') return root.remote
    return root.remote.endsWith('/') ? `${root.remote}${relative}` : `${root.remote}/${relative}`
  }

  function localAbsolute(path, cwd) {
    const text = String(path)
    const base = typeof cwd === 'string' && cwd !== '' ? cwd : process.cwd()
    return normalize(isAbsolute(text) ? text : resolvePath(base, text))
  }

  function backendFor(targetId) {
    return registry.backend(targetId)
  }

  /** Resolve one of our targets, or null when the path is a plain local path. */
  async function oursFor(path, cwd) {
    await refresh()
    if (roots.length === 0) return null
    const absolute = localAbsolute(path, cwd)
    const found = match(absolute)
    if (found === null) return null
    return {
      target: { targetKey: encode(found.root.targetId, joined(found.root, found.relative)), displayPath: absolute },
      remote: joined(found.root, found.relative),
      targetId: found.root.targetId,
    }
  }

  async function statRemote(target) {
    const { targetId, remote } = decode(target)
    const backend = await backendFor(targetId)
    const result = await backend.exec({ command: `stat -c '%F|%s|%Y' -- ${shellArg(remote)}`, timeoutMs: 30000 })
    // The host contract answers `undefined` for an absent path; the panel lists the
    // parent, then stats each child, so a race must read as "gone", not as failure.
    if (result.exitCode !== 0) return undefined
    const [kind, size, seconds] = result.stdout.trim().split('|')
    const type = kind === 'directory' ? 'directory' : kind === 'regular file' ? 'file' : 'other'
    const mtime = Number(seconds)
    return {
      version: `${Number.isFinite(mtime) ? Math.round(mtime * 1000) : 0}:${Number(size) || 0}`,
      type,
      size: Number(size) || 0,
    }
  }

  async function listRemote(target) {
    const { targetId, remote } = decode(target)
    const backend = await backendFor(targetId)
    const output = await execText(
      backend,
      `LC_ALL=C find -- ${shellArg(remote)} -mindepth 1 -maxdepth 1 -printf '%y\\t%s\\t%T@\\t%f\\n' 2>/dev/null || true`,
    )
    const entries = []
    for (const line of output.split('\n')) {
      if (line === '') continue
      const parts = line.split('\t')
      if (parts.length < 4) continue
      const [kind, size, seconds, name] = parts
      if (name === '' || name === '.' || name === '..') continue
      const type = TYPE_OF_FIND[kind] ?? 'other'
      const nextRemote = joined({ remote }, name)
      entries.push({
        name,
        type,
        ...(Number(size) >= 0 ? { size: Number(size) || 0 } : {}),
        version: `${Number.parseFloat(seconds) > 0 ? Math.round(Number.parseFloat(seconds) * 1000) : 0}:${Number(size) || 0}`,
        target: { targetKey: encode(targetId, nextRemote), displayPath: `${target.displayPath.replace(/[\\/]+$/, '')}/${name}` },
      })
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    return entries
  }

  async function readRange(target, offset, length) {
    const { targetId, remote } = decode(target)
    const backend = await backendFor(targetId)
    const command =
      offset === 0
        ? `head -c ${length} -- ${shellArg(remote)} | base64 -w0`
        : `tail -c +${offset + 1} -- ${shellArg(remote)} | head -c ${length} | base64 -w0`
    const output = await execText(backend, command, 60000)
    if (output.trim() === '') return Buffer.alloc(0)
    return Buffer.from(output.trim(), 'base64')
  }

  async function readAll(target, signal) {
    const chunks = []
    let offset = 0
    for (;;) {
      if (signal?.aborted) throw Object.assign(new Error('read aborted'), { code: 'FS_ABORTED' })
      const chunk = await readRange(target, offset, CHUNK)
      if (chunk.length === 0) break
      chunks.push(chunk)
      offset += chunk.length
      if (chunk.length < CHUNK) break
    }
    return Buffer.concat(chunks)
  }


  const bridge = {
    async resolve(path, options) {
      const hit = await oursFor(path, options?.cwd)
      if (hit === null) return saved.get('resolve').call(fs, path, options)
      return hit.target
    },

    processPath(target) {
      if (isOurs(target) && typeof target.displayPath === 'string') return target.displayPath
      return saved.get('processPath').call(fs, target)
    },

    fileUrl(target) {
      if (isOurs(target) && typeof target.displayPath === 'string') return pathToFileURL(target.displayPath).href
      return saved.get('fileUrl').call(fs, target)
    },

    contains(parent, child) {
      if (isOurs(parent) && isOurs(child)) {
        const a = decode(parent)
        const b = decode(child)
        return a.targetId === b.targetId && (b.remote === a.remote || b.remote.startsWith(`${a.remote.replace(/\/+$/, '')}/`))
      }
      return saved.get('contains').call(fs, parent, child)
    },

    async stat(target, signal) {
      if (!isOurs(target)) return saved.get('stat').call(fs, target, signal)
      if (signal?.aborted) throw Object.assign(new Error('stat aborted'), { code: 'FS_ABORTED' })
      return statRemote(target)
    },

    async lstat(path, options, signal) {
      const hit = await oursFor(path, options?.cwd)
      if (hit === null) return saved.get('lstat').call(fs, path, options, signal)
      return statRemote(hit.target)
    },

    async listDir(target, signal) {
      if (!isOurs(target)) return saved.get('listDir').call(fs, target, signal)
      if (signal?.aborted) throw Object.assign(new Error('list aborted'), { code: 'FS_ABORTED' })
      return listRemote(target)
    },

    async readBytes(target, signal, maxBytes) {
      if (!isOurs(target)) return saved.get('readBytes').call(fs, target, signal, maxBytes)
      const buffer = await readAll(target, signal)
      if (typeof maxBytes === 'number' && buffer.length > maxBytes) throw Object.assign(new Error('file too large'), { code: 'FS_TOO_LARGE' })
      return buffer
    },

    async readByteRange(target, range, signal) {
      if (!isOurs(target)) return saved.get('readByteRange').call(fs, target, range, signal)
      if (signal?.aborted) throw Object.assign(new Error('read aborted'), { code: 'FS_ABORTED' })
      const offset = Math.max(0, Number(range?.offset) || 0)
      const length = Math.max(0, Number(range?.length) || 0)
      if (length === 0) return Buffer.alloc(0)
      return readRange(target, offset, length)
    },

    async streamText(target, signal) {
      if (!isOurs(target)) return saved.get('streamText').call(fs, target, signal)
      const buffer = await readAll(target, signal)
      // `read()` classifies a binary refusal by the code alone, so the message
      // never reaches the panel.
      if (buffer.subarray(0, 8192).includes(0)) throw Object.assign(new Error('not UTF-8 text'), { code: 'FS_NOT_TEXT' })
      return (async function* stream() {
        const decoder = new StringDecoder('utf8')
        for (let at = 0; at < buffer.length; at += CHUNK) {
          yield decoder.write(buffer.subarray(at, at + CHUNK))
        }
        const tail = decoder.end()
        if (tail !== '') yield tail
      })()
    },

    async watch(target, changed, signal) {
      if (!isOurs(target)) return saved.get('watch').call(fs, target, changed, signal)
      signal?.throwIfAborted?.()
      // The host backend watches inotify handles; over SSH the cheapest honest
      // answer is a poll: the panel re-lists when the directory digest moves.
      let last = await digest(target)
      const timer = setInterval(async () => {
        try {
          const next = await digest(target)
          if (next === last) return
          last = next
          changed()
        } catch {
          // A transient backend failure keeps the watcher alive; the next poll retries.
        }
      }, 3000)
      timer.unref?.()
      return () => clearInterval(timer)
    },
  }

  /** Cheap change signature for one remote target: metadata for a file, entries for a directory. */
  async function digest(target) {
    try {
      const info = await statRemote(target)
      if (info === undefined) return 'gone'
      if (info.type !== 'directory') return `file:${info.version}`
      const entries = await listRemote(target)
      return `dir:${entries.map((entry) => `${entry.name}:${entry.version ?? ''}`).join('|')}`
    } catch {
      return 'error'
    }
  }

  for (const name of Object.keys(bridge)) {
    // A host that implemented fewer methods keeps its own surface; only the
    // ones that exist here are shadowed (and restored on dispose).
    if (typeof fs[name] !== 'function') continue
    saved.set(name, fs[name])
    fs[name] = bridge[name]
  }

  return () => {
    for (const [name, original] of saved) fs[name] = original
    saved.clear()
  }
}
