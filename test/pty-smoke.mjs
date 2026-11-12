// PTY bridge test: mount the WebSocket server on a bare HTTP server with a fake
// backend, then drive it like the browser terminal does.
//
// Run with: node test/pty-smoke.mjs

import assert from 'node:assert/strict'
import http from 'node:http'

import { WebSocket, WebSocketServer } from 'ws'

import { createPtyServer } from '../lib/pty-server.js'

const PATH = '/remote-suite/pty'

function fakeTerminal({ cwd, cols, rows }) {
  const chunks = []
  const wake = { fn: null, closed: false }
  const notes = { cols, rows, writes: [], resizes: [] }
  let finish
  const done = new Promise((resolve) => {
    finish = resolve
  })
  const output = (async function* () {
    for (;;) {
      if (chunks.length === 0) {
        if (wake.closed) return
        await new Promise((resolve) => {
          wake.fn = resolve
        })
        wake.fn = null
        continue
      }
      yield chunks.shift()
    }
  })()
  const handle = {
    output,
    done,
    writes: notes.writes,
    async write(text) {
      notes.writes.push(text)
      chunks.push(Buffer.from(`[${cwd || '/'}] ${text}`))
      if (wake.fn !== null) wake.fn()
    },
    async resize(width, height) {
      notes.resizes.push([width, height])
      notes.cols = width
      notes.rows = height
    },
    async terminate() {
      wake.closed = true
      if (wake.fn !== null) wake.fn()
      finish({ exitCode: 0 })
    },
  }
  return { handle, notes }
}

const sessions = []
const registry = {
  async backend(id) {
    if (id !== 'local') throw new Error(`remote: unknown target ${id}`)
    return {
      id: 'local',
      label: '本地',
      async openTerminal(options) {
        const session = fakeTerminal(options)
        sessions.push(session)
        return session.handle
      },
    }
  },
}

const pty = createPtyServer({ registry, WebSocketServer })
const server = http.createServer()
server.on('upgrade', (req, socket, head) => {
  if (req.url === PATH) pty.upgrade(req, socket, head)
  else socket.destroy()
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port

function channel() {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${PATH}`)
  const queue = []
  const waiters = []
  ws.on('message', (raw) => {
    const message = JSON.parse(String(raw))
    const waiter = waiters.shift()
    if (waiter !== undefined) waiter(message)
    else queue.push(message)
  })
  const opened = new Promise((resolve, reject) => {
    ws.on('open', resolve)
    ws.on('error', reject)
  })
  const next = () =>
    new Promise((resolve) => {
      if (queue.length > 0) resolve(queue.shift())
      else waiters.push(resolve)
    })
  return { ws, next, opened }
}

const check = (label) => console.log(`ok  ${label}`)

// --- open, echo, resize, close ---------------------------------------------
const first = channel()
await first.opened
first.ws.send(JSON.stringify({ t: 'open', target: 'local', cols: 1000, rows: 1000 }))
const ready = await first.next()
assert.equal(ready.t, 'ready')
assert.equal(ready.cols, 400)
assert.equal(ready.rows, 200)
assert.equal(ready.target, 'local')
check('open clamps the terminal size and answers ready')

first.ws.send(JSON.stringify({ t: 'data', d: 'hello' }))
const echoed = await first.next()
assert.equal(echoed.t, 'data')
assert.match(echoed.d, /hello$/)
assert.deepEqual(sessions[0].notes.writes, ['hello'])
check('data round-trips through the PTY')

first.ws.send(JSON.stringify({ t: 'resize', cols: 100, rows: 30 }))
first.ws.send(JSON.stringify({ t: 'data', d: 'after-resize' }))
const echoedAgain = await first.next()
assert.equal(echoedAgain.t, 'data')
assert.match(echoedAgain.d, /after-resize$/)
assert.deepEqual(sessions[0].notes.resizes, [[100, 30]])
check('resize reaches the handle')

first.ws.send(JSON.stringify({ t: 'close' }))
const exited = await first.next()
assert.equal(exited.t, 'exit')
assert.equal(exited.code, 0)
first.ws.close()
check('close ends the shell and reports the exit code')

// --- protocol errors --------------------------------------------------------
const second = channel()
await second.opened
second.ws.send(JSON.stringify({ t: 'open', target: 'nope', cols: 80, rows: 24 }))
const failure = await second.next()
assert.equal(failure.t, 'error')
assert.match(failure.message, /unknown target/)
second.ws.send(JSON.stringify({ t: 'bogus' }))
const unknown = await second.next()
assert.equal(unknown.t, 'error')
assert.match(unknown.message, /unknown message type/)
second.ws.close()
check('protocol errors surface as { t: "error" }')

// --- dispose closes live sockets -------------------------------------------
const third = channel()
await third.opened
third.ws.send(JSON.stringify({ t: 'open', target: 'local', cols: 80, rows: 24 }))
await third.next()
assert.equal(pty.size, 1)
pty.dispose()
await new Promise((resolve) => setTimeout(resolve, 50))
assert.equal(pty.size, 0)
check('dispose drops open terminals')

server.close()
console.log('pty smoke ok')
