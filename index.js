// dsh-remote-suite, host half.
//
// One plugin, one seam: WSL / SSH / Docker / remote-daemon targets are all just
// `Backend` implementations behind a single `remote` tool, and the browser half
// talks to the same backends through the JSON API and the PTY socket below. This
// file only wires them up; everything else lives in lib/.
//
// Backend contract (lib/backends/base.js documents it):
//   exec / read / write / stat / list  — file and command surface
//   grep / glob / probe                — search surface
//   openTerminal                       — interactive shell (lib/pty.js)
//
// The `inject` list is what the plugin cannot work without. `tools` is the tool
// registry; every optional service (webServer, settings, slots) is asked for at
// call time instead, so a Host that lacks one still mounts this plugin.

import { createRequire } from 'node:module'
import { appendFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAccessGate } from './lib/access.js'
import { createApi } from './lib/api.js'
import { serveAsset } from './lib/assets.js'
import { createRegistry } from './lib/backends/index.js'
import { explain } from './lib/errors.js'
import { createFsWatch } from './lib/fs-watch.js'
import { createPtyServer } from './lib/pty-server.js'
import { createPtySpawner } from './lib/pty.js'
import { createSidebarFs, statusOf, wireError } from './lib/sidebar-fs.js'
import { dataDir, loadState } from './lib/state.js'
import * as terminalHost from './lib/terminal-host.js'
import { createRemoteTool } from './lib/tool-remote.js'

export const name = 'remote-suite'
export const inject = ['tools', 'subprocess']

/** Route prefix of the JSON API the browser half calls. */
const API_BASE = '/remote-suite/api'

/** Where the browser half loads xterm from. */
const ASSET_BASE = '/remote-suite/assets'

/** WebSocket route for terminal sessions. */
const PTY_PATH = '/remote-suite/pty'

/**
 * The file API the right sidebar calls. The method names, payloads and response
 * shapes are better-sidebar's (`fs.tree`, `fs.read`, `fs.write`, …); only the
 * mount point is ours, so both plugins can be installed without shadowing.
 */
const SIDEBAR_BASE = '/remote-suite/sidebar'
const SIDEBAR_WATCH_PATH = '/remote-suite/sidebar/ws/fs-watch'

/** Largest request body the API accepts (a full editor buffer). */
const MAX_BODY_BYTES = 8 * 1024 * 1024
const MAX_UPLOAD_BYTES = 64 * 1024 * 1024

/** Only this plugin's own client calls the API; a custom header cannot be sent cross-site. */
const CLIENT_HEADER = 'x-remote-suite'

const HERE = dirname(fileURLToPath(import.meta.url))
const ASSET_ROOT = join(HERE, 'assets')

function readBodyBuffer(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
      size += buf.length
      if (size > limit) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(buf)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
      size += buf.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(buf)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(body)
}

