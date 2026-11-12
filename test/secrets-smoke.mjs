// Secrets store unit test: set / lookup / remove, and the file itself.
//
//   node test/secrets-smoke.mjs
//
// Runs entirely against a temp file, so it never touches a real password.

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'rs-secrets-'))
process.env.DSH_REMOTE_SUITE_SECRETS = join(dir, 'secrets.json')

const { loadSecrets, lookupPassword, removePassword, secretKey, setPassword } = await import('../lib/secrets.js')

const profile = { alias: 'box', hostname: '192.168.81.77', user: 'liguojin', port: 22 }
assert.equal(secretKey(profile), 'liguojin@192.168.81.77:22')

assert.equal(await lookupPassword(profile), undefined)
await setPassword(profile, 'first-secret')
assert.equal(await lookupPassword(profile), 'first-secret')

let secrets = await loadSecrets()
assert.equal(secrets['liguojin@192.168.81.77:22'], 'first-secret')
console.log('ok  set + lookup by key')

// The same user@host on another port still finds the password; a different
// user does not — that is a different account, not the same credential.
assert.equal(await lookupPassword({ ...profile, port: 2222 }), 'first-secret')
assert.equal(await lookupPassword({ ...profile, user: 'other' }), undefined)
console.log('ok  lookup is per user@host, port-agnostic')

await setPassword(profile, 'second-secret')
assert.equal(await lookupPassword(profile), 'second-secret')
console.log('ok  overwrite')

const mode = statSync(process.env.DSH_REMOTE_SUITE_SECRETS).mode & 0o777
if (process.platform !== 'win32') assert.equal(mode, 0o600, `expected 0600, got 0${mode.toString(8)}`)
console.log(`ok  file mode ${process.platform === 'win32' ? '(windows: ACL)' : '0600'}`)

assert.equal(await removePassword(profile), true)
assert.equal(await lookupPassword(profile), undefined)
assert.equal(await removePassword(profile), false)
console.log('ok  remove')

// Nothing but the password hash-free record should be on disk.
const raw = JSON.parse(readFileSync(process.env.DSH_REMOTE_SUITE_SECRETS, 'utf8'))
assert.deepEqual(Object.keys(raw), [])
console.log('ok  file empty after remove')

rmSync(dir, { recursive: true, force: true })
console.log('secrets smoke ok')
