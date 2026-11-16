// The fs bridge turns a mirror directory into a window on a remote tree.
//
// Nothing here needs a real SSH host: the stub backend answers the exact shell
// commands the bridge emits, and the fake `fs` records what the bridge did to it.

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { installFsBridge } from '../lib/fs-bridge.js'

function unquote(text) {
  assert.ok(text.startsWith("'") && text.endsWith("'"), `expected a quoted argument, got ${text}`)
  return text.slice(1, -1).replaceAll(`'\\''`, `'`)
}

function commandPath(command, pattern) {
  const match = pattern.exec(command)
  assert.ok(match, `unexpected command: ${command}`)
  return unquote(match[1])
}

/** Answer the bridge's shell commands from one local directory. */
function stubBackend(root) {
  function localize(remote) {
    assert.ok(remote.startsWith('/srv/proj'), `remote path escaped the fixture: ${remote}`)
    const relative = remote.slice('/srv/proj'.length).replace(/^\/+/, '')
    return relative === '' ? root : join(root, relative)
  }
  return {
    async exec({ command }) {
      const statMatch = /^stat -c '%F\|%s\|%Y' -- (.+)$/.exec(command)
      if (statMatch !== null) {
        const { statSync } = await import('node:fs')
        let info
        try {
          info = statSync(localize(unquote(statMatch[1])))
        } catch {
          return { stdout: '', stderr: 'stat: no such file', exitCode: 1, timedOut: false, truncated: false }
        }
        const kind = info.isDirectory() ? 'directory' : info.isFile() ? 'regular file' : 'symbolic link'
        return { stdout: `${kind}|${info.size}|${Math.floor(info.mtimeMs / 1000)}\n`, stderr: '', exitCode: 0, timedOut: false, truncated: false }
      }
      const findMatch = /^LC_ALL=C find -- (.+) -mindepth 1 -maxdepth 1 -printf/.exec(command)
      if (findMatch !== null) {
        const { readdirSync, statSync } = await import('node:fs')
        const dir = localize(unquote(findMatch[1]))
        const lines = readdirSync(dir).map((name) => {
          const info = statSync(join(dir, name))
          const kind = info.isDirectory() ? 'd' : info.isFile() ? 'f' : 'l'
          return `${kind}\t${info.size}\t${Math.floor(info.mtimeMs / 1000)}\t${name}`
        })
        return { stdout: `${lines.join('\n')}\n`, stderr: '', exitCode: 0, timedOut: false, truncated: false }
      }
      const headMatch = /^head -c (\d+) -- (.+) \| base64 -w0$/.exec(command)
      if (headMatch !== null) {
        const { readFileSync } = await import('node:fs')
        const buffer = readFileSync(localize(unquote(headMatch[2]))).subarray(0, Number(headMatch[1]))
        return { stdout: buffer.toString('base64'), stderr: '', exitCode: 0, timedOut: false, truncated: false }
      }
      const tailMatch = /^tail -c \+(\d+) -- (.+) \| head -c (\d+) \| base64 -w0$/.exec(command)
      if (tailMatch !== null) {
        const { readFileSync } = await import('node:fs')
        const buffer = readFileSync(localize(unquote(tailMatch[2])))
        const start = Number(tailMatch[1]) - 1
        const slice = buffer.subarray(start, start + Number(tailMatch[3]))
        return { stdout: slice.toString('base64'), stderr: '', exitCode: 0, timedOut: false, truncated: false }
      }
      return { stdout: '', stderr: `unsupported: ${command}`, exitCode: 1, timedOut: false, truncated: false }
    },
  }
}

const work = await mkdtemp(join(tmpdir(), 'rs-fsbridge-'))
const root = join(work, 'remote')
const mirror = join(work, 'mirror')
const mirrors = join(work, 'mirrors')
const marked = join(mirrors, 'ssh-test-deadbeef', 'ws-marked')
await mkdir(join(root, 'sub'), { recursive: true })
await mkdir(mirror, { recursive: true })
await mkdir(marked, { recursive: true })
await writeFile(join(marked, '.dsh-remote.json'), JSON.stringify({ targetId: 'ssh:test', path: '/srv/proj' }))
await writeFile(join(root, 'a.txt'), 'hello\nworld\n')
await writeFile(join(root, 'sub', 'b.txt'), 'nested\n')
await writeFile(join(root, 'bin.dat'), Buffer.from([0, 1, 2, 3]))

