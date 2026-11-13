// API smoke test: exercises the methods the browser half calls, with the local
// backend and a stub registry, so it runs on any machine without WSL or SSH.
//
//     node test/api-smoke.mjs

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createApi } from '../lib/api.js'
import { createLocalBackend } from '../lib/backends/local.js'

const stateFile = path.join(os.tmpdir(), `remote-suite-api-${process.pid}.json`)
process.env.DSH_REMOTE_SUITE_STATE = stateFile
await fs.rm(stateFile, { force: true })

// A config of our own: deleting a `~/.ssh/config` host must hide it without
// touching that file, and the real one on this machine is not ours to edit.
const configFile = path.join(os.tmpdir(), `remote-suite-api-ssh-${process.pid}`)
process.env.DSH_SSH_CONFIG = configFile
await fs.writeFile(configFile, 'Host box\n  HostName 192.0.2.9\n  User tester\n')

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-suite-api-'))
const backend = createLocalBackend()
const registry = {
  listTargets: async () => [{ id: 'local', kind: 'local', label: '此电脑' }],
  backend: async (id) => {
    if (id === 'local') return backend
    throw new Error(`remote: unknown target ${JSON.stringify(id)}`)
  },
}
const api = createApi({ registry })

try {
  await fs.mkdir(path.join(root, 'sub'), { recursive: true })
  await fs.writeFile(path.join(root, 'a.txt'), 'alpha\nbeta\n')
  await fs.writeFile(path.join(root, 'sub', 'b.txt'), 'gamma\n')

  assert.equal((await api.targets()).length, 1)
  console.log('ok  targets')

  // The file picker starts from `home` and walks out through `roots`; on
  // Windows that is the list of drive letters, so a project on D: is reachable
  // even when the host hands us a profile directory as "home".
  const home = await api.home({ target: 'local' })
  assert.equal(typeof home.home, 'string')
  assert.ok(home.home.length > 0)
  const roots = await api.roots()
  assert.ok(Array.isArray(roots) && roots.length > 0)
  for (const root of roots) {
    assert.equal(typeof root.label, 'string')
    assert.ok(path.isAbsolute(root.path))
  }
  if (process.platform === 'win32') {
    assert.ok(roots.some((entry) => /^[A-Z]:\\$/.test(entry.path)), 'a drive root must be listed')
  } else {
    assert.equal(roots[0].path, '/')
  }
  console.log('ok  home + roots')

  const tree = await api.tree({ target: 'local', path: root })
  assert.deepEqual(
    tree.entries.map((e) => `${e.type}:${e.name}`),
    ['dir:sub', 'file:a.txt'],
  )
  console.log('ok  tree')

  const file = await api.read({ target: 'local', path: path.join(root, 'a.txt') })
  assert.equal(file.text, 'alpha\nbeta\n')
  assert.equal(file.size, 11)
  console.log('ok  read')

  const written = await api.write({ target: 'local', path: path.join(root, 'c.txt'), data: 'new\n' })
  assert.equal(written.bytes, 4)
  assert.equal(await fs.readFile(path.join(root, 'c.txt'), 'utf8'), 'new\n')
  console.log('ok  write')

  const info = await api.stat({ target: 'local', path: path.join(root, 'a.txt') })
  assert.equal(info.type, 'file')
  console.log('ok  stat')

  const exec = await api.exec({ target: 'local', command: 'echo hello', workdir: root })
  assert.equal(exec.exitCode, 0)
  assert.match(exec.stdout, /hello/)
  console.log('ok  exec')

  const workspace = await api['workspace-add']({ target: 'local', path: root, name: 'demo' })
  assert.equal(workspace.name, 'demo')
  const relative = await api.read({ workspace: workspace.id, path: 'a.txt' })
  assert.equal(relative.text, 'alpha\nbeta\n')
  const scopedTree = await api.tree({ workspace: workspace.id, path: '.' })
  assert.equal(scopedTree.base, root)
  assert.ok(scopedTree.entries.some((e) => e.name === 'a.txt'))
  console.log('ok  workspace scope')

  await api['workspace-remove']({ workspace: workspace.id })
  assert.equal((await api.workspaces()).length, 0)
  console.log('ok  workspace remove')

  await assert.rejects(() => api.tree({ target: 'nope', path: root }), /unknown target/)
  await assert.rejects(() => api.read({ workspace: 'ws-nope', path: 'a.txt' }), /unknown workspace/)
  console.log('ok  error paths')

  // The add-workspace dialog: a local directory lands on itself, a saved SSH
  // profile is stored with its password reference, and a remote directory gets
  // a local mirror directory to open the DSH workspace on.
  const created = await api['workspace-create']({ target: 'local', path: root })
  assert.equal(created.dshPath, root)
  assert.equal(created.workspace.targetId, 'local')
  assert.ok((await api.workspaces()).some((w) => w.id === created.workspace.id))
  console.log('ok  workspace create (local)')

  const saved = await api['ssh-profile-add']({ alias: 'smoke-ssh', hostname: '192.0.2.1', user: 'tester', port: 2222 })
  assert.equal(saved.hostname, '192.0.2.1')
  assert.equal(saved.source, undefined)
  const listed = await api['ssh-profiles']()
  assert.ok(listed.some((p) => p.alias === 'smoke-ssh' && p.source === 'saved'))
  const removed = await api['ssh-profile-remove']({ alias: 'smoke-ssh' })
  assert.equal(removed.removed, 'smoke-ssh')
  assert.equal(typeof removed.secretRemoved, 'boolean')
  assert.ok(!(await api['ssh-profiles']()).some((p) => p.alias === 'smoke-ssh'))
  await assert.rejects(() => api['ssh-profile-remove']({ alias: 'smoke-ssh' }), /no SSH host named/)
  await assert.rejects(() => api['ssh-profile-add']({ alias: 'bad alias!', hostname: 'x' }), /alias must be/)
  // The alias is an id inside this plugin only, so a Chinese name is a valid
  // alias: it never becomes a `Host` line in ~/.ssh/config.
  const chinese = await api['ssh-profile-add']({ alias: '云服务器', hostname: '192.0.2.2' })
  assert.equal(chinese.alias, '云服务器')
  await api['ssh-profile-remove']({ alias: '云服务器' })
  // A host from `~/.ssh/config` is hidden, not edited: that file belongs to the
  // user, so the plugin only stops offering the alias.
  assert.ok((await api['ssh-profiles']()).some((p) => p.alias === 'box' && p.source === 'config'))
  const hiddenBox = await api['ssh-profile-remove']({ alias: 'box' })
  assert.equal(hiddenBox.source, 'config')
  assert.equal(hiddenBox.hidden, true)
  assert.ok(!(await api['ssh-profiles']()).some((p) => p.alias === 'box'))
  assert.match(await fs.readFile(configFile, 'utf8'), /Host box/)
  console.log('ok  ssh profiles (add / list / remove / hide config host)')

  const remoteRegistry = {
    listTargets: async () => [{ id: 'local', kind: 'local', label: '此电脑' }],
    // Every path on the stand-in target is a directory: this test is about the
    // mirror directory the API creates locally, not about the remote filesystem.
    backend: async () => ({ stat: async () => ({ type: 'dir' }) }),
  }
  const remoteApi = createApi({ registry: remoteRegistry })
  const mirrored = await remoteApi['workspace-create']({ target: 'ssh:box', path: '/srv/app' })
  assert.equal(mirrored.workspace.localPath, mirrored.dshPath)
  assert.ok(path.isAbsolute(mirrored.dshPath))
  assert.ok((await fs.stat(mirrored.dshPath)).isDirectory())
  assert.equal(mirrored.workspace.path, '/srv/app')
  console.log('ok  workspace create (remote mirror)')

  // A WSL directory is a real directory on this machine: the DSH workspace
  // opens on its 9p UNC path, with the POSIX path kept in the state file.
  const wslApi = createApi({
    registry: {
      listTargets: async () => [],
      backend: async () => ({ stat: async () => ({ type: 'dir' }) }),
    },
  })
  const wsl = await wslApi['workspace-create']({ target: 'wsl:Ubuntu', path: '/home/me/project' })
  assert.equal(wsl.dshPath, '\\\\wsl.localhost\\Ubuntu\\home\\me\\project')
  assert.equal(wsl.workspace.localPath, null)
  console.log('ok  workspace create (WSL UNC)')
  // prepare-path is what the host dialog gets: it never records a workspace of
  // its own, it only translates a remote directory into a path DSH can open.
  const preparedLocal = await api['prepare-path']({ target: 'local', path: root })
  assert.equal(preparedLocal.dshPath, root)
  await assert.rejects(() => api['prepare-path']({ target: 'ssh:box', path: '/srv/app' }), /unknown target/)
  const preparedRemote = await remoteApi['prepare-path']({ target: 'ssh:box', path: '/srv/app' })
  assert.ok(path.isAbsolute(preparedRemote.dshPath))
  assert.ok((await fs.stat(preparedRemote.dshPath)).isDirectory())
  const preparedWsl = await wslApi['prepare-path']({ target: 'wsl:Ubuntu', path: '/home/me/project' })
  assert.equal(preparedWsl.dshPath, '\\\\wsl.localhost\\Ubuntu\\home\\me\\project')
  console.log('ok  prepare path (local / remote / WSL)')
} finally {
  await fs.rm(root, { recursive: true, force: true })
  await fs.rm(stateFile, { force: true })
  await fs.rm(configFile, { force: true })
}

console.log('api smoke ok')
