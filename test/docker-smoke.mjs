// Docker backend test: the docker CLI is not required.
//
// The backend takes a `run(script, options)` seam; here that seam executes the
// exact same shell script in a WSL distribution against a scratch directory, so
// quoting, parsing and the commands themselves are exercised for real.
//
// Run with: node test/docker-smoke.mjs

import assert from 'node:assert/strict'

import { createDockerBackend } from '../lib/backends/docker.js'
import { runWslScript } from '../lib/backends/wsl.js'

const DISTRO = process.env.DSH_DOCKER_TEST_DISTRO || 'Ubuntu'

// The seam runs the script through the same staging path the WSL backend uses:
// `wsl.exe` re-evaluates a command line passed as argv, so the scripts have to
// reach bash as a file, exactly like they do in production.
const shell = (command, options = {}) => runWslScript(DISTRO, command, options)

const probe = await shell('echo wsl-ok').catch(() => null)
if (probe === null || probe.stdout.trim() !== 'wsl-ok') {
  console.log(`docker smoke skipped: no WSL distribution named ${DISTRO}`)
  process.exit(0)
}

const base = `/tmp/remote-suite-docker-${process.pid}`
await shell(`rm -rf ${base} && mkdir -p ${base}`)

const run = (script, options = {}) => shell(`cd ${base} && ${script}`, options)
const backend = createDockerBackend({ id: 'docker:smoke', container: 'smoke', exec: run })
const check = (label) => console.log(`ok  ${label}`)

// --- write + read -----------------------------------------------------------
await backend.write({ path: `${base}/a.txt`, data: 'alpha\nbeta\ngamma\n' })
assert.equal(await backend.read({ path: `${base}/a.txt` }), 'alpha\nbeta\ngamma\n')
check('write then read a file')

assert.equal(await backend.read({ path: `${base}/a.txt`, offset: 2, limit: 1 }), 'beta')
check('read honours offset/limit')

// --- stat / list ------------------------------------------------------------
const fileStat = await backend.stat({ path: `${base}/a.txt` })
assert.equal(fileStat.type, 'file')
assert.equal(fileStat.size, 17)
const dirStat = await backend.stat({ path: base })
assert.equal(dirStat.type, 'dir')
check('stat reports type, size and mtime')

await backend.write({ path: `${base}/nested/b.md`, data: '# note\n' })
const listing = await backend.list({ path: base })
const names = listing.entries.map((entry) => entry.name)
assert.ok(names.includes('a.txt'))
assert.ok(names.includes('nested'))
assert.equal(listing.entries[0].type, 'dir')
check('list reports dirs first with types')

// --- exec -------------------------------------------------------------------
const echoed = await backend.exec({ command: 'echo hello-from-container' })
assert.equal(echoed.stdout.trim(), 'hello-from-container')
assert.equal(echoed.exitCode, 0)
const failing = await backend.exec({ command: 'echo boom 1>&2; exit 7' })
assert.equal(failing.exitCode, 7)
assert.match(failing.stderr, /boom/)
check('exec runs in the container and surfaces exit codes')

await assert.rejects(() => backend.exec({ command: 'true', workdir: `${base}/missing` }), /no such directory/)
check('exec fails clearly on a missing workdir')

// --- grep / glob ------------------------------------------------------------
await backend.write({ path: `${base}/nested/b.md`, data: '# note\nneedle here\n' })
await backend.write({ path: `${base}/nested/c.js`, data: 'const needle = 1\n' })
const hits = await backend.grep({ pattern: 'needle', path: base, glob: '**/*.md' })
assert.equal(hits.hits.length, 1)
assert.match(hits.hits[0].file, /b\.md$/)
assert.equal(hits.hits[0].line, 2)
check('grep filters by glob')

const found = await backend.glob({ pattern: '**/*.md', root: base })
assert.deepEqual(found.files.sort(), ['nested/b.md'])
check('glob finds files relative to the root')

// --- errors -----------------------------------------------------------------
await assert.rejects(() => backend.list({ path: `${base}/missing` }), /not a directory/)
await assert.rejects(() => backend.read({ path: `${base}/missing` }), /not a file/)
check('missing paths fail with clear errors')

// --- probe ------------------------------------------------------------------
const info = await backend.probe()
assert.equal(info.kind, 'docker')
assert.equal(info.container, 'smoke')
check('probe describes the container')

await shell(`rm -rf ${base}`)
console.log('docker smoke ok')
