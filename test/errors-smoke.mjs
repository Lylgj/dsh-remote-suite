// Error-shaping smoke test: the hint table, the transient retry switch, and one
// real backend error path (a WSL distribution that does not exist).
//
//   node test/errors-smoke.mjs

import assert from 'node:assert/strict'

import { explain, isTransient, withHint } from '../lib/errors.js'
import { createRegistry } from '../lib/backends/index.js'
import { createRemoteTool } from '../lib/tool-remote.js'

// --- the hint table -------------------------------------------------------

assert.match(explain(new Error('ENOENT: no such file or directory, open \'/x\'')), /no such file or directory/)
assert.match(explain(new Error('EACCES: permission denied')), /permission denied/)
assert.match(explain(new Error('connect ECONNREFUSED 127.0.0.1:5432')), /connection refused/)
assert.match(explain(new Error('Cannot connect to the Docker daemon at unix:///var/run/docker.sock')), /DSH_DOCKER/)
assert.match(explain(new Error('no distribution with the supplied name.')), /wsl -l -q/)
assert.match(explain(new Error('All configured authentication methods failed')), /secret-set/)
const unknown = new Error('something entirely bespoke happened')
assert.equal(explain(unknown), 'something entirely bespoke happened')
console.log('ok  hints for known transports, untouched for unknown ones')

// Hints never double up: an error that already carries the hint keeps one copy.
const once = explain(new Error('no such file or directory'))
assert.equal(explain(new Error(once)), once)
console.log('ok  hints are not appended twice')

// withHint keeps the original error when there is nothing to add.
assert.equal(withHint(unknown), unknown)
const wrapped = withHint(new Error('Cannot connect to the Docker daemon'))
assert.match(wrapped.message, /Docker engine is not reachable/)
assert.match(wrapped.stack ?? '', /Caused by:/)
console.log('ok  withHint wraps only when it adds something, and keeps the cause')

// --- transient classification --------------------------------------------

assert.equal(isTransient(new Error('read ECONNRESET')), true)
assert.equal(isTransient(new Error('The Windows Subsystem for Linux instance has terminated.')), true)
assert.equal(isTransient(new Error('Cannot connect to the Docker daemon')), false)
assert.equal(isTransient(new Error('grep: no matches')), false)
console.log('ok  only retryable failures are classified transient')

// --- one real backend path ------------------------------------------------

if (process.platform === 'win32') {
  const registry = createRegistry({ config: {} })
  const tool = createRemoteTool({ registry })
  let message = ''
  try {
    await tool.execute({ action: 'exec', target: 'wsl:definitely-not-a-real-distro', command: 'true' })
  } catch (error) {
    message = error instanceof Error ? error.message : String(error)
  } finally {
    await registry.dispose()
  }
  assert.match(message, /not installed|no distribution|staging a script/i)
  console.log('ok  a missing WSL distribution explains itself')
} else {
  console.log('skip: no WSL on this platform')
}

console.log('errors smoke ok')
