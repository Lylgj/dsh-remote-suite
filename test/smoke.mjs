// M0 + M1 smoke test: mount the host half against a stub ctx and exercise the tool.
//
// Run with: node test/smoke.mjs
// Exits non-zero on the first failed assertion. State writes go to a temp file so
// the real profile state is never touched.

process.env.DSH_REMOTE_SUITE_STATE = process.env.DSH_REMOTE_SUITE_STATE
  || `${process.env.TEMP || process.env.TMPDIR || '/tmp'}/remote-suite-suite-${process.pid}.json`

import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, name } from '../index.js'

const registered = []
const routes = []
const upgrades = []
const ctx = {
  tools: {
    register(def) {
      registered.push(def)
      return () => {}
    },
  },
  inject(deps, callback) {
    if (!deps.includes('webServer')) return undefined
    callback({
      webServer: {
        register(route) {
          routes.push(route)
          return () => {}
        },
        registerUpgrade(upgrade) {
          upgrades.push(upgrade)
          return () => {}
        },
      },
    })
    return () => {}
  },
}

const dispose = apply(ctx, {})
assert.equal(name, 'remote-suite')
assert.equal(registered.length, 1, 'apply must register exactly one tool')
assert.equal(routes.length, 2, 'apply must register the JSON API and the asset route')
const apiRoute = routes.find((route) => route.path === '/remote-suite/api')
assert.ok(apiRoute !== undefined, 'the JSON API route must be mounted')
assert.equal(typeof apiRoute.handler, 'function')
assert.equal(upgrades.length, 1, 'apply must register the PTY upgrade route')
assert.equal(upgrades[0].path, '/remote-suite/pty')

const tool = registered[0]
assert.equal(tool.name, 'remote')
assert.equal(typeof tool.execute, 'function')

const run = (args) => tool.execute(args, { agent: { id: 'smoke' } })
const check = (label) => console.log(`ok  ${label}`)

// --- JSON API route ---------------------------------------------------------
const { Readable } = await import('node:stream')
async function postApi(payload, headers = {}) {
  const req = Readable.from([JSON.stringify(payload)])
  req.method = 'POST'
  req.url = '/remote-suite/api/targets'
  req.headers = { 'x-remote-suite': '1', ...headers }
  let status
  let body
  const res = {
    writeHead(code) {
      status = code
    },
    end(text) {
      body = text
    },
  }
  await apiRoute.handler(req, res)
  return { status, body: body === undefined ? undefined : JSON.parse(body) }
}

const allowed = await postApi({})
assert.equal(allowed.status, 200)
assert.equal(allowed.body.ok, true)
assert.ok(Array.isArray(allowed.body.result))
check('api route answers with a JSON envelope')

const denied = await postApi({}, { 'x-remote-suite': '0' })
assert.equal(denied.status, 403)
check('api route rejects clients without the header')

// --- terminal assets ---------------------------------------------------------
const assetRoute = routes.find((route) => route.path === '/remote-suite/assets')
async function getAsset(pathname) {
  const req = { method: 'GET', url: pathname, headers: {} }
  let status
  let headers = {}
  let body = ''
  const res = {
    writeHead(code, extra) {
      status = code
      headers = extra || {}
    },
    end(chunk) {
      body = chunk === undefined ? '' : Buffer.from(chunk).toString('utf8')
    },
  }
  await assetRoute.handler(req, res)
  return { status, headers, body }
}

const script = await getAsset('/remote-suite/assets/xterm.js')
assert.equal(script.status, 200)
assert.match(script.headers['content-type'], /javascript/)
assert.ok(script.body.includes('xterm'))
check('asset route serves the terminal emulator')

const traversal = await getAsset('/remote-suite/assets/..%2Findex.js')
assert.equal(traversal.status, 404)
check('asset route refuses path traversal')

// --- targets ---------------------------------------------------------------
const targets = await run({ action: 'targets' })
assert.match(targets, /^targets \(\d+\):/)
assert.match(targets, /local\tlocal\t/)
const wslTargetIds = targets
  .split('\n')
  .filter((line) => line.startsWith('wsl:'))
  .map((line) => line.split('\t')[0])
check('targets')

// --- local exec ------------------------------------------------------------
const local = await run({ action: 'exec', target: 'local', command: 'echo remote-suite-ok' })
assert.match(local, /exit=0/)
assert.match(local, /remote-suite-ok/)
check('local exec')

const failing = await run({ action: 'exec', target: 'local', command: 'echo boom 1>&2 && exit 3' })
assert.match(failing, /exit=3/)
assert.match(failing, /boom/)
check('local exec failure surface')

// --- local file roundtrip --------------------------------------------------
const dir = await mkdtemp(join(tmpdir(), 'remote-suite-'))
const file = join(dir, 'hello.txt')

assert.match(await run({ action: 'write', target: 'local', path: file, data: '你好 remote\n' }), /wrote \d+ bytes/)
assert.equal(await run({ action: 'read', target: 'local', path: file }), '你好 remote\n')
assert.match(await run({ action: 'stat', target: 'local', path: file }), /file \d+ bytes/)
assert.match(await run({ action: 'list', target: 'local', path: dir }), /hello\.txt/)
check('local read/write/stat/list')