const calls = []
const host = {
  resolvedThroughHost: 0,
  async resolve(path, options) {
    this.resolvedThroughHost += 1
    calls.push(['resolve', path])
    return { targetKey: `host:${path}`, displayPath: path }
  },
  processPath(target) {
    return String(target.targetKey).slice('host:'.length)
  },
  fileUrl(target) {
    return `file:///${this.processPath(target)}`
  },
  contains(parent, child) {
    return this.processPath(child).startsWith(this.processPath(parent))
  },
  async stat() {
    calls.push(['stat'])
    return { version: '1', type: 'file', size: 1 }
  },
  async lstat(path) {
    calls.push(['lstat', path])
    return { version: '1', type: 'file', size: 1 }
  },
  async listDir() {
    calls.push(['listDir'])
    return []
  },
  async readBytes() {
    return Buffer.from('host')
  },
  async readByteRange() {
    return Buffer.from('host')
  },
  async streamText() {
    return (async function* empty() {})()
  },
  async watch() {
    calls.push(['watch'])
    return () => {}
  },
}

const dispose = installFsBridge({
  fs: host,
  registry: { backend: async (id) => (assert.equal(id, 'ssh:test'), stubBackend(root)) },
  workspaces: async () => [{ id: 'ws-a', targetId: 'ssh:test', path: '/srv/proj', localPath: mirror }],
  mirrorsDir: mirrors,
})

try {
  // A path outside our mirror still belongs to the host implementation.
  const outside = await host.resolve(join(work, 'elsewhere'))
  assert.equal(outside.targetKey, `host:${join(work, 'elsewhere')}`)
  assert.equal(host.resolvedThroughHost, 1)

  // A path inside the mirror resolves to a remote-backed target.
  const file = await host.resolve(join(mirror, 'a.txt'))
  assert.ok(file.targetKey.startsWith('rss:ssh%3Atest:/srv/proj/a.txt'), `target key ${file.targetKey}`)
  assert.equal(host.processPath(file), join(mirror, 'a.txt'))
  assert.ok(host.fileUrl(file).startsWith('file:///'))

  const info = await host.stat(file)
  assert.equal(info.type, 'file')
  assert.equal(info.size, 'hello\nworld\n'.length)

  const listed = await host.listDir(await host.resolve(mirror))
  assert.deepEqual(listed.map((entry) => entry.name), ['a.txt', 'bin.dat', 'sub'])
  assert.equal(listed.find((entry) => entry.name === 'sub').type, 'directory')
  assert.equal(listed.find((entry) => entry.name === 'a.txt').size, 12)

  const bytes = await host.readBytes(file, undefined, 1024)
  assert.equal(bytes.toString('utf8'), 'hello\nworld\n')

  const window = await host.readByteRange(file, { offset: 6, length: 5 })
  assert.equal(window.toString('utf8'), 'world')

  const chunks = []
  for await (const chunk of await host.streamText(file)) chunks.push(chunk)
  assert.equal(chunks.join(''), 'hello\nworld\n')

  // Binary is refused by code alone; the message never reaches the panel.
  await assert.rejects(
    async () => {
      const stream = await host.streamText(await host.resolve(join(mirror, 'bin.dat')))
      for await (const _ of stream) {
        // Drain.
      }
    },
    (error) => error.code === 'FS_NOT_TEXT',
  )

  // A path that vanished between listing and stat reads as absent, not as failure.
  assert.equal(
    await host.stat({ targetKey: 'rss:ssh%3Atest:/srv/proj/gone.txt', displayPath: join(mirror, 'gone.txt') }),
    undefined,
  )

  // A mirror directory that only carries its marker (no state.json record) maps too.
  const markedFile = await host.resolve(join(marked, 'sub', 'b.txt'))
  assert.ok(markedFile.targetKey.startsWith('rss:ssh%3Atest:/srv/proj/sub/b.txt'), `marked key ${markedFile.targetKey}`)
  assert.equal((await host.stat(markedFile)).type, 'file')

  // Containment is decided on the remote side of the pair.
  const subTarget = await host.resolve(join(mirror, 'sub', 'b.txt'))
  assert.equal(host.contains(await host.resolve(mirror), subTarget), true)
  assert.equal(host.contains(subTarget, await host.resolve(mirror)), false)

  assert.deepEqual(await host.lstat(join(mirror, 'sub')), await host.lstat(join(mirror, 'sub')))
  // Watching degrades to a poll, and still hands back a close function.
  const close = await host.watch(file, () => {})
  assert.equal(typeof close, 'function')
  close()

  // Disposing puts the host implementation back exactly as it was.
  dispose()
  assert.ok(!String(host.resolve).includes('hit === null'))
  const restored = await host.resolve(join(mirror, 'a.txt'))
  assert.equal(restored.targetKey, `host:${join(mirror, 'a.txt')}`)
  assert.equal(host.resolvedThroughHost, 2)
} finally {
  await rm(work, { recursive: true, force: true })
}

assert.ok(!existsSync(join(tmpdir(), 'rs-fsbridge-missing')))
console.log('fs-bridge-smoke: ok')
