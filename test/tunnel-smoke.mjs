// Tunnel smoke test: forwards a real remote HTTP server to loopback.
//
//   DSH_SSH_IDENTITY=~/.ssh/key node test/tunnel-smoke.mjs
//
// Starts `python3 -m http.server` on the SSH host (in the `daemon:` session so it
// detaches), then proves the tunnel serves it locally and that closing the
// tunnel really closes it. Skips when the host or python3 is unavailable.

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../index.js'
import { readSshConfig } from '../lib/ssh-config.js'

const required = process.env.DSH_SSH_TEST_REQUIRED === '1'
const existing = await readSshConfig().catch(() => [])
const fallback = existing[0] || {}
const host = process.env.DSH_SSH_TEST_HOST || fallback.hostname
const user = process.env.DSH_SSH_TEST_USER || fallback.user || 'root'
const identity = process.env.DSH_SSH_IDENTITY || (fallback.identityFiles || [])[0]

if (host === undefined || identity === undefined) {
  console.log('skip: set DSH_SSH_TEST_HOST and DSH_SSH_IDENTITY to run the tunnel test')
  process.exit(0)
}

const dir = mkdtempSync(join(tmpdir(), 'rs-tunnel-'))
process.env.DSH_SSH_CONFIG = join(dir, 'config')
process.env.DSH_REMOTE_SUITE_STATE = join(dir, 'state.json')
process.env.DSH_REMOTE_SUITE_SECRETS = join(dir, 'secrets.json')
writeFileSync(
  process.env.DSH_SSH_CONFIG,
  ['Host tunnelbox', `  HostName ${host}`, `  User ${user}`, `  IdentityFile ${identity}`, ''].join('\n'),
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
const run = (args) => tool.execute(args, { agent: { id: 'tunnel-smoke' } })

const port = 20000 + Math.floor(Math.random() * 20000)
const remoteDir = '/tmp/rs-tunnel-smoke'
let tunnelInfo = null
let started = false

try {
  await run({ action: 'exec', target: 'daemon:tunnelbox', command: `mkdir -p ${remoteDir} && printf 'tunnel ok\\n' > ${remoteDir}/index.html && true` })
  await run({
    action: 'exec',
    target: 'daemon:tunnelbox',
    command: `pkill -f "http.server ${port}" 2>/dev/null; cd ${remoteDir} && nohup python3 -m http.server ${port} >/tmp/rs-tunnel.log 2>&1 & sleep 0.5; echo started`,
  })
  started = true

  const backend = await (await import('../lib/backends/index.js')).createRegistry({ config: {} }).backend('daemon:tunnelbox')
  tunnelInfo = await backend.openTunnel({ host: '127.0.0.1', port })
  assert.match(tunnelInfo.url, /^http:\/\/127\.0\.0\.1:\d+$/)
  console.log('ok  tunnel opened on loopback')

  let body = null
  for (let attempt = 0; attempt < 25; attempt += 1) {
    try {
      const response = await fetch(tunnelInfo.url + '/', { signal: AbortSignal.timeout(2000) })
      body = await response.text()
      if (body.includes('tunnel ok')) break
    } catch {
      // server still warming up
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  assert.match(body ?? '', /tunnel ok/)
  console.log('ok  remote HTTP server answers through the tunnel')

  tunnelInfo.close()
  await new Promise((resolve) => setTimeout(resolve, 200))
  let refused = false
  try {
    await fetch(tunnelInfo.url + '/', { signal: AbortSignal.timeout(1000) })
  } catch {
    refused = true
  }
  assert.equal(refused, true)
  console.log('ok  closing the tunnel closes the listener')
  tunnelInfo = null
  await backend.dispose()
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  if (!required && /ECONNREFUSED|ENOTFOUND|timed out|All configured authentication methods failed|python3|not found/i.test(message)) {
    console.log(`skip: tunnel test could not run — ${message}`)
  } else {
    console.error(`fail: ${message}`)
    dispose()
    rmSync(dir, { recursive: true, force: true })
    process.exit(1)
  }
} finally {
  if (started) {
    try {
      await run({ action: 'exec', target: 'daemon:tunnelbox', command: `pkill -f "http.server ${port}" 2>/dev/null; rm -rf ${remoteDir}; true` })
    } catch {
      // host already gone
    }
  }
  if (tunnelInfo !== null) tunnelInfo.close()
}

dispose()
rmSync(dir, { recursive: true, force: true })
console.log('tunnel smoke ok')
