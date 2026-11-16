// Smoke test for lib/sidebar-fs.js: the better-sidebar-shaped file API.
//
// The local half runs against a real temp directory. The remote half runs
// against a stub backend that maps POSIX paths onto a second temp directory and
// answers the one shell command the ranged reader issues
// (`tail -c +N … | head -c L … | base64 -w0`).

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createSidebarFs, SidebarError } from '../lib/sidebar-fs.js'

const root = await mkdtemp(join(tmpdir(), 'rs-sidebar-'))

/** The remote namespace the marker advertises. */
const REMOTE_ROOT = '/srv/app'
const localRoot = join(root, 'local')
const remoteRoot = join(root, 'remote')
const mirrors = join(root, 'mirrors')
const mirrorDir = join(mirrors, 'ssh-demo-01234567', 'ws-demo')

await mkdir(join(localRoot, 'sub'), { recursive: true })
await writeFile(join(localRoot, 'a.txt'), 'hello\nworld\n', 'utf8')
await writeFile(join(localRoot, 'sub', 'b.txt'), 'needle here\n', 'utf8')
await writeFile(join(localRoot, 'bin.dat'), Buffer.from([0, 1, 2, 3]))

await mkdir(join(remoteRoot, 'sub'), { recursive: true })
await writeFile(join(remoteRoot, 'r.txt'), 'remote needle\n', 'utf8')
await mkdir(mirrorDir, { recursive: true })
await writeFile(join(mirrorDir, '.dsh-remote.json'), JSON.stringify({ targetId: 'ssh:demo', path: REMOTE_ROOT }), 'utf8')

// A workspace saved with a `~` path. The tree must come back absolute: a
// `~`-rooted path cannot be joined or compared, so every later navigation
// would be rejected as "outside this workspace".
const HOME_ROOT = '/home/demo/project'
const homeMirror = join(mirrors, 'ssh-home-abcdef', 'ws-home')
await mkdir(homeMirror, { recursive: true })
await writeFile(join(homeMirror, '.dsh-remote.json'), JSON.stringify({ targetId: 'ssh:home', path: '~/project' }), 'utf8')

/** Map one advertised POSIX path onto the temp directory that stands for it. */
function remotePath(value, base = REMOTE_ROOT) {
  const normalized = String(value).replace(/\\/g, '/').replace(/\/+$/, '')
  if (normalized !== base && !normalized.startsWith(`${base}/`)) throw new Error(`outside remote root: ${value}`)
  return join(remoteRoot, normalized.slice(base.length))
}

const remoteBackend = {
  async stat({ path }) {
    const { stat } = await import('node:fs/promises')
    try {
      const info = await stat(remotePath(path))
      return {
        type: info.isDirectory() ? 'dir' : 'file',
        size: info.size,
        mtimeMs: info.mtimeMs,
      }
    } catch {
      throw new Error('ENOENT')
    }
  },
  async list({ path }) {
    const { readdir } = await import('node:fs/promises')
    const dir = remotePath(path)
    const dirents = await readdir(dir, { withFileTypes: true })
    return {
      entries: dirents.map((dirent) => ({ name: dirent.name, type: dirent.isDirectory() ? 'dir' : 'file', size: 0 })),
      truncated: false,
    }
  },
  async write({ path, data }) {
    await writeFile(remotePath(path), data, 'utf8')
    return { bytes: Buffer.byteLength(data, 'utf8') }
  },
  async mkdir({ path }) {
    await mkdir(remotePath(path))
    return { path }
  },
  async rename({ from, to }) {
    const { rename } = await import('node:fs/promises')
    await rename(remotePath(from), remotePath(to))
    return { from, to }
  },
  async remove({ path }) {
    const { rm } = await import('node:fs/promises')
    await rm(remotePath(path), { recursive: true, force: true })
    return { path }
  },
  async exec({ command }) {
    // The only command the ranged reader issues.
    const match = /tail -c \+(\d+) -- '([^']*)' \| head -c (\d+) \| base64 -w0/.exec(command)
    if (match === null) return { stdout: '', stderr: `unsupported: ${command}`, exitCode: 1, timedOut: false, truncated: false }
    const start = Number(match[1]) - 1
    const length = Number(match[3])
    try {
      const buffer = await readFile(remotePath(match[2]))
      return { stdout: buffer.subarray(start, start + length).toString('base64'), stderr: '', exitCode: 0, timedOut: false, truncated: false }
    } catch (error) {
      return { stdout: '', stderr: String(error), exitCode: 1, timedOut: false, truncated: false }
    }
  },
}

