// Mirror sync: keep a local copy of a remote directory.
//
// Why a mirror at all: the editor and search in the workspace view work on the
// local side by design, and some tooling (git, language servers) wants real
// files. The mirror is opt-in per directory — nothing is copied unless the user
// asks for a mirror.
//
// Transport: every backend can run a shell, so the copy is `dd | base64` over
// `exec` in both directions. That is binary-safe and needs no extra binary on
// the remote side; it is slower than tar, which is why the walk is capped and
// unchanged files (same size, same mtime within 2s) are skipped.
//
// Write-back safety: `pull` never deletes local files; `push` refuses to
// overwrite a remote file that is newer than the local copy unless `force`.

import { promises as fsp } from 'node:fs'
import { dirname, join } from 'node:path'

import { walkFiles, toPosix, globToRegExp } from './fs-util.js'

const CHUNK_BYTES = 32 * 1024
const MAX_FILES = 20_000
const MTIME_SLACK_MS = 2000

function shq(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

function localRoot(backendId) {
  return backendId === 'local'
}

async function listRemote(backend, root) {
  const command =
    `cd ${shq(root)} && find . -type f -not -path './.git/*' -not -path './node_modules/*'` +
    ` -print | head -n ${MAX_FILES}`
  const result = await backend.exec({ command, timeoutMs: 120_000 })
  if (result.exitCode !== 0) {
    throw new Error(`remote: cannot list ${root}: ${result.stderr.trim() || `exit ${result.exitCode}`}`)
  }
  const files = new Map()
  for (const line of result.stdout.split(/\r?\n/)) {
    const rel = line.replace(/^\.\//, '')
    if (rel === '') continue
    files.set(rel, null)
  }
  return files
}

async function statRemote(backend, path) {
  try {
    const stat = await backend.stat({ path })
    return stat.type === 'file' ? { size: stat.size, mtimeMs: stat.mtimeMs ?? 0 } : null
  } catch {
    return null
  }
}

async function readRemoteBinary(backend, path, size) {
  const parts = []
  let offset = 0
  while (offset < size) {
    const result = await backend.exec({
      command: `dd if=${shq(path)} bs=${CHUNK_BYTES} skip=${offset / CHUNK_BYTES} count=1 2>/dev/null | base64 | tr -d '\\n'`,
      timeoutMs: 60_000,
    })
    if (result.exitCode !== 0) throw new Error(`remote: cannot read ${path}: ${result.stderr.trim()}`)
    parts.push(Buffer.from(result.stdout.trim(), 'base64'))
    offset += CHUNK_BYTES
  }
  return Buffer.concat(parts)
}

async function writeRemoteBinary(backend, path, buffer) {
  await backend.exec({
    command: `mkdir -p "$(dirname ${shq(path)})" && : > ${shq(path)}`,
    timeoutMs: 60_000,
  })
  for (let offset = 0; offset < buffer.length; offset += CHUNK_BYTES) {
    const chunk = buffer.subarray(offset, offset + CHUNK_BYTES).toString('base64')
    const result = await backend.exec({
      command: `printf %s ${shq(chunk)} | base64 -d >> ${shq(path)}`,
      timeoutMs: 60_000,
    })
    if (result.exitCode !== 0) throw new Error(`remote: cannot write ${path}: ${result.stderr.trim()}`)
  }
}

async function readLocal(path) {
  return fsp.readFile(path)
}

async function writeLocal(path, buffer) {
  await fsp.mkdir(dirname(path), { recursive: true })
  await fsp.writeFile(path, buffer)
}

async function statLocal(path) {
  try {
    const stat = await fsp.stat(path)
    return stat.isFile() ? { size: stat.size, mtimeMs: stat.mtimeMs } : null
  } catch {
    return null
  }
}

async function listLocal(root, skip) {
  const files = new Map()
  for await (const file of walkFiles(root, { maxFiles: MAX_FILES })) {
    if (skip.test(file.rel)) continue
    files.set(toPosix(file.rel), null)
  }
  return files
}/** Pull remote → local. Never deletes local files. */
export async function pullMirror(registry, mirror, options = {}) {
  const { force = false, dryRun = false } = options
  const backend = await registry.backend(mirror.targetId)
  const report = { direction: 'pull', copied: [], skipped: 0, bytes: 0 }
  const remote = await listRemote(backend, mirror.remotePath)
  const isLocal = localRoot(mirror.targetId)

  for (const rel of remote.keys()) {
    const remotePath = isLocal
      ? join(mirror.remotePath, ...rel.split('/'))
      : `${mirror.remotePath.replace(/[\\/]+$/, '')}/${rel}`
    const remoteStat = await statRemote(backend, remotePath)
    if (remoteStat === null) continue
    const localPath = join(mirror.localPath, ...rel.split('/'))
    const localStat = await statLocal(localPath)

    if (
      !force &&
      localStat !== null &&
      localStat.size === remoteStat.size &&
      Math.abs(localStat.mtimeMs - remoteStat.mtimeMs) < MTIME_SLACK_MS
    ) {
      report.skipped += 1
      continue
    }

    report.copied.push(rel)
    report.bytes += remoteStat.size
    if (dryRun) continue

    const buffer = isLocal
      ? await fsp.readFile(remotePath)
      : remoteStat.size > 0
        ? await readRemoteBinary(backend, remotePath, remoteStat.size)
        : Buffer.alloc(0)
    await writeLocal(localPath, buffer)
    await fsp.utimes(localPath, new Date(remoteStat.mtimeMs), new Date(remoteStat.mtimeMs)).catch(() => {})
  }
  return report
}

/** Push local → remote. Refuses to clobber a newer remote file unless forced. */
export async function pushMirror(registry, mirror, options = {}) {
  const { force = false, dryRun = false } = options
  const backend = await registry.backend(mirror.targetId)
  const report = { direction: 'push', copied: [], skipped: 0, conflicts: [], bytes: 0 }
  const skip = globToRegExp('**/node_modules/**')
  const local = await listLocal(mirror.localPath, skip)

  for (const rel of local.keys()) {
    const localPath = join(mirror.localPath, ...rel.split('/'))
    const localStat = await statLocal(localPath)
    if (localStat === null) continue
    const remotePath = `${mirror.remotePath.replace(/[\\/]+$/, '')}/${rel}`
    const remoteStat = await statRemote(backend, remotePath)

    if (
      !force &&
      remoteStat !== null &&
      Math.abs(remoteStat.size - localStat.size) < 1 &&
      Math.abs(remoteStat.mtimeMs - localStat.mtimeMs) < MTIME_SLACK_MS
    ) {
      report.skipped += 1
      continue
    }
    if (!force && remoteStat !== null && remoteStat.mtimeMs > localStat.mtimeMs + MTIME_SLACK_MS) {
      report.conflicts.push(rel)
      continue
    }

    report.copied.push(rel)
    report.bytes += localStat.size
    if (dryRun) continue

    const buffer = await readLocal(localPath)
    await writeRemoteBinary(backend, remotePath, buffer)
  }
  return report
}

export function describeMirror(mirror) {
  return `${mirror.id}\t${mirror.targetId}\t${mirror.remotePath} → ${mirror.localPath}`
}
