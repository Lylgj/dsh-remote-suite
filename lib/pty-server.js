// WebSocket bridge between the browser terminal and a backend PTY.
//
// One socket owns one terminal session, so closing the tab closes the shell and
// two tabs can never fight over one channel. The protocol is deliberately small:
//
//   client -> { t: 'open', target, workspace?, cwd?, cols, rows }
//   server -> { t: 'ready', cols, rows, target, cwd }
//   client -> { t: 'data', d: '<utf-8 text>' }
//   server -> { t: 'data', d: '<utf-8 text>' }
//   client -> { t: 'resize', cols, rows }        (server echoes nothing)
//   server -> { t: 'exit', code }                (the shell ended)
//   either -> { t: 'close' }
//
// Output is decoded with a streaming TextDecoder because a multi-byte character
// can be split across two PTY reads; without `stream: true` those bytes would
// turn into replacement characters.

import { clampSize } from './pty.js'
import { resolveScope } from './scope.js'

/** A resized `cols`/`rows` pair is tiny; anything larger is not this protocol. */
const MAX_MESSAGE_BYTES = 256 * 1024

/**
 * @param {{ registry: object, WebSocketServer: Function }} options
 *   `WebSocketServer` is `ws`'s class; tests pass it explicitly so they do not
 *   need the Host.
 */
export function createPtyServer({ registry, WebSocketServer }) {
  const wss = new WebSocketServer({ noServer: true })
  const sockets = new Set()

  function attach(ws) {
    sockets.add(ws)
    let session = null
    let closed = false
    const decoder = new TextDecoder()
    const send = (message) => {
      if (ws.readyState === 1) ws.send(JSON.stringify(message))
    }

    /** Read the PTY for as long as it lives, relaying every chunk. */
    async function pump(handle) {
      try {
        for await (const chunk of handle.output) {
          if (closed) break
          const text = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
          if (text !== '') send({ t: 'data', d: text })
        }
      } catch (error) {
        send({ t: 'error', message: error instanceof Error ? error.message : String(error) })
      } finally {
        let code = null
        try {
          const outcome = await handle.done
          if (typeof outcome?.exitCode === 'number') code = outcome.exitCode
        } catch {
          // A handle that cannot report its exit code still ended.
        }
        send({ t: 'exit', code })
        session = null
      }
    }

    async function open(message) {
      if (session !== null) {
        send({ t: 'error', message: 'a terminal is already open on this connection' })
        return
      }
      const scope = await resolveScope(registry, message)
      if (typeof scope.backend.openTerminal !== 'function') {
        throw new Error(`remote-suite: ${scope.backend.id} cannot open a terminal`)
      }
      const cwd = typeof message.cwd === 'string' && message.cwd !== '' ? message.cwd : scope.base
      const size = clampSize(message.cols, message.rows)
      const handle = await scope.backend.openTerminal({ cwd, cols: size.cols, rows: size.rows })
      session = handle
      send({ t: 'ready', cols: size.cols, rows: size.rows, target: scope.backend.id, cwd })
      void pump(handle)
    }

    ws.on('message', (data) => {
      let message
      try {
        message = JSON.parse(typeof data === 'string' ? data : Buffer.from(data).toString('utf8'))
      } catch {
        send({ t: 'error', message: 'remote-suite: expected JSON' })
        return
      }
      void (async () => {
        try {
          switch (message?.t) {
            case 'open':
              await open(message)
              break
            case 'data':
              if (session !== null) await session.write(String(message.d ?? ''))
              break
            case 'resize': {
              if (session === null) break
              const size = clampSize(message.cols, message.rows)
              await session.resize(size.cols, size.rows)
              break
            }
            case 'close':
              if (session !== null) await session.terminate()
              break
            default:
              send({ t: 'error', message: `remote-suite: unknown message type ${JSON.stringify(message?.t)}` })
          }
        } catch (error) {
          send({ t: 'error', message: error instanceof Error ? error.message : String(error) })
        }
      })()
    })

    ws.on('close', () => {
      closed = true
      sockets.delete(ws)
      const current = session
      session = null
      if (current !== null) {
        Promise.resolve(current.terminate()).catch(() => {})
      }
    })
    ws.on('error', () => {})
  }

  return {
    /** Called from the Host's `webServer.registerUpgrade` handler. */
    upgrade(req, socket, head) {
      wss.handleUpgrade(req, socket, head, (ws) => attach(ws))
    },

    dispose() {
      for (const ws of sockets) {
        try {
          ws.close(1001, 'remote-suite disposed')
        } catch {
          // Already gone.
        }
      }
      sockets.clear()
      try {
        wss.close()
      } catch {
        // Nothing listening.
      }
    },

    get size() {
      return sockets.size
    },
  }
}

export { MAX_MESSAGE_BYTES }