/** The same content addressed from `$HOME/project`, to exercise `~` markers. */
function rebase(value) {
  const normalized = String(value).replace(/\\/g, '/')
  return REMOTE_ROOT + normalized.slice(HOME_ROOT.length)
}

const homeBackend = {
  async home() {
    return '/home/demo'
  },
  stat: ({ path }) => remoteBackend.stat({ path: rebase(path) }),
  list: ({ path }) => remoteBackend.list({ path: rebase(path) }),
  write: ({ path, data }) => remoteBackend.write({ path: rebase(path), data }),
  mkdir: ({ path }) => remoteBackend.mkdir({ path: rebase(path) }),
  rename: ({ from, to }) => remoteBackend.rename({ from: rebase(from), to: rebase(to) }),
  remove: ({ path }) => remoteBackend.remove({ path: rebase(path) }),
  async exec({ command }) {
    if (command === 'printf %s "$HOME"') {
      return { stdout: '/home/demo', stderr: '', exitCode: 0, timedOut: false, truncated: false }
    }
    return remoteBackend.exec({ command: command.replaceAll(HOME_ROOT, REMOTE_ROOT) })
  },
}

const fs = createSidebarFs({
  registry: {
    async backend(id) {
      if (id === 'ssh:demo') return remoteBackend
      if (id === 'ssh:home') return homeBackend
      throw new Error(`unknown target ${id}`)
    },
  },
  mirrorsDir: mirrors,
  sessionCwd: async (sessionId) =>
    sessionId === 's-remote'
      ? mirrorDir
      : sessionId === 's-home'
        ? homeMirror
        : localRoot,
})

// --- local -----------------------------------------------------------------

const tree = await fs.methods['fs.tree']({ sessionId: 's-local' })
assert.equal(tree.path, localRoot)
assert.deepEqual(tree.entries.map((entry) => entry.name), ['sub', 'a.txt', 'bin.dat'])
assert.equal(tree.entries[0].isDir, true)
assert.equal(tree.entries[1].isDir, false)
assert.equal(tree.entries[1].hidden, false)

const sub = await fs.methods['fs.tree']({ sessionId: 's-local', path: join(localRoot, 'sub') })
assert.deepEqual(sub.entries.map((entry) => entry.name), ['b.txt'])

const text = await fs.methods['fs.read']({ sessionId: 's-local', path: join(localRoot, 'a.txt') })
assert.deepEqual(text, { kind: 'text', content: 'hello\nworld\n', size: 12, mtimeMs: text.mtimeMs })

const binary = await fs.methods['fs.read']({ sessionId: 's-local', path: join(localRoot, 'bin.dat') })
assert.equal(binary.kind, 'binary')
assert.equal(binary.head, Buffer.from([0, 1, 2, 3]).toString('base64'))

const page = await fs.methods['fs.readPage']({ sessionId: 's-local', path: join(localRoot, 'a.txt') })
assert.equal(page.text, 'hello\nworld\n')
assert.equal(page.nextOffset, 12)
assert.equal(page.eof, true)

const searched = await fs.methods['fs.search']({ sessionId: 's-local', query: 'needle' })
assert.deepEqual(searched.matches, ['sub/b.txt'])

const created = await fs.methods['fs.createFile']({ sessionId: 's-local', path: localRoot, name: 'new.txt' })
assert.equal(created.path, join(localRoot, 'new.txt'))
await assert.rejects(fs.methods['fs.createFile']({ sessionId: 's-local', path: localRoot, name: 'new.txt' }), (error) => {
  assert.ok(error instanceof SidebarError)
  assert.equal(error.code, 'fs-error')
  return true
})

const madeDir = await fs.methods['fs.mkdir']({ sessionId: 's-local', path: localRoot, name: 'made' })
assert.equal(madeDir.path, join(localRoot, 'made'))

