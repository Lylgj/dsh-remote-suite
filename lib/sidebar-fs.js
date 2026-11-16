// A filesystem API shaped exactly like `dsh-better-sidebar`'s, but served by
// this plugin for local *and* remote workspaces.
//
// The wire contract is copied method for method from better-sidebar's
// `/sidebar/api/<method>` endpoints: the same payloads, the same response
// shapes, the same error codes. Only the mount point differs — everything lives
// under `/remote-suite/api` and `/remote-suite/{write,file}`, so installing both
// plugins never makes one shadow the other.
//
// The one thing a browser cannot do is pick a filesystem per request, so every
// call carries a `sessionId`; the session's working directory decides whether
// the request is served by node's own fs (local workspaces) or by a remote
// backend (WSL / SSH / Docker / daemon).

import { randomUUID } from 'node:crypto'
import { open, readdir, readFile, stat as fsStat, lstat, mkdir, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { posix, win32 } from 'node:path'

/** Largest file the editor will open whole (better-sidebar: 5 MiB). */
export const MAX_EDITABLE_BYTES = 5 * 1024 * 1024

/** Largest single page `fs.readPage` returns (better-sidebar: 128 KiB). */
export const PAGE_BYTES = 128 * 1024

/** How much of an oversized/binary file `fs.read` hands back as a head preview. */
export const READ_HEAD_LIMIT = 4096

/** Directory listing cap. */
export const TREE_LIMIT = 1000

/** Content search cap. */
export const DEFAULT_MAX_MATCHES = 200

/** Largest body `/remote-suite/write` accepts. */
export const WRITE_BODY_GUARD_BYTES = 8 * 1024 * 1024

/** One shell round trip carries at most this much base64 (exec truncates at 64 KiB). */
const READ_CHUNK = 45 * 1024

/** Directories a content search never descends into. */
const SEARCH_SKIP = new Set(['.git', '.svn', '.hg', 'node_modules', 'dist', 'build', '.venv', 'venv', '__pycache__'])

/** One search walks at most this many files. */
const SEARCH_FILE_LIMIT = 2000

/** Marker this plugin drops in every local mirror directory. */
export const REMOTE_MARKER = '.dsh-remote.json'

/** Marker an older docker-aware release dropped (still honoured). */
export const DOCKER_MARKER = '.dsh-docker.json'

/** Wire-shaped failure: `{ code, message }` plus the HTTP status to use. */
export class SidebarError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.name = 'SidebarError'
    this.code = code
    this.status = status
  }
}

function badRequest(message) {
  return new SidebarError('bad-request', message, 400)
}

function fsError(message, status = 400) {
  return new SidebarError('fs-error', message, status)
}

/** A Windows path is absolute when it has a drive letter, a UNC root or a leading slash. */
function isLocalAbsolute(value) {
  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\') || value.startsWith('/')
}

/** Case-insensitive comparison key for a Windows path. */
function localKey(value) {
  return win32.resolve(value).replace(/[\\/]+$/, '').toLowerCase()
}

function posixKey(value) {
  const normalized = posix.normalize(value || '/')
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized
}

/** True when `child` is `root` or lives below it. */
function withinLocal(root, child) {
  const base = localKey(root)
  const target = localKey(child)
  return target === base || target.startsWith(`${base}\\`)
}

function withinPosix(root, child) {
  const base = posixKey(root)
  const target = posixKey(child)
  return target === base || target.startsWith(base === '/' ? '/' : `${base}/`)
}

/** Directory rows first, then a case-folded code-point order (better-sidebar's 4.2). */
function compareEntries(a, b) {
  if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
  const left = a.name.toLowerCase()
  const right = b.name.toLowerCase()
  if (left < right) return -1
  if (left > right) return 1
  if (a.name < b.name) return -1
  if (a.name > b.name) return 1
  return 0
}

/** One path segment a user typed, refused when it could escape its directory. */
function assertSegment(name) {
  const value = typeof name === 'string' ? name.trim() : ''
  if (value === '' || value === '.' || value === '..') throw badRequest('name must be a single path segment')
  if (/[\\/]/.test(value)) throw badRequest('name must not contain a path separator')
  if (/[\u0000-\u001f]/.test(value)) throw badRequest('name must not contain control characters')
  return value
}

/** Decode bytes as UTF-8, or answer null when the bytes are not text. */
function decodeText(buffer) {
  if (buffer.includes(0)) return null
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    return null
  }
}

