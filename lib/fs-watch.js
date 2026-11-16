// `WS /remote-suite/sidebar/ws/fs-watch` — the "this directory changed" socket.
//
// better-sidebar learns about changes from `fs.watch` on the Host. That call is
// useless for a remote target, so this implementation never touches the disk
// directly: it asks the sidebar filesystem for a cheap fingerprint of each
// watched directory every couple of seconds and pushes a frame when the
// fingerprint moves. Local targets ride the same path, which keeps one code
// path (and one debounce) for every backend.
//
// Wire format is better-sidebar's, verbatim:
//
//   → {"op":"watch","path":"…"}      ← {"dir":"<absolute>","ok":true}
//   → {"op":"unwatch","path":"…"}    ← (no reply)
//   ← {"dir":"<absolute>"}            a change was debounced in that directory
//
// `dir` in a success frame is the resolved absolute path; in a failure frame it
// is the raw string the client sent, so the client can tell which request was
// refused. Malformed frames are dropped silently, like the original.

const DEBOUNCE_MS = 150
const POLL_MS = 2000
const MAX_WATCHES = 64

export function createFsWatch({ sidebarFs, WebSocketServer }) {
  const server = new WebSocketServer({ noServer: true })
  const sockets = new Set()

  const closeAll = () => {
    for (const ws of sockets) {
      try {
        ws.close(1001, 'server shutting down')
      } catch {
        // Already gone.
      }
    }
    sockets.clear()
    try {
      server.close()
    } catch {
      // Nothing listening.
    }
  }

  server.on('connection', (ws, req) => {
    const sessionId = new URL(req?.url ?? '/', 'http://remote-suite.invalid').searchParams.get('sessionId') ?? ''
    if (sessionId === '') {
      try {
        ws.close(1008, 'sessionId is required')
      } catch {
        // Already closed.
      }
      return
    }
    sockets.add(ws)

    /** raw path → { dir, digest } for every directory this socket watches. */
    const watches = new Map()
    const timers = new Map()

    const send = (frame) => {
      if (ws.readyState !== 1) return
      try {
        ws.send(JSON.stringify(frame))
      } catch {
        // The socket died between the check and the send; the close handler cleans up.
      }
    }

    const flush = (dir) => {
      timers.delete(dir)
      send({ dir })
    }

    const schedule = (dir) => {
      if (timers.has(dir)) return
      const timer = setTimeout(() => flush(dir), DEBOUNCE_MS)
      if (typeof timer.unref === 'function') timer.unref()
      timers.set(dir, timer)
    }

    const poll = setInterval(async () => {
      for (const state of watches.values()) {
        try {
          const result = await sidebarFs.digest({ sessionId, path: state.dir })
          if (state.digest === undefined) {
            state.digest = result.digest
            continue
          }
          if (result.digest !== state.digest) {
            state.digest = result.digest
            schedule(state.dir)
          }
        } catch {
          // A directory that vanished is handled by the next client re-list.
        }
      }
    }, POLL_MS)
    if (typeof poll.unref === 'function') poll.unref()

    ws.on('message', async (raw) => {
      let frame
      try {
        frame = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'))
      } catch {
        return
      }
      if (frame === null || typeof frame !== 'object') return
      const path = typeof frame.path === 'string' ? frame.path : ''
      if (path === '') return
      if (frame.op !== 'watch' && frame.op !== 'unwatch') return
      if (frame.op === 'unwatch') {
        watches.delete(path)
        const timer = timers.get(path)
        if (timer !== undefined) {
          clearTimeout(timer)
          timers.delete(path)
        }
        return
      }
      if (watches.size >= MAX_WATCHES) {
        send({ dir: path, ok: false, reason: `at most ${MAX_WATCHES} directories can be watched` })
        return
      }
      try {
        const result = await sidebarFs.digest({ sessionId, path })
        watches.set(path, { dir: result.path, digest: result.digest })
        send({ dir: result.path, ok: true })
      } catch (error) {
        send({ dir: path, ok: false, reason: error instanceof Error ? error.message : String(error) })
      }
    })

    ws.on('close', () => {
      sockets.delete(ws)
      clearInterval(poll)
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
      watches.clear()
    })
    ws.on('error', () => {
      try {
        ws.close()
      } catch {
        // Already closed.
      }
    })
  })

  return {
    upgrade(req, socket, head) {
      server.handleUpgrade(req, socket, head, (ws) => server.emit('connection', ws, req))
    },
    dispose: closeAll,
  }
}
