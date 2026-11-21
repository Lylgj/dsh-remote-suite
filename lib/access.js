// DSH's Connection service owns the trust decisions for every Web route: the
// Host/Origin fence (DNS rebinding, cross-site callers) and the browser session
// credential. The shipped host plugins ask it on every route — `dsh-host-open-in-app`
// calls `ctx.connection.requestRejection(req)` before it resolves anything — so this
// plugin does the same instead of relying on an origin comparison of its own.
//
// The service is read once per mount and may be absent (a bare CLI host that never
// mounted a browser carrier). In that case the routes keep this plugin's own weaker
// checks; `available` records which of the two answered so the caller can log it.

/**
 * Map `ctx` to the composition's Connection service, if this Host has one.
 * @param {object} ctx - the plugin context.
 * @returns {object | undefined} a service exposing `requestRejection`.
 */
function connectionOf(ctx) {
  const reads = [
    () => (typeof ctx?.get === 'function' ? ctx.get('connection') : undefined),
    () => Reflect.get(ctx, 'connection'),
  ]
  for (const read of reads) {
    try {
      const service = read()
      if (service !== undefined && service !== null) return service
    } catch {
      // A Context without that service throws on an unknown key; try the next read.
    }
  }
  return undefined
}

/**
 * Build the route guard this plugin's HTTP and upgrade handlers consult first.
 *
 * The service is usually only readable from a Context that asked for it, and this
 * plugin does not declare `connection` in its `inject` list (a Host without a browser
 * carrier has none). So the gate starts unavailable and `attach` upgrades it once
 * `ctx.inject(['connection'], …)` delivers the scope that has the service.
 * @param {object} ctx - the plugin context.
 * @param {object} [logger] - host logger; warnings are best-effort.
 * @param {Function} [report] - called with `(status, req)` whenever a request is refused.
 * @returns {object} `{ available, attach, rejectRequest, rejectUpgrade }`.
 */
export function createAccessGate(ctx, logger, report) {
  let service = connectionOf(ctx)
  let warned = false

  const rejected = (status, req) => {
    try {
      report?.(status, req)
    } catch {
      // Diagnostics must never change the answer.
    }
  }

  const rejectOf = () => (typeof service?.requestRejection === 'function' ? (req) => service.requestRejection(req) : undefined)

  const warnOnce = () => {
    if (warned) return
    warned = true
    try {
      logger?.warn?.(
        'remote-suite: this Host has no `connection` service, so its access check cannot be applied; falling back to the plugin\'s own origin checks',
      )
    } catch {
      // A logger that throws is not worth failing a request over.
    }
  }

  /**
   * Ask the trust fence about one request.
   * @param {object} req - the HTTP or upgrade request (only `headers` is read).
   * @returns {number | undefined} 401/403 to refuse, undefined to allow.
   */
  const statusOf = (req) => {
    const reject = rejectOf()
    if (reject === undefined) {
      warnOnce()
      return undefined
    }
    try {
      const status = reject(req)
      return status === undefined ? undefined : status
    } catch (error) {
      // A fence that throws must fail closed: an exception is not an admission.
      try {
        logger?.warn?.('remote-suite: the connection access check threw, refusing the request', error)
      } catch {
        // Ignore a broken logger.
      }
      return 403
    }
  }

  return {
    /** Whether a Connection service is answering right now. */
    get available() {
      return typeof service?.requestRejection === 'function'
    },

    /**
     * Take the service once a scope that can read it arrives.
     * @param {object} next - the Connection service, or undefined when the Host has none.
     * @returns {boolean} true when the gate is now armed.
     */
    attach(next) {
      if (next === undefined || next === null) return false
      if (typeof next.requestRejection !== 'function') return false
      service = next
      warned = false
      return true
    },

    /**
     * Refuse an HTTP request on the spot, writing the rejection status.
     * @param {object} req - the request.
     * @param {object} res - the response the caller would otherwise own.
     * @returns {boolean} true when the request was refused and the response ended.
     */
    rejectRequest(req, res) {
      const status = statusOf(req)
      if (status === undefined) return false
      rejected(status, req)
      try {
        res.statusCode = status
        res.setHeader('cache-control', 'no-store')
        res.end()
      } catch {
        // The socket is already gone; the request is refused either way.
      }
      return true
    },

    /**
     * Refuse a WebSocket upgrade before the protocol owner sees it.
     * @param {object} req - the upgrade request.
     * @param {object} socket - the raw socket.
     * @returns {boolean} true when the upgrade was refused and the socket ended.
     */
    rejectUpgrade(req, socket) {
      const status = statusOf(req)
      if (status === undefined) return false
      rejected(status, req)
      const reason = status === 401 ? 'Unauthorized' : 'Forbidden'
      try {
        socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
      } catch {
        // Socket already closed.
      }
      try {
        socket.destroy()
      } catch {
        // Already destroyed.
      }
      return true
    },
  }
}