/** Index just past the last line break, or -1 when there is none. */
function lastLineBreakEnd(buffer) {
  const index = buffer.lastIndexOf(0x0a)
  return index === -1 ? -1 : index + 1
}

/**
 * Serve the file API for one plugin mount.
 *
 * @param {object} options
 * @param {{ backend(id: string): Promise<any>, listTargets(): Promise<any[]> }} options.registry
 * @param {string} options.mirrorsDir absolute `…/remote-suite/mirrors`
 * @param {(sessionId?: string, clientCwd?: string) => Promise<string|undefined>} options.sessionCwd
 */
export function createSidebarFs({ registry, mirrorsDir, sessionCwd }) {
  /** Mirror directories, cached for a few seconds; write operations drop the cache. */
  let mirrorCache = null
  let mirrorCacheAt = 0

  async function readMarker(dir) {
    for (const [file, kind] of [
      [REMOTE_MARKER, 'remote'],
      [DOCKER_MARKER, 'docker'],
    ]) {
      try {
        const raw = await readFile(`${dir}/${file}`, 'utf8')
        const parsed = JSON.parse(raw.replace(/^\uFEFF/, ''))
        const targetId = kind === 'remote' ? parsed?.targetId : parsed?.container ? `docker:${parsed.container}` : undefined
        if (typeof targetId !== 'string' || targetId === '') continue
        return { targetId, path: typeof parsed?.path === 'string' ? parsed.path : '' }
      } catch {
        // No marker here; try the next shape.
      }
    }
    return null
  }

  /** Every mirror directory that names its remote target, deepest path first. */
  async function scopes() {
    if (mirrorCache !== null && Date.now() - mirrorCacheAt < 3000) return mirrorCache
    const found = []
    const tops = await readdir(mirrorsDir, { withFileTypes: true }).catch(() => [])
    for (const top of tops) {
      if (!top.isDirectory()) continue
      const dir = `${mirrorsDir}/${top.name}`
      const marker = await readMarker(dir)
      if (marker !== null) found.push({ dir, ...marker })
      const inner = await readdir(dir, { withFileTypes: true }).catch(() => [])
      for (const leaf of inner) {
        if (!leaf.isDirectory()) continue
        const nested = `${dir}/${leaf.name}`
        const nestedMarker = await readMarker(nested)
        if (nestedMarker !== null) found.push({ dir: nested, ...nestedMarker })
      }
    }
    mirrorCache = found
    mirrorCacheAt = Date.now()
    return found
  }

  /** Drop the cache so the next call rescans (a workspace may have been added). */
  function invalidate() {
    mirrorCache = null
  }

  /**
   * The remote `$HOME`, so a workspace saved as `~/project` still compares and
   * joins against absolute paths. Backends that already answer with a path use
   * that; the rest are asked once and the answer is cached per target.
   */
  const homeCache = new Map()
  async function remoteHomeOf(scope) {
    const key = scope.targetId
    if (homeCache.has(key)) return homeCache.get(key)
    let home = null
    try {
      const direct = typeof scope.backend.home === 'function' ? await scope.backend.home() : undefined
      if (typeof direct === 'string' && direct.startsWith('/')) home = direct
    } catch {
      home = null
    }
    if (home === null) {
      try {
        const result = await scope.backend.exec({ command: 'printf %s "$HOME"', timeoutMs: 15_000 })
        const value = result !== undefined && typeof result.stdout === 'string' ? result.stdout.trim() : ''
        if (value.startsWith('/')) home = value
      } catch {
        home = null
      }
    }
    homeCache.set(key, home)
    return home
  }

  /** `~` / `~/x` roots become absolute before anything is compared against them. */
  async function expandRemoteRoot(scope) {
    if (scope.root !== '~' && !scope.root.startsWith('~/')) return scope
    const home = await remoteHomeOf(scope)
    if (typeof home !== 'string' || home === '') return scope
    return { ...scope, root: posix.join(home, scope.root.slice(1)) }
  }

  /** Local path → the remote scope it mirrors, if any. */
  async function remoteScopeFor(cwd) {
    const known = await scopes()
    let best = null
    for (const entry of known) {
      if (!withinLocal(entry.dir, cwd)) continue
      if (best === null || entry.dir.length > best.dir.length) best = entry
    }
    if (best === null) return null
    const rest = cwd.slice(best.dir.length).replace(/^[\\/]+/, '').replace(/\\/g, '/')
    const root = rest === '' ? best.path || '/' : posix.join(best.path || '/', rest)
    return { kind: 'remote', targetId: best.targetId, root, sep: '/', caseSensitive: true }
  }

  /**
   * Resolve the filesystem namespace of one request.
   * @param {{ sessionId?: string, cwd?: string }} payload
   */
  async function scopeOf(payload) {
    const cwd = await resolveCwd(payload)
    if (cwd === undefined) throw badRequest('this request needs a sessionId or a cwd')
    const remote = await remoteScopeFor(cwd)
    if (remote !== null) {
      const scope = await expandRemoteRoot({ ...remote, backend: await registry.backend(remote.targetId) })
      return scope
    }
    const root = win32.resolve(cwd)
    return { kind: 'local', root, sep: '\\', caseSensitive: false }
  }

  /** Session working directory, or the client-provided one as a fallback. */
  async function resolveCwd(payload) {
    const sessionId = typeof payload.sessionId === 'string' && payload.sessionId !== '' ? payload.sessionId : undefined
    const clientCwd = typeof payload.cwd === 'string' && payload.cwd !== '' ? payload.cwd : undefined
    if (sessionId !== undefined) {
      const resolved = await sessionCwd(sessionId, clientCwd).catch(() => undefined)
      if (typeof resolved === 'string' && resolved !== '') return resolved
    }
    return clientCwd
  }

  /** Absolute path inside the scope; refuses anything that escapes the workspace. */
  function inside(scope, value, what = 'path') {
    const raw = typeof value === 'string' ? value.trim() : ''
    if (raw === '') return scope.root
    const absolute = scope.kind === 'local' ? win32.resolve(scope.root, raw) : posix.resolve(scope.root, raw)
    const ok = scope.kind === 'local' ? withinLocal(scope.root, absolute) : withinPosix(scope.root, absolute)
    if (!ok) throw badRequest(`${what} is outside this workspace`)
    return absolute
  }

  function joinIn(scope, dir, name) {
    return scope.kind === 'local' ? win32.join(dir, name) : posix.join(dir, name)
  }

  function parentOf(scope, value) {
    return scope.kind === 'local' ? win32.dirname(value) : posix.dirname(value)
  }

  function baseOf(scope, value) {
    return scope.kind === 'local' ? win32.basename(value) : posix.basename(value)
  }

  function isRoot(scope, value) {
    return scope.kind === 'local' ? localKey(value) === localKey(scope.root) : posixKey(value) === posixKey(scope.root)
  }

  /** Shell-safe single-quoted literal for a POSIX remote. */
  function shellArg(value) {
    return `'${String(value).replace(/'/g, `'\\''`)}'`
  }

  async function run(scope, command) {
    const result = await scope.backend.exec({ command })
    if (result.exitCode !== 0) return null
    return result.stdout
  }

  /** stat → `{ type, size, mtimeMs }`, or undefined when the path is missing. */
  async function statOf(scope, path) {
    if (scope.kind === 'local') {
      try {
        const info = await lstat(path)
        const isLink = info.isSymbolicLink()
        let target = info
        let broken = false
        if (isLink) {
          try {
            target = await fsStat(path)
          } catch {
            broken = true
          }
        }
        return {
          type: broken ? 'other' : target.isDirectory() ? 'dir' : target.isFile() ? 'file' : 'other',
          size: target.size,
          mtimeMs: target.mtimeMs,
          isSymlink: isLink,
          broken,
        }
      } catch {
        return undefined
      }
    }
    const info = await scope.backend.stat({ path }).catch(() => undefined)
    if (info === undefined) return undefined
    const type = info.type === 'dir' ? 'dir' : info.type === 'file' ? 'file' : 'other'
    return {
      type,
      size: typeof info.size === 'number' ? info.size : 0,
      mtimeMs: typeof info.mtimeMs === 'number' ? info.mtimeMs : 0,
      isSymlink: info.type === 'symlink',
      broken: false,
    }
  }

  /** Raw bytes of `[offset, offset + length)` — base64 over the wire when remote. */
  async function readRange(scope, path, offset, length) {
    if (length <= 0) return Buffer.alloc(0)
    if (scope.kind === 'local') {
      const handle = await open(path, 'r')
      try {
        const buffer = Buffer.alloc(length)
        const { bytesRead } = await handle.read(buffer, 0, length, offset)
        return buffer.subarray(0, bytesRead)
      } finally {
        await handle.close()
      }
    }
    const chunks = []
    let done = 0
    while (done < length) {
      const take = Math.min(READ_CHUNK, length - done)
      const from = offset + done + 1
      const command = `tail -c +${from} -- ${shellArg(path)} | head -c ${take} | base64 -w0`
      const stdout = await run(scope, command)
      if (stdout === null) throw fsError(`cannot read "${path}"`, 400)
      const bytes = Buffer.from(stdout.replace(/\s+/g, ''), 'base64')
      if (bytes.length === 0) break
      chunks.push(bytes)
      done += bytes.length
      if (bytes.length < take) break
    }
    return Buffer.concat(chunks)
  }

  /** One `readdir`, mapped to the wire entry shape better-sidebar uses. */
  async function listDir(scope, dir) {
    const entries = []
    if (scope.kind === 'local') {
      const dirents = await readdir(dir, { withFileTypes: true }).catch((error) => {
        throw fsError(`cannot read "${dir}": ${error instanceof Error ? error.message : String(error)}`, 400)
      })
      for (const dirent of dirents) {
        const child = joinIn(scope, dir, dirent.name)
        // A symlink keeps `isDir: false` even when it points at a directory; the
        // tree row stays a file row, exactly like better-sidebar's explorer.
        const isSymlink = dirent.isSymbolicLink()
        let broken = false
        if (isSymlink) {
          try {
            await fsStat(child)
          } catch {
            broken = true
          }
        }
        entries.push({
          name: dirent.name,
          path: child,
          isDir: dirent.isDirectory(),
          isSymlink,
          broken,
          hidden: dirent.name.startsWith('.'),
        })
      }
    } else {
      const listed = await scope.backend.list({ path: dir, limit: TREE_LIMIT }).catch((error) => {
        throw fsError(`cannot read "${dir}": ${error instanceof Error ? error.message : String(error)}`, 400)
      })
      const rows = Array.isArray(listed?.entries) ? listed.entries : []
      for (const row of rows) {
        const name = String(row?.name ?? '')
        if (name === '') continue
        entries.push({
          name,
          path: posix.join(dir, name),
          isDir: row?.type === 'dir',
          isSymlink: row?.type === 'symlink',
          broken: false,
          hidden: name.startsWith('.'),
        })
      }
    }
    entries.sort(compareEntries)
    return { entries, truncated: entries.length > TREE_LIMIT }
  }

  async function tree(payload) {
    const scope = await scopeOf(payload)
    const dir = inside(scope, payload.path)
    const info = await statOf(scope, dir)
    if (info === undefined) throw new SidebarError('not-found', `"${dir}" does not exist`, 404)
    if (info.type !== 'dir') throw new SidebarError('fs-directory', `"${dir}" is not a directory`, 400)
    const { entries } = await listDir(scope, dir)
    return { path: dir, entries: entries.slice(0, TREE_LIMIT), truncated: entries.length > TREE_LIMIT }
  }

  async function trees(payload) {
    const paths = Array.isArray(payload.paths) ? payload.paths : []
    if (paths.length === 0) throw badRequest('paths must be a non-empty array')
    if (paths.length > 64) throw badRequest('at most 64 paths per call')
    const levels = []
    for (const path of paths) {
      try {
        levels.push(await tree({ ...payload, path }))
      } catch (error) {
        // One broken level never fails the batch.
        levels.push({ path, entries: [], truncated: false, error: error instanceof Error ? error.message : String(error) })
      }
    }
    return { levels }
  }

  async function read(payload) {
    const scope = await scopeOf(payload)
    const path = inside(scope, payload.path)
    const info = await statOf(scope, path)
    if (info === undefined) throw new SidebarError('not-found', `"${path}" does not exist`, 404)
    if (info.type === 'dir') throw new SidebarError('fs-directory', `"${path}" is a directory`, 400)
    const oversized = info.size > MAX_EDITABLE_BYTES
    const window = oversized ? READ_HEAD_LIMIT : info.size
    const buffer = await readRange(scope, path, 0, window)
    const text = decodeText(buffer)
    const head = buffer.subarray(0, READ_HEAD_LIMIT).toString('base64')
    if (text === null) return { kind: 'binary', size: info.size, mtimeMs: info.mtimeMs, head }
    if (oversized) return { kind: 'too-large', size: info.size, mtimeMs: info.mtimeMs, head }
    return { kind: 'text', content: text, size: info.size, mtimeMs: info.mtimeMs }
  }

  async function readPage(payload) {
    const scope = await scopeOf(payload)
    const path = inside(scope, payload.path)
    const info = await statOf(scope, path)
    if (info === undefined) throw new SidebarError('not-found', `"${path}" does not exist`, 404)
    if (info.type === 'dir') throw new SidebarError('fs-directory', `"${path}" is a directory`, 400)
    const raw = typeof payload.offset === 'number' && Number.isFinite(payload.offset) ? Math.max(0, Math.trunc(payload.offset)) : 0
    const size = info.size
    if (raw >= size) {
      return { kind: 'text', text: '', offset: size, nextOffset: size, eof: true, size, mtimeMs: info.mtimeMs, encoding: 'utf8' }
    }
    const length = Math.min(PAGE_BYTES, size - raw)
    let slice = await readRange(scope, path, raw, length)
    let nextOffset = raw + slice.length
    if (nextOffset < size) {
      const cut = lastLineBreakEnd(slice)
      if (cut > 0) {
        nextOffset = raw + cut
        slice = slice.subarray(0, cut)
      }
    }
    const text = decodeText(slice)
    if (text === null) throw new SidebarError('fs-error', `"${path}" is not text`, 400)
    return { kind: 'text', text, offset: raw, nextOffset, eof: nextOffset >= size, size, mtimeMs: info.mtimeMs, encoding: 'utf8' }
  }

  async function writeText(payload) {
    const scope = await scopeOf(payload)
    const path = inside(scope, payload.path)
    const info = await statOf(scope, path)
    if (info === undefined) throw new SidebarError('not-found', `"${path}" does not exist`, 404)
    if (info.type === 'dir') throw new SidebarError('fs-directory', `"${path}" is a directory`, 400)
    if (typeof payload.expectedMtimeMs === 'number' && Number.isFinite(payload.expectedMtimeMs)) {
      if (Math.floor(info.mtimeMs) !== Math.floor(payload.expectedMtimeMs)) {
        throw new SidebarError('fs-conflict', 'the file changed on disk since it was opened', 409)
      }
    }
    const content = typeof payload.content === 'string' ? payload.content : ''
    if (scope.kind === 'local') await writeFile(path, content, 'utf8')
    else await scope.backend.write({ path, data: content })
    const after = await statOf(scope, path)
    return { path, size: after?.size ?? Buffer.byteLength(content, 'utf8'), mtimeMs: after?.mtimeMs ?? Date.now() }
  }

  async function renameEntry(payload) {
    const scope = await scopeOf(payload)
    const path = inside(scope, payload.path)
    const name = assertSegment(payload.name)
    if (isRoot(scope, path)) throw fsError('cannot rename the workspace root')
    const destination = joinIn(scope, parentOf(scope, path), name)
    if (await statOf(scope, destination) !== undefined) throw fsError(`"${name}" already exists`, 409)
    if (scope.kind === 'local') await rename(path, destination)
    else await scope.backend.rename({ from: path, to: destination })
    return { path: destination }
  }

  async function mkdirEntry(payload) {
    const scope = await scopeOf(payload)
    const dir = inside(scope, payload.path)
    const name = assertSegment(payload.name)
    const destination = joinIn(scope, dir, name)
    if (await statOf(scope, destination) !== undefined) throw fsError(`"${name}" already exists`, 409)
    if (scope.kind === 'local') await mkdir(destination)
    else await scope.backend.mkdir({ path: destination })
    return { path: destination }
  }

  async function createFile(payload) {
    const scope = await scopeOf(payload)
    const dir = inside(scope, payload.path)
    const name = assertSegment(payload.name)
    const destination = joinIn(scope, dir, name)
    if (await statOf(scope, destination) !== undefined) throw fsError(`"${name}" already exists`, 409)
    if (scope.kind === 'local') await writeFile(destination, '', { encoding: 'utf8', flag: 'wx' })
    else await scope.backend.write({ path: destination, data: '' })
    return { path: destination }
  }

  async function removeEntry(payload) {
    const scope = await scopeOf(payload)
    const path = inside(scope, payload.path)
    if (isRoot(scope, path)) throw fsError('cannot remove the workspace root')
    const info = await statOf(scope, path)
    if (info === undefined) throw new SidebarError('not-found', `"${path}" does not exist`, 404)
    if (scope.kind === 'local') {
      if (info.type === 'dir') await rm(path, { recursive: true })
      else await unlink(path)
    } else {
      await scope.backend.remove({ path, recursive: info.type === 'dir' })
    }
    return { path }
  }

  /** Walk one local tree, calling `visit` per entry until it asks to stop. */
  async function walkLocal(root, visit) {
    const queue = [{ dir: root, depth: 0 }]
    let seen = 0
    while (queue.length > 0) {
      const { dir, depth } = queue.shift()
      if (depth > 12) continue
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
      for (const dirent of entries) {
        if (dirent.name.startsWith('.') || SEARCH_SKIP.has(dirent.name)) continue
        const child = win32.join(dir, dirent.name)
        if (dirent.isDirectory()) {
          queue.push({ dir: child, depth: depth + 1 })
          continue
        }
        if (!dirent.isFile()) continue
        seen += 1
        if (seen > SEARCH_FILE_LIMIT) return true
        if (await visit(child)) return true
      }
    }
    return false
  }

  async function search(payload) {
    const scope = await scopeOf(payload)
    const root = inside(scope, payload.path)
    const query = typeof payload.query === 'string' ? payload.query.trim() : ''
    if (query === '') return { matches: [], dirs: [], truncated: false }
    // A query that names one path is answered by stat, exactly like better-sidebar.
    if (/[\\/]/.test(query)) {
      const target = inside(scope, query)
      const info = await statOf(scope, target)
      if (info === undefined) return { matches: [], dirs: [], truncated: false }
      return info.type === 'dir' ? { matches: [target], dirs: [target], truncated: false } : { matches: [target], dirs: [], truncated: false }
    }
    const matches = []
    const toWire = (file) => (scope.kind === 'local' ? win32.relative(root, file).split('\\').join('/') : posix.relative(root, file))
    if (scope.kind === 'local') {
      await walkLocal(root, async (file) => {
        let info
        try {
          info = await fsStat(file)
        } catch {
          return false
        }
        if (info.size > 512 * 1024) return false
        let buffer
        try {
          buffer = await readFile(file)
        } catch {
          return false
        }
        const text = decodeText(buffer)
        if (text === null || !text.includes(query)) return false
        matches.push(toWire(file))
        return matches.length >= DEFAULT_MAX_MATCHES
      })
    } else {
      const needle = query.replace(/'/g, `'\\''`)
      const command = `(command -v rg >/dev/null 2>&1 && rg -l -F -m 1 --no-messages -e '${needle}' -- ${shellArg(root)}) || grep -rlF --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=build -- ${shellArg(query)} ${shellArg(root)} 2>/dev/null`
      const stdout = await run(scope, `${command} | head -n ${DEFAULT_MAX_MATCHES}`)
      for (const line of String(stdout ?? '').split('\n')) {
        const trimmed = line.trim()
        if (trimmed !== '') matches.push(posix.relative(root, trimmed))
      }
    }
    matches.sort()
    return { matches, dirs: [], truncated: matches.length >= DEFAULT_MAX_MATCHES }
  }

  /** Whole file as bytes, for `GET /…/file` (images, PDFs, downloads). */
  async function readAll(payload) {
    const scope = await scopeOf(payload)
    const path = inside(scope, payload.path)
    const info = await statOf(scope, path)
    if (info === undefined) throw new SidebarError('not-found', `"${path}" does not exist`, 404)
    if (info.type === 'dir') throw new SidebarError('fs-directory', `"${path}" is a directory`, 400)
    const buffer = await readRange(scope, path, 0, info.size)
    return { path, buffer, mtimeMs: info.mtimeMs, size: info.size }
  }

  return {
    readAll,
    methods: {
      'fs.tree': tree,
      'fs.trees': trees,
      'fs.read': read,
      'fs.readPage': readPage,
      'fs.search': search,
      'fs.rename': renameEntry,
      'fs.mkdir': mkdirEntry,
      'fs.createFile': createFile,
      'fs.remove': removeEntry,
    },
    writeText,
    invalidate,
    scopeOf,
  }
}

/** HTTP status for a thrown value, defaulting to 500. */
export function statusOf(error) {
  return error instanceof SidebarError ? error.status : 500
}

/** `{ code, message }` for a thrown value, defaulting to `internal`. */
export function wireError(error) {
  if (error instanceof SidebarError) return { code: error.code, message: error.message }
  return { code: 'internal', message: error instanceof Error ? error.message : String(error) }
}

/** A random id for one write, so two clients never collide on a temp name. */
export function tempName() {
  return `.dsh-remote-${randomUUID().slice(0, 8)}.tmp`
}
