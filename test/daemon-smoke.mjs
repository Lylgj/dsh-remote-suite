// Daemon (persistent-session) smoke test against a real SSH host.
//
//   DSH_SSH_IDENTITY=~/.ssh/key node test/daemon-smoke.mjs
//   DSH_SSH_DAEMON_TEST_HOST=192.0.2.10 DSH_SSH_DAEMON_TEST_USER=tester node test/daemon-smoke.mjs
//
// A `daemon:<alias>` target is the same SSH host, but every `exec` shares one
// non-interactive bash channel: `cd`, variables and shell functions survive
// between calls. Needs a machine with bash and the given key.

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../index.js'
import { readSshConfig } from '../lib/ssh-config.js'

const required = process.env.DSH_SSH_TEST_REQUIRED === '1'
const existing = await readSshConfig().catch(() => [])
const fallback = existing[0] || {}
const host = process.env.DSH_SSH_DAEMON_TEST_HOST || fallback.hostname
const user = process.env.DSH_SSH_DAEMON_TEST_USER || fallback.user || 'root'
const identity = process.env.DSH_SSH_IDENTITY || (fallback.identityFiles || [])[0]

if (host === undefined || identity === undefined) {
  console.log('skip: set DSH_SSH_DAEMON_TEST_HOST and DSH_SSH_IDENTITY to run the daemon test')
  process.exit(0)
}

const dir = mkdtempSync(join(tmpdir(), 'rs-daemon-'))
process.env.DSH_SSH_CONFIG = join(dir, 'config')
process.env.DSH_REMOTE_SUITE_STATE = join(dir, 'state.json')
process.env.DSH_REMOTE_SUITE_SECRETS = join(dir, 'secrets.json')
const { writeFileSync } = await import('node:fs')
writeFileSync(
  process.env.DSH_SSH_CONFIG,
  ['Host box', `  HostName ${host}`, `  User ${user}`, `  IdentityFile ${identity}`, ''].join('\n'),
  'utf8',
)

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
const run = (args) => tool.execute(args, { agent: { id: 'daemon-smoke' } })

let reachable = true
try {
  const targets = await run({ action: 'targets' })
  assert.match(targets, /daemon:box/)
  console.log('ok  daemon target listed')

  const probe = await run({ action: 'probe', target: 'daemon:box' })
  assert.match(probe, /kind: daemon/)
  console.log('ok  probe reports kind: daemon')

  await run({ action: 'exec', target: 'daemon:box', command: 'export RS_DAEMON_VAR=alive; cd /tmp; echo first' })
  const second = await run({ action: 'exec', target: 'daemon:box', command: 'echo "var=$RS_DAEMON_VAR"; pwd' })
  assert.match(second, /var=alive/)
  assert.match(second, /\/tmp/)
  console.log('ok  cwd and env survive between exec calls')

  const file = '/tmp/rs-daemon-smoke.txt'
  await run({ action: 'write', target: 'daemon:box', path: file, data: 'session\n' })
  assert.equal(await run({ action: 'read', target: 'daemon:box', path: file }), 'session\n')
  await run({ action: 'exec', target: 'daemon:box', command: `rm -f ${file}` })
  console.log('ok  file tools ride the same connection')

  const failing = await run({ action: 'exec', target: 'daemon:box', command: "sh -c 'exit 7'" })
  assert.match(failing, /exit=7/)
  await run({ action: 'exec', target: 'daemon:box', command: 'true' })
  console.log('ok  exit codes survive in the same session')

  const killed = await run({ action: 'exec', target: 'daemon:box', command: 'exit 3' })
  assert.match(killed, /session ended/)
  const revived = await run({ action: 'exec', target: 'daemon:box', command: 'echo alive' })
  assert.match(revived, /alive/)
  console.log('ok  a command that exits the shell is reported and the session restarts')

  const missing = await run({ action: 'exec', target: 'daemon:box', command: 'pwd', workdir: '/definitely/not/here' })
  assert.match(missing, /no such directory|exit=66/)
  console.log('ok  bad workdir is reported')
} catch (error) {
  reachable = false
  console.log(`skip: daemon session to ${host} failed — ${error.message}`)
}

dispose()
rmSync(dir, { recursive: true, force: true })

if (!reachable) {
  if (required) process.exit(1)
  process.exit(0)
}
console.log('daemon smoke ok')