// --- read window -----------------------------------------------------------
const window = await run({ action: 'read', target: 'local', path: file, offset: 1, limit: 1 })
assert.equal(window, '你好 remote')
check('read offset/limit')

// --- local grep + glob -----------------------------------------------------
await run({ action: 'write', target: 'local', path: join(dir, 'src', 'a.ts'), data: 'const needle = 1\nconst other = 2\n' })
await run({ action: 'write', target: 'local', path: join(dir, 'src', 'b.md'), data: 'needle in markdown\n' })

const grep = await run({ action: 'grep', target: 'local', path: dir, pattern: 'needle' })
assert.match(grep, /src\/a\.ts:1:/)
assert.match(grep, /src\/b\.md:1:/)
const grepGlob = await run({ action: 'grep', target: 'local', path: dir, pattern: 'needle', glob: '**/*.ts' })
assert.match(grepGlob, /src\/a\.ts:1:/)
assert.doesNotMatch(grepGlob, /b\.md/)
check('local grep + glob filter')

const glob = await run({ action: 'glob', target: 'local', root: dir, pattern: '**/*.md' })
assert.match(glob, /src\/b\.md/)
assert.doesNotMatch(glob, /a\.ts/)
check('local glob')

// --- workspace -------------------------------------------------------------
const added = await run({ action: 'workspace-add', target: 'local', path: dir, name: 'smoke' })
assert.match(added, /^added ws-smoke /)
assert.match(await run({ action: 'workspaces' }), /ws-smoke\tlocal\t/)
assert.equal(await run({ action: 'read', workspace: 'ws-smoke', path: 'hello.txt' }), '你好 remote\n')
assert.match(await run({ action: 'exec', workspace: 'ws-smoke', command: 'echo in-workspace' }), /in-workspace/)
assert.match(await run({ action: 'workspace-remove', workspace: 'ws-smoke' }), /^removed ws-smoke/)
check('workspace add/use/remove')

// --- edit / probe ----------------------------------------------------------
await run({ action: 'write', target: 'local', path: file, data: 'alpha beta alpha\n' })
assert.match(await run({ action: 'edit', target: 'local', path: file, old: 'beta', new: 'gamma' }), /replaced 1 occurrence/)
assert.equal(await run({ action: 'read', target: 'local', path: file }), 'alpha gamma alpha\n')
await assert.rejects(
  () => run({ action: 'edit', target: 'local', path: file, old: 'alpha', new: 'x' }),
  /appears 2 times/,
)
assert.match(
  await run({ action: 'edit', target: 'local', path: file, old: 'alpha', new: 'omega', replaceAll: true }),
  /replaced 2 occurrences/,
)
await assert.rejects(
  () => run({ action: 'edit', target: 'local', path: file, old: 'zzz', new: 'q' }),
  /does not appear/,
)
assert.match(await run({ action: 'probe', target: 'local' }), /kind: local/)
check('local edit + probe')

// --- unknown target / workspace --------------------------------------------
await assert.rejects(() => run({ action: 'exec', target: 'nope', command: 'echo hi' }), /unknown target/)
await assert.rejects(() => run({ action: 'workspaces-typo' }), /unknown action/)
check('error paths')

// --- WSL, when the host has a distribution ---------------------------------
for (const id of wslTargetIds) {
  const distro = id.slice(4)
  const out = await run({ action: 'exec', target: id, command: 'uname -s && echo "$HOME"' })
  assert.match(out, /exit=0/)
  assert.match(out, /Linux/)

  const remoteDir = `/tmp/remote-suite-smoke-${process.pid}`
  await run({ action: 'workspace-add', target: id, path: '/tmp', name: `wsl-${distro}` })
  await run({ action: 'write', target: id, path: `${remoteDir}/a.txt`, data: 'wsl-ok\nneedle here\n' })
  assert.match(await run({ action: 'read', target: id, path: `${remoteDir}/a.txt` }), /needle here/)

  // wsl.exe re-evaluates the command line after `--`, which used to eat `$vars`.
  const shellVars = await run({
    action: 'exec',
    target: id,
    command: 'f=abc; echo "f=[$f]"; for x in a b; do echo "x=[$x]"; done; echo "sub=$(echo hi)"',
  })
  assert.match(shellVars, /f=\[abc\]/)
  assert.match(shellVars, /x=\[a\][\s\S]*x=\[b\]/)
  assert.match(shellVars, /sub=hi/)

  // Data with `$` in it must survive a write as well.
  await run({ action: 'write', target: id, path: `${remoteDir}/dollar.txt`, data: 'cost $HOME and $f\n' })
  assert.match(
    await run({ action: 'read', target: id, path: `${remoteDir}/dollar.txt` }),
    /cost \$HOME and \$f/,
  )

  const wslGrep = await run({ action: 'grep', target: id, path: remoteDir, pattern: 'needle' })
  assert.match(wslGrep, /a\.txt:2:/)

  const wslGlob = await run({ action: 'glob', target: id, root: remoteDir, pattern: '*.txt' })
  assert.match(wslGlob, /a\.txt/)

  await run({ action: 'exec', target: id, command: `rm -rf ${remoteDir}` })
  console.log(`ok  WSL backend (${distro})`)
}

if (typeof dispose === 'function') dispose()

console.log('smoke ok')