const renamed = await fs.methods['fs.rename']({ sessionId: 's-local', path: join(localRoot, 'new.txt'), name: 'renamed.txt' })
assert.equal(renamed.path, join(localRoot, 'renamed.txt'))

const written = await fs.writeText({ sessionId: 's-local', path: join(localRoot, 'renamed.txt'), content: 'fresh body\n' })
assert.equal(await readFile(join(localRoot, 'renamed.txt'), 'utf8'), 'fresh body\n')
await assert.rejects(
  fs.writeText({ sessionId: 's-local', path: join(localRoot, 'renamed.txt'), content: 'stale', expectedMtimeMs: Math.floor(written.mtimeMs) - 5000 }),
  (error) => {
    assert.equal(error.code, 'fs-conflict')
    assert.equal(error.status, 409)
    return true
  },
)

await fs.methods['fs.remove']({ sessionId: 's-local', path: join(localRoot, 'made') })
await assert.rejects(fs.methods['fs.tree']({ sessionId: 's-local', path: join(localRoot, 'made') }), (error) => {
  assert.equal(error.code, 'not-found')
  assert.equal(error.status, 404)
  return true
})

// Escaping the workspace is refused, not silently clamped.
await assert.rejects(fs.methods['fs.read']({ sessionId: 's-local', path: join(root, 'outside.txt') }), (error) => {
  assert.equal(error.code, 'bad-request')
  return true
})
await assert.rejects(fs.methods['fs.mkdir']({ sessionId: 's-local', path: localRoot, name: '..' }), (error) => {
  assert.equal(error.code, 'bad-request')
  return true
})

// --- remote ----------------------------------------------------------------

const remoteTree = await fs.methods['fs.tree']({ sessionId: 's-remote' })
assert.equal(remoteTree.path, REMOTE_ROOT)
assert.deepEqual(remoteTree.entries.map((entry) => entry.name), ['sub', 'r.txt'])

// A `~`-rooted marker is expanded against the remote home before anything is
// compared, so the returned paths are absolute and the next call still works.
const homeTree = await fs.methods['fs.tree']({ sessionId: 's-home' })
assert.equal(homeTree.path, HOME_ROOT)
assert.deepEqual(homeTree.entries.map((entry) => entry.name), ['sub', 'r.txt'])
assert.deepEqual(
  homeTree.entries.map((entry) => entry.path),
  [`${HOME_ROOT}/sub`, `${HOME_ROOT}/r.txt`],
)
const homeChild = await fs.methods['fs.tree']({ sessionId: 's-home', path: `${HOME_ROOT}/sub` })
assert.equal(homeChild.entries.length, 0)
await assert.rejects(fs.methods['fs.tree']({ sessionId: 's-home', path: '/home/demo' }), (error) => {
  assert.equal(error.code, 'bad-request')
  return true
})

const remoteText = await fs.methods['fs.read']({ sessionId: 's-remote', path: `${REMOTE_ROOT}/r.txt` })
assert.equal(remoteText.kind, 'text')
assert.equal(remoteText.content, 'remote needle\n')

// better-sidebar labels the tab with the mirror directory and builds child
// paths from it, so a Windows path inside the mirror must resolve to the
// remote file it mirrors instead of being appended to the remote root.
const mirrorRead = await fs.methods['fs.read']({ sessionId: 's-remote', path: `${mirrorDir}\\r.txt` })
assert.equal(mirrorRead.kind, 'text')
assert.equal(mirrorRead.content, 'remote needle\n')
// A caller that names the mirror gets mirror paths back, so its own cache
// (keyed by the names it asked for) keeps hitting instead of re-fetching.
const mirrorTree = await fs.methods['fs.tree']({ sessionId: 's-remote', path: `${mirrorDir}\\sub` })
assert.equal(mirrorTree.path, `${mirrorDir}\\sub`)
const mirrorRootTree = await fs.methods['fs.tree']({ sessionId: 's-remote', path: mirrorDir })
assert.equal(mirrorRootTree.path, mirrorDir)
assert.deepEqual(mirrorRootTree.entries.map((entry) => entry.path), [`${mirrorDir}\\sub`, `${mirrorDir}\\r.txt`])
const cwdInfo = await fs.methods['session.cwd']({ sessionId: 's-remote' })
assert.equal(cwdInfo.cwd, mirrorDir)
assert.equal(cwdInfo.root, 'ws-demo')
assert.equal(typeof cwdInfo.parent, 'string')
console.log('ok  mirror paths resolve to their remote files')

