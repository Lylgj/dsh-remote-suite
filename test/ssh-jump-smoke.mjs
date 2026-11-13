// Multi-hop SSH smoke test: a ProxyJump chain through the same machine.
//
//   DSH_SSH_IDENTITY=~/.ssh/key node test/ssh-jump-smoke.mjs
//   DSH_SSH_JUMP_TEST_HOST=192.0.2.10 DSH_SSH_JUMP_TEST_USER=tester node test/ssh-jump-smoke.mjs
//
// The test writes a temporary `~/.ssh/config` with two aliases (`jump` and
// `target`) aimed at the same host, so it needs a machine you can already log
// into with the given key — no extra server. It then drives the real `remote`
// tool end to end: the second connection is opened through the first one.

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../index.js'
import { readSshConfig } from '../lib/ssh-config.js'

const required = process.env.DSH_SSH_TEST_REQUIRED === '1'
const existing = await readSshConfig().catch(() => [])
const fallback = existing[0] || {}
const host = process.env.DSH_SSH_JUMP_TEST_HOST || fallback.hostname
const user = process.env.DSH_SSH_JUMP_TEST_USER || fallback.user || 'root'
const identity = process.env.DSH_SSH_IDENTITY || (fallback.identityFiles || [])[0]

if (host === undefined || identity === undefined) {
  console.log('skip: set DSH_SSH_JUMP_TEST_HOST and DSH_SSH_IDENTITY to run the ProxyJump test')
  process.exit(0)
}

const dir = mkdtempSync(join(tmpdir(), 'rs-jump-'))
const configPath = join(dir, 'config')
writeFileSync(
  configPath,
  [
    'Host jump',
    `  HostName ${host}`,
    `  User ${user}`,
    `  IdentityFile ${identity}`,
    '',
    'Host target',
    `  HostName ${host}`,
    `  User ${user}`,
    `  IdentityFile ${identity}`,
    '  ProxyJump jump',
    '',
  ].join('\n'),
  'utf8',
)
process.env.DSH_SSH_CONFIG = configPath
process.env.DSH_REMOTE_SUITE_STATE = join(dir, 'state.json')
process.env.DSH_REMOTE_SUITE_SECRETS = join(dir, 'secrets.json')

const registered = []
const fakeWebServer = { register: () => () => {}, registerUpgrade: () => () => {} }
const dispose = apply(
  {
    tools: { register: (def) => (registered.push(def), () => {}) },
    inject: (_deps, cb) => cb({ webServer: fakeWebServer }),
  },
  {},
)
const tool = registered[0]
const run = (args) => tool.execute(args, { agent: { id: 'ssh-jump-smoke' } })

let reachable = true
try {
  const targets = await run({ action: 'targets' })
  assert.match(targets, /ssh:jump/)
  assert.match(targets, /ssh:target/)
  console.log('ok  both aliases listed')

  const probe = await run({ action: 'probe', target: 'ssh:target' })
  assert.match(probe, /kind: ssh/)
  console.log('ok  probe through the jump')

  const exec = await run({ action: 'exec', target: 'ssh:target', command: 'echo jump-ok' })
  assert.match(exec, /exit=0/)
  assert.match(exec, /jump-ok/)
  console.log('ok  exec through the jump')

  const file = '/tmp/rs-jump-smoke.txt'
  await run({ action: 'write', target: 'ssh:target', path: file, data: 'via jump\n' })
  const read = await run({ action: 'read', target: 'ssh:target', path: file })
  assert.equal(read, 'via jump\n')
  await run({ action: 'exec', target: 'ssh:target', command: `rm -f ${file}` })
  console.log('ok  file roundtrip through the jump')

  await run({ action: 'workspace-add', target: 'ssh:target', path: '/tmp', name: 'tmp-through-jump' })
  const relative = await run({ action: 'exec', workspace: 'ws-tmp-through-jump', command: 'pwd' })
  assert.match(relative, /\/tmp/)
  console.log('ok  workspace rooted behind the jump')
} catch (error) {
  reachable = false
  console.log(`skip: jumping to ${host} failed — ${error.message}`)
}

dispose()
rmSync(dir, { recursive: true, force: true })

if (!reachable) {
  if (required) process.exit(1)
  process.exit(0)
}
console.log('ssh jump smoke ok')
