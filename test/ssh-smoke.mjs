// SSH backend smoke test.
//
//   node test/ssh-smoke.mjs                       # auto-pick the first ~/.ssh/config alias
//   DSH_SSH_TEST_TARGET=host node test/ssh-smoke.mjs
//   DSH_SSH_IDENTITY=D:\\.ssh\\key node test/ssh-smoke.mjs
//   DSH_SSH_TEST_REQUIRED=1 ...                   # fail instead of skipping when unreachable
//
// Set DSH_SSH_TEST_REQUIRED=1 in CI; without it an unreachable host prints
// "skip" and exits 0 so the file does not break offline runs.

process.env.DSH_REMOTE_SUITE_STATE = process.env.DSH_REMOTE_SUITE_STATE
  || `${process.env.TEMP || process.env.TMPDIR || '/tmp'}/remote-suite-ssh-${process.pid}.json`

import assert from 'node:assert/strict'

import { apply } from '../index.js'
import { readSshConfig } from '../lib/ssh-config.js'

const required = process.env.DSH_SSH_TEST_REQUIRED === '1'

const profiles = await readSshConfig()
if (profiles.length === 0) {
  console.log('skip: no SSH profiles in ~/.ssh/config')
  process.exit(0)
}

const alias = process.env.DSH_SSH_TEST_TARGET || profiles[0].alias
const targetId = `ssh:${alias}`

const registered = []
const fakeWebServer = {
  register: () => () => {},
  registerUpgrade: () => () => {},
}
const dispose = apply(
  {
    tools: { register: (def) => (registered.push(def), () => {}) },
    inject: (_deps, cb) => cb({ webServer: fakeWebServer }),
  },
  {},
)
const tool = registered[0]
const run = (args) => tool.execute(args, { agent: { id: 'ssh-smoke' } })

let reachable = true
try {
  const probe = await run({ action: 'probe', target: targetId })
  console.log(probe.split('\n').slice(0, 3).join(' | '))
} catch (error) {
  reachable = false
  console.log(`skip: ${targetId} unreachable — ${error.message}`)
  if (required) process.exit(1)
  process.exit(0)
}

const targets = await run({ action: 'targets' })
assert.match(targets, new RegExp(`ssh:${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\tssh\\t`))
console.log('ok  target listed')

const out = await run({ action: 'exec', target: targetId, command: 'uname -s && echo smoke-ok' })
assert.match(out, /exit=0/)
assert.match(out, /Linux|Darwin/)
assert.match(out, /smoke-ok/)
console.log('ok  exec')

const failing = await run({ action: 'exec', target: targetId, command: 'echo boom 1>&2 && exit 4' })
assert.match(failing, /exit=4/)
assert.match(failing, /boom/)
console.log('ok  exec failure surface')

assert.match(await run({ action: 'exec', target: targetId, workdir: '~', command: 'pwd' }), /^\S*\/(home|Users)\//m)
console.log('ok  ~ expansion in workdir')

const dir = `/tmp/remote-suite-ssh-${process.pid}`
await run({ action: 'write', target: targetId, path: `${dir}/a.txt`, data: 'hello ssh\nsecond line\n' })
assert.match(await run({ action: 'read', target: targetId, path: `${dir}/a.txt` }), /second line/)
assert.equal(await run({ action: 'read', target: targetId, path: `${dir}/a.txt`, offset: 1, limit: 1 }), 'hello ssh')
assert.match(await run({ action: 'stat', target: targetId, path: `${dir}/a.txt` }), /file \d+ bytes/)
assert.match(await run({ action: 'list', target: targetId, path: dir }), /a\.txt/)
console.log('ok  file roundtrip + read window')

await run({ action: 'edit', target: targetId, path: `${dir}/a.txt`, old: 'hello ssh', new: 'hello remote' })
assert.match(await run({ action: 'read', target: targetId, path: `${dir}/a.txt` }), /hello remote/)
console.log('ok  edit')

await run({ action: 'write', target: targetId, path: `${dir}/sub/b.md`, data: 'needle in markdown\n' })
const grep = await run({ action: 'grep', target: targetId, path: dir, pattern: 'needle' })
assert.match(grep, /b\.md:1:/)
const scoped = await run({ action: 'grep', target: targetId, path: dir, pattern: 'needle', glob: '**/*.md' })
assert.match(scoped, /b\.md/)
console.log('ok  grep + glob filter')

const glob = await run({ action: 'glob', target: targetId, root: dir, pattern: '**/*.md' })
assert.match(glob, /sub\/b\.md|b\.md/)
console.log('ok  glob')

const added = await run({ action: 'workspace-add', target: targetId, path: dir, name: 'ssh-smoke' })
const workspaceId = added.split(' ')[1]
assert.match(added, /^added ws-ssh-smoke /)
assert.equal(await run({ action: 'read', workspace: workspaceId, path: 'a.txt' }), 'hello remote\nsecond line\n')
assert.match(await run({ action: 'exec', workspace: workspaceId, command: 'pwd' }), new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
await run({ action: 'workspace-remove', workspace: workspaceId })
console.log('ok  workspace relative paths + default cwd')

await run({ action: 'exec', target: targetId, command: `rm -rf ${dir}` })
if (typeof dispose === 'function') dispose()
console.log('ssh smoke ok')