/** A browser upgrade must come from this origin; a socket with no Origin (tests) is allowed. */
function sameOrigin(req) {
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

/**
 * Diagnostics: record what the desktop shell actually sends. A page served from
 * a custom scheme can fail to reach these routes, and without DevTools the only
 * evidence is what arrives (or does not) at the Host.
 */
/**
 * Append one diagnostic line per request: method, target, and the two headers the
 * trust fence reads. `host` and `origin` are what decide a refusal, so a 401/403
 * report from a user can be answered by reading this file.
 * @param req - the request the route received.
 * @param tag - route family, for reading the log.
 */
function trace(req, tag) {
  const line = `${new Date().toISOString()} ${tag} ${req.method} url=${req.url} host=${req.headers.host ?? '-'} origin=${req.headers.origin ?? '-'}\n`
  appendDebug(line)
}

/**
 * Append one diagnostic line that is not tied to a request.
 * @param line - already formatted text.
 */
function note(line) {
  appendDebug(`${new Date().toISOString()} note ${line}\n`)
}

/**
 * Best-effort append to `$DSH_HOME/remote-suite/debug.log`; never rejects.
 * @param line - one line of text.
 */
function appendDebug(line) {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const file = join(home, 'remote-suite', 'debug.log')
  mkdir(dirname(file), { recursive: true })
    .then(() => appendFile(file, line))
    .catch(() => {})
}

export function apply(ctx, config = {}) {
  const registry = createRegistry({
    config,
    spawnPty: createPtySpawner(ctx),
    savedProfiles: async () => (await loadState()).profiles,
  })
  const api = createApi({ registry })
  const disposers = [ctx.tools.register(createRemoteTool({ registry, config }))]

  // Every route below is reachable from the browser, so each handler asks the
  // composition's Connection service first: it owns the Host/Origin fence and the
  // browser session credential, and a page from another origin must not reach the
  // file API or a shell. A Host without that service keeps the plugin's own checks.
  const access = createAccessGate(ctx, ctx.logger, (status, req) => {
    note(`access reject ${status} ${req.method} ${req.url} origin=${req.headers.origin || '-'} host=${req.headers.host}`)
  })
  // The service is only readable from a Context that asked for it, and this plugin
  // does not declare `connection` in `inject` (a Host without a browser carrier has
  // none). Ask for a scope that has it and arm the gate as soon as it arrives.
  ctx.inject(['connection'], (scoped) => {
    const armed = access.attach(scoped.connection)
    note(`access gate ${armed ? 'armed' : 'skipped: no connection service'}`)
  })

  // The `sessions` service is what turns a sessionId into the working directory
  // whose files the sidebar should list. It is optional: a Host without it falls
  // back to the `cwd` the browser sends along.
  let sessionsService
  ctx.inject(['sessions'], (scoped) => {
    sessionsService = scoped.sessions
  })

  const sessionCwd = async (sessionId, clientCwd) => {
    try {
      const session = sessionsService?.get?.(sessionId)
      if (session !== undefined) {
        const workdir = ctx.get?.('workingDirectory')
        const cwd = (typeof workdir?.get === 'function' ? workdir.get(session) : undefined) ?? session?.header?.cwd
        if (typeof cwd === 'string' && cwd !== '') return cwd
      }
    } catch {
      // Fall through to whatever the browser knows.
    }
    return clientCwd
  }

  const sidebarFs = createSidebarFs({
    registry,
    mirrorsDir: join(dataDir(), 'mirrors'),
    sessionCwd,
  })

  const mountApi = (webServer) => {
    const dispose = webServer.register({
      kind: 'prefix',
      path: API_BASE,
      handler: async (req, res) => {
        trace(req, 'api')
        if (access.rejectRequest(req, res)) return
        try {
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, error: 'method not allowed' })
            return
          }
          if (req.headers[CLIENT_HEADER] !== '1') {
            sendJson(res, 403, { ok: false, error: 'forbidden' })
            return
          }
          const pathname = new URL(req.url || '/', 'http://remote-suite.invalid').pathname
          const method = pathname.slice(API_BASE.length).replace(/^\/+/, '')
          if (method === '' || method.includes('/')) {
            sendJson(res, 404, { ok: false, error: 'not found' })
            return
          }
          const fn = api[method]
          if (typeof fn !== 'function') {
            sendJson(res, 404, { ok: false, error: `unknown api method: ${method}` })
            return
          }
          const raw = await readBody(req)
          const args = raw === '' ? {} : JSON.parse(raw)
          const result = await fn(args)
          sendJson(res, 200, { ok: true, result })
        } catch (error) {
          sendJson(res, 200, { ok: false, error: explain(error) })
        }
      },
    })
    return dispose
  }

  const mountAssets = (webServer) => {
    const dispose = webServer.register({
      kind: 'prefix',
      path: ASSET_BASE,
      handler: async (req, res) => {
        if (access.rejectRequest(req, res)) return
        const pathname = new URL(req.url || '/', 'http://remote-suite.invalid').pathname
        const rel = decodeURIComponent(pathname.slice(ASSET_BASE.length)).replace(/^\/+/, '')
        const served = await serveAsset(ASSET_ROOT, rel, res)
        if (!served) {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('not found')
        }
      },
    })
    return dispose
  }

  /**
   * Better-sidebar's filesystem wire format, served by this plugin.
   *
   *   POST <base>/api/<method>   JSON in, `{ ok, value }` out
   *   POST <base>/write          raw UTF-8 body, query params
   *   GET  <base>/file           raw bytes with a content type
   *
   * `compat` serves the same handlers on better-sidebar's own paths
   * (`/sidebar/api/…`), so its UI reads our remote files when both are
   * installed: exact routes are matched before its prefix route, and the
   * browser cannot forge the header only our own page attaches.
   */
  const serveSidebar = async (req, res, rest, compat) => {
    if (access.rejectRequest(req, res)) return
    const url = new URL(req.url || '/', 'http://remote-suite.invalid')
    const query = {
      sessionId: url.searchParams.get('sessionId') ?? undefined,
      cwd: url.searchParams.get('cwd') ?? undefined,
      path: url.searchParams.get('path') ?? undefined,
      dir: url.searchParams.get('dir') ?? undefined,
      relativePath: url.searchParams.get('relativePath') ?? undefined,
      expectedMtimeMs: (() => {
        const raw = url.searchParams.get('expectedMtimeMs')
        const parsed = raw === null ? Number.NaN : Number(raw)
        return Number.isFinite(parsed) ? parsed : undefined
      })(),
    }
    try {
      // Our own page proves itself with a header. `/file` is fetched by the
      // img/audio tags of the panel, which cannot set one, so that route falls
      // back to a same-origin check instead; a `compat` request comes from
      // better-sidebar's UI and can only be checked for the same origin.
      if (compat) {
        if (!sameOrigin(req)) {
          sendJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
          return
        }
      } else if (req.headers[CLIENT_HEADER] !== '1' && (rest !== '/file' || !sameOrigin(req))) {
        sendJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
        return
      }
      if (rest === '/write') {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: { code: 'method-error', message: 'method not allowed' } })
          return
        }
        const content = await readBody(req)
        const written = await sidebarFs.writeText({ ...query, content })
        sidebarFs.invalidate()
        sendJson(res, 200, { ok: true, value: { ok: true, mtimeMs: written.mtimeMs } })
        return
      }
      if (rest === '/upload') {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: { code: 'method-error', message: 'method not allowed' } })
          return
        }
        const data = await readBodyBuffer(req, MAX_UPLOAD_BYTES)
        const value = await sidebarFs.upload({
          sessionId: query.sessionId,
          cwd: query.cwd,
          dir: query.dir,
          relativePath: query.relativePath,
          data,
        })
        sidebarFs.invalidate(query.dir)
        sendJson(res, 200, { ok: true, value })
        return
      }
      if (rest === '/file') {
        if (req.method !== 'GET') {
          sendJson(res, 405, { ok: false, error: { code: 'method-error', message: 'method not allowed' } })
          return
        }
        const file = await sidebarFs.readAll(query)
        const total = file.buffer.length
        const range = typeof req.headers.range === 'string' ? /^bytes=(\d*)-(\d*)$/.exec(req.headers.range.trim()) : null
        const headers = {
          'content-type': mediaType(file.path),
          'cache-control': 'no-cache',
          'accept-ranges': 'bytes',
          'x-content-type-options': 'nosniff',
          'referrer-policy': 'no-referrer',
        }
        if (range !== null) {
          const start = range[1] === '' ? 0 : Number(range[1])
          const end = range[2] === '' ? total - 1 : Math.min(Number(range[2]), total - 1)
          if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= total) {
            res.writeHead(416, { 'content-range': `bytes */${total}` })
            res.end()
            return
          }
          res.writeHead(206, { ...headers, 'content-length': String(end - start + 1), 'content-range': `bytes ${start}-${end}/${total}` })
          res.end(file.buffer.subarray(start, end + 1))
          return
        }
        res.writeHead(200, { ...headers, 'content-length': String(total) })
        res.end(file.buffer)
        return
      }
      if (rest.startsWith('/api/')) {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: { code: 'method-error', message: 'method not allowed' } })
          return
        }
        const method = rest.slice('/api/'.length)
        const fn = sidebarFs.methods[method]
        if (typeof fn !== 'function') {
          sendJson(res, 404, { ok: false, error: { code: 'not-found', message: `unknown fs method: ${method}` } })
          return
        }
        const raw = await readBody(req)
        const payload = raw === '' ? {} : JSON.parse(raw)
        const value = await fn(payload === null || typeof payload !== 'object' ? {} : payload)
        if (method !== 'fs.tree' && method !== 'fs.trees' && method !== 'fs.read' && method !== 'fs.readPage' && method !== 'fs.search') {
          sidebarFs.invalidate()
        }
        sendJson(res, 200, { ok: true, value })
        return
      }
      sendJson(res, 404, { ok: false, error: { code: 'not-found', message: 'not found' } })
    } catch (error) {
      sendJson(res, statusOf(error), { ok: false, error: wireError(error) })
    }
  }

  const mountSidebar = (webServer) =>
    webServer.register({
      kind: 'prefix',
      path: SIDEBAR_BASE,
      handler: async (req, res) => {
        const url = new URL(req.url || '/', 'http://remote-suite.invalid')
        await serveSidebar(req, res, url.pathname.slice(SIDEBAR_BASE.length) || '/', false)
      },
    })

  /**
   * The same handlers on better-sidebar's own paths. Exact routes are matched
   * before its `/sidebar/api` prefix route, so with both plugins installed its
   * panel shows our remote files; without it these routes are never called.
   */
  const mountSidebarCompat = (webServer) => {
    const paths = ['/write', '/upload', '/file', ...Object.keys(sidebarFs.methods).map((method) => `/api/${method}`)]
    const offs = []
    for (const rest of paths) {
      // One path at a time: `@zhangfengshun/dsh-remote-ssh` claims the same exact
      // `/sidebar/api/*` paths, and the host refuses a duplicate `(kind, path)`
      // pair. Losing one route must not cost the other eleven.
      try {
        offs.push(
          webServer.register({
            kind: 'exact',
            path: '/sidebar' + rest,
            handler: (req, res) => serveSidebar(req, res, rest, true),
          }),
        )
      } catch (error) {
        console.warn('remote-suite: the compatibility route /sidebar' + rest + ' is already taken, skipping it', error)
      }
    }
    return () => {
      for (const off of offs) {
        try {
          off()
        } catch {
          // Already disposed.
        }
      }
    }
  }

  // `webServer` is optional: a bare CLI host has no routes to serve, and the
  // `remote` tool must keep working there.
  //
  // Every mount is guarded on its own: another plugin that already registered one
  // of these paths (the `/sidebar/api/*` exact routes are shared with
  // `@zhangfengshun/dsh-remote-ssh`) throws `webserver: duplicate … route`, and
  // that must cost only that one route — not the PTY, the watch socket and the
  // whole terminal half that come after it.
  const offWeb = ctx.inject(['webServer'], (scoped) => {
    const mount = (label, run) => {
      try {
        const off = run()
        if (typeof off === 'function') disposers.push(off)
      } catch (error) {
        console.error('remote-suite: ' + label + ' could not be mounted', error)
      }
    }

    mount('the API routes', () => mountApi(scoped.webServer))
    mount('the asset routes', () => mountAssets(scoped.webServer))
    mount('the sidebar routes', () => mountSidebar(scoped.webServer))
    mount('the better-sidebar compatibility routes', () => mountSidebarCompat(scoped.webServer))

    mount('the PTY server', () => {
      const pty = createPtyServer({ registry, WebSocketServer: loadWebSocketServer() })
      let off
      try {
        off = scoped.webServer.registerUpgrade({
          path: PTY_PATH,
          handler: (req, socket, head) => {
            trace(req, 'ws')
            if (access.rejectUpgrade(req, socket)) return
            if (!sameOrigin(req)) {
              try {
                socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
              } catch {
                // Socket already closed.
              }
              socket.destroy()
              return
            }
            pty.upgrade(req, socket, head)
          },
        })
      } catch (error) {
        // The path is taken by another plugin: do not leak the PTY server we
        // just built for a socket nobody can reach.
        pty.dispose()
        throw error
      }
      return () => {
        try {
          off()
        } catch {
          // Already disposed.
        }
        pty.dispose()
      }
    })

    // The watch socket: same origin fence as the PTY, then our polling watcher.
    mount('the file watch socket', () => {
      const watch = createFsWatch({ sidebarFs, WebSocketServer: loadWebSocketServer() })
      let off
      try {
        off = scoped.webServer.registerUpgrade({
          path: SIDEBAR_WATCH_PATH,
          handler: (req, socket, head) => {
            if (access.rejectUpgrade(req, socket)) return
            if (!sameOrigin(req)) {
              try {
                socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
              } catch {
                // Socket already closed.
              }
              socket.destroy()
              return
            }
            watch.upgrade(req, socket, head)
          },
        })
      } catch (error) {
        watch.dispose()
        throw error
      }
      return () => {
        try {
          off()
        } catch {
          // Already disposed.
        }
        watch.dispose()
      }
    })

    // The terminal half: its own PTY routes plus the detached helper process that
    // owns the shells (see lib/terminal-host.js). It registers its own effects, so
    // disposing the injection above tears it down with the rest.
    //
    // The injected scope only carries `webServer`, so hand the terminal half a
    // small face that borrows the outer context's `effect` (whose disposers this
    // plugin's own teardown already runs).
    try {
      terminalHost.apply({
        webServer: scoped.webServer,
        logger: ctx.logger,
        gate: access,
        effect: (fn, label) => (typeof ctx.effect === 'function' ? ctx.effect(fn, label) : fn()),
      })
    } catch (error) {
      console.error('remote-suite: mounting the terminal routes failed', error)
    }
    // better-sidebar's own `/sidebar/ws/fs-watch` socket is deliberately left
    // alone: one socket has one protocol owner and a second registration throws
    // inside its apply, which would break that plugin. Its panel therefore keeps
    // its own (local-only) watcher when both are installed.
  })

  // A configuration change is a remount, not something a running session
  // re-reads; dispose everything this mount created.
  return () => {
    try {
      if (typeof offWeb === 'function') offWeb()
    } catch (error) {
      console.error('remote-suite: disposing the webServer injection failed', error)
    }
    for (const dispose of disposers) {
      try {
        if (typeof dispose === 'function') dispose()
      } catch (error) {
        console.error('remote-suite: disposing a registration failed', error)
      }
    }
    registry.dispose()
    if (typeof api.dispose === 'function') api.dispose()
  }
}

/** Content type for a preview/download route, by extension. */
const MEDIA_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  txt: 'text/plain; charset=utf-8',
  log: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  json: 'application/json; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  html: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
}

function mediaType(path) {
  const match = /\.([a-z0-9]+)$/i.exec(String(path))
  const ext = match === null ? '' : match[1].toLowerCase()
  return MEDIA_TYPES[ext] ?? 'application/octet-stream'
}

/**
 * `ws` is a dependency of this package, but the require is deferred so a host
 * without the browser half never pays for it.
 */
function loadWebSocketServer() {
  try {
    const require = createRequire(import.meta.url)
    return require('ws').WebSocketServer
  } catch (error) {
    throw new Error(`remote-suite: the "ws" dependency is missing (${error instanceof Error ? error.message : String(error)})`)
  }
}