const remotePage = await fs.methods['fs.readPage']({ sessionId: 's-remote', path: `${REMOTE_ROOT}/r.txt` })
assert.equal(remotePage.text, 'remote needle\n')

const remoteWrite = await fs.writeText({ sessionId: 's-remote', path: `${REMOTE_ROOT}/r.txt`, content: 'rewritten\n' })
assert.equal(typeof remoteWrite.mtimeMs, 'number')
assert.equal(await readFile(join(remoteRoot, 'r.txt'), 'utf8'), 'rewritten\n')

const remoteCreated = await fs.methods['fs.createFile']({ sessionId: 's-remote', path: REMOTE_ROOT, name: 'x.txt' })
assert.equal(remoteCreated.path, `${REMOTE_ROOT}/x.txt`)

const remoteRemoved = await fs.methods['fs.remove']({ sessionId: 's-remote', path: `${REMOTE_ROOT}/x.txt` })
assert.equal(remoteRemoved.path, `${REMOTE_ROOT}/x.txt`)

// A remote path outside the workspace is refused too.
await assert.rejects(fs.methods['fs.read']({ sessionId: 's-remote', path: '/etc/passwd' }), (error) => {
  assert.equal(error.code, 'bad-request')
  return true
})

// --- exclude patterns -------------------------------------------------------
const withoutSub = await fs.methods['fs.tree']({ sessionId: 's-remote', exclude: ['sub'] })
assert.deepEqual(withoutSub.entries.map((entry) => entry.name), ['r.txt'])
const withoutText = await fs.methods['fs.tree']({ sessionId: 's-remote', exclude: ['*.txt'] })
assert.deepEqual(withoutText.entries.map((entry) => entry.name), ['sub'])

// --- upload ---------------------------------------------------------------
const uploadBytes = Buffer.from([0x00, 0x01, 0xfe, 0xff])
const localUpload = await fs.upload({
  sessionId: 's-local',
  dir: localRoot,
  relativePath: 'nested/deep/up.bin',
  data: uploadBytes,
})
assert.equal(localUpload.path, join(localRoot, 'nested', 'deep', 'up.bin'))
assert.deepEqual(await readFile(localUpload.path), uploadBytes)

const remoteUpload = await fs.upload({
  sessionId: 's-remote',
  dir: REMOTE_ROOT,
  relativePath: 'up.txt',
  data: Buffer.from('uploaded\n', 'utf8'),
})
assert.equal(remoteUpload.path, `${REMOTE_ROOT}/up.txt`)
assert.equal(await readFile(join(remoteRoot, 'up.txt'), 'utf8'), 'uploaded\n')

// The upload directory itself must not be escapable.
for (const relativePath of ['../escape.txt', '/absolute.txt', 'a/../../escape.txt']) {
  await assert.rejects(
    fs.upload({ sessionId: 's-local', dir: localRoot, relativePath, data: Buffer.from('x') }),
    (error) => {
      assert.equal(error.code, 'bad-request')
      return true
    },
  )
}

// --- listing cache + invalidation -----------------------------------------
await fs.methods['fs.tree']({ sessionId: 's-local' })
const cachedCreate = await fs.methods['fs.createFile']({ sessionId: 's-local', path: localRoot, name: 'cache-probe.txt' })
assert.equal(cachedCreate.path, join(localRoot, 'cache-probe.txt'))
const afterCreate = await fs.methods['fs.tree']({ sessionId: 's-local' })
assert.ok(afterCreate.entries.some((entry) => entry.name === 'cache-probe.txt'), 'a mutation must invalidate the listing cache')

// --- watch digest ---------------------------------------------------------
const digestBefore = await fs.digest({ sessionId: 's-local', path: localRoot })
await writeFile(join(localRoot, 'digest-probe.txt'), 'x', 'utf8')
const digestAfter = await fs.digest({ sessionId: 's-local', path: localRoot })
assert.notEqual(digestBefore.digest, digestAfter.digest, 'a new entry must move the digest')

await rm(root, { recursive: true, force: true })
console.log('sidebar-fs smoke: ok')
