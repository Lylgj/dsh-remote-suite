// Local port forward over an existing ssh2 connection.
//
// A tunnel is a loopback listener whose connections are answered by the remote
// side through `client.forwardOut` — the same primitive `ProxyJump` uses. It is
// what lets the workspace view embed a remote web UI (a `dsh web`, a dev server,
// a Jupyter) without opening another SSH connection or exposing the network.

import net from 'node:net'

/**
 * @param {{ forwardOut: Function, on: Function }} client connected ssh2 client
 * @param {string} remoteHost host as seen from the remote side
 * @param {number} remotePort port on that host
 * @returns {Promise<{ port: number, url: string, close: () => void }>}
 */
export async function openTunnel(client, remoteHost, remotePort, { bindHost = '127.0.0.1' } = {}) {
  const server = net.createServer((socket) => {
    socket.on('error', () => socket.destroy())
    client.forwardOut(bindHost, 0, remoteHost, remotePort, (error, stream) => {
      if (error !== undefined && error !== null) {
        socket.destroy()
        return
      }
      socket.pipe(stream).pipe(socket)
      stream.on('error', () => socket.destroy())
      socket.on('close', () => stream.destroy())
      stream.on('close', () => socket.destroy())
    })
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, bindHost, resolve)
  })
  const { port } = server.address()
  return {
    port,
    url: `http://${bindHost}:${port}`,
    close: () => {
      server.close()
      server.unref?.()
    },
  }
}

/** Poll a tunnel until the remote side answers, so callers can hand out its URL. */
export async function waitForTunnel(url, { timeoutMs = 15_000, intervalMs = 400 } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(Math.max(500, intervalMs * 2)) })
      if (response.ok || response.status < 500) return true
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) return false
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}
