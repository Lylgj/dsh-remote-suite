// Mirror sync smoke test, driven through the real `remote` tool on a WSL target.
//
//   node test/mirror-smoke.mjs            # first WSL distribution
//   DSH_MIRROR_TEST_DISTRO=Ubuntu node test/mirror-smoke.mjs
//
// Needs WSL; it creates a scratch tree in the distribution's /tmp, mirrors it
// into a temp directory, and tears both down again. Objects are compared by
// hash, so binary files are covered as well as text.

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_REMOTE_SUITE_STATE = `${tmpdir()}/rs-mirror-state-${process.pid}.json`
process.env.DSH_REMOTE_SUITE_SECRETS = `${tmpdir()}/rs-mirror-secrets-${process.pid}.json`

const { apply } = await import('../index.js')

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
const run = (args) => tool.execute(args, { agent: { id: 'mirror-smoke' } })

const listed = await run({ action: 'targets' })
const wslIds = listed
  .split('\n')
  .map((line) => line.split('\t')[0])
  .filter((id) => id.startsWith('wsl:'))
if (wslIds.length === 0) {
  console.log('skip: no WSL distribution')
  dispose()
  process.exit(0)
}
const wanted = process.env.DSH_MIRROR_TEST_DISTRO === undefined ? null : `wsl:${process.env.DSH_MIRROR_TEST_DISTRO}`
const targetId = wanted !== null && wslIds.includes(wanted) ? wanted : wslIds[0]

const remoteRoot = `/tmp/rs-mirror-${process.pid}`
const localRoot = mkdtempSync(join(tmpdir(), 'rs-mirror-local-'))
const sha = (buffer) => createHash('sha256').update(buffer).digest('hex')

const localFile = (rel) => join(localRoot, ...rel.split('/'))

try {
  await run({
    action: 'exec',
    target: targetId,
    command:
      `rm -rf ${remoteRoot} && mkdir -p ${remoteRoot}/sub && ` +
      `printf 'hello mirror\\n' > ${remoteRoot}/a.txt && ` +
      `printf 'nested\\n' > ${remoteRoot}/sub/b.txt && ` +
      `head -c 100000 /dev/urandom > ${remoteRoot}/bin.dat`,
  })
  console.log('ok  fixture created')

  const added = await run({ action: 'mirror-add', target: targetId, path: remoteRoot, local: localRoot, name: 'scratch' })
  assert.match(added, /→/)
  const mirrorId = added.split('\t')[0].split(' ').pop()
  console.log(`ok  mirror added (${mirrorId})`)

  let report = await run({ action: 'mirror-sync', mirror: mirrorId, direction: 'pull' })
  assert.match(report, /^pull 3 file\(s\)/)
  assert.equal(readFileSync(localFile('a.txt'), 'utf8'), 'hello mirror\n')
  assert.equal(readFileSync(localFile('sub/b.txt'), 'utf8'), 'nested\n')
  console.log('ok  pull')

  const remoteHash = await run({ action: 'exec', target: targetId, command: `sha256sum ${remoteRoot}/bin.dat` })
  const remoteSha = /\b([0-9a-f]{64})\b/.exec(remoteHash)[1]
  assert.equal(sha(readFileSync(localFile('bin.dat'))), remoteSha)
  console.log('ok  binary file is byte-identical')

  report = await run({ action: 'mirror-sync', mirror: mirrorId, direction: 'pull' })
  assert.match(report, /^pull 0 file\(s\).*3 unchanged/)
  console.log('ok  second pull skips unchanged files')

  writeFileSync(localFile('a.txt'), 'edited locally\n')
  report = await run({ action: 'mirror-sync', mirror: mirrorId, direction: 'push' })
  assert.match(report, /^push 1 file\(s\)/)
  const afterPush = await run({ action: 'read', target: targetId, path: `${remoteRoot}/a.txt` })
  assert.equal(afterPush, 'edited locally\n')
  console.log('ok  push')

  writeFileSync(localFile('sub/b.txt'), 'local wins?\n')
  await run({ action: 'exec', target: targetId, command: `sleep 2.5; touch ${remoteRoot}/sub/b.txt` })
  report = await run({ action: 'mirror-sync', mirror: mirrorId, direction: 'push' })
  // `a.txt` may also look newer right after the push above (its remote mtime is
  // the push time, the local mtime predates it); assert on the file this case is
  // about instead of on a total count that depends on push timing.
  assert.match(report, /newer remote file/)
  assert.match(report, /sub\/b\.txt/)
  const untouched = await run({ action: 'read', target: targetId, path: `${remoteRoot}/sub/b.txt` })
  assert.equal(untouched, 'nested\n')
  console.log('ok  push refuses to clobber a newer remote file')

  report = await run({ action: 'mirror-sync', mirror: mirrorId, direction: 'push', force: true })
  assert.match(report, /^push 3 file\(s\)/)
  const forced = await run({ action: 'read', target: targetId, path: `${remoteRoot}/sub/b.txt` })
  assert.equal(forced, 'local wins?\n')
  console.log('ok  force overrides the guard')

  writeFileSync(localFile('dry.txt'), 'not yet\n')
  report = await run({ action: 'mirror-sync', mirror: mirrorId, direction: 'push', dryRun: true })
  assert.match(report, /^push 1 file\(s\)/)
  const dry = await run({ action: 'exec', target: targetId, command: `test -e ${remoteRoot}/dry.txt && echo yes || echo no` })
  assert.match(dry, /no/)
  rmSync(localFile('dry.txt'))
  console.log('ok  dry run reports without writing')

  const mirrors = await run({ action: 'mirrors' })
  assert.match(mirrors, new RegExp(mirrorId))
  await run({ action: 'mirror-remove', mirror: mirrorId })
  assert.match(await run({ action: 'mirrors' }), /no mirrors saved/)
  console.log('ok  list + remove')
} finally {
  await run({ action: 'exec', target: targetId, command: `rm -rf ${remoteRoot}` }).catch(() => {})
  rmSync(localRoot, { recursive: true, force: true })
  rmSync(process.env.DSH_REMOTE_SUITE_STATE, { force: true })
  rmSync(process.env.DSH_REMOTE_SUITE_SECRETS, { force: true })
  dispose()
}

console.log('mirror smoke ok')
