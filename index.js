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
import { createApi } from './lib/api.js'
import { serveAsset } from './lib/assets.js'
import { createRegistry } from './lib/backends/index.js'
import { explain } from './lib/errors.js'
import { createPtyServer } from './lib/pty-server.js'
import { createPtySpawner } from './lib/pty.js'
import { loadState } from './lib/state.js'
import { createRemoteTool } from './lib/tool-remote.js'

export const name = 'remote-suite'
export const inject = ['tools', 'subprocess']

/** Route prefix of the JSON API the browser half calls. */
const API_BASE = '/remote-suite/api'

/** Where the browser half loads xterm from. */
const ASSET_BASE = '/remote-suite/assets'

/** WebSocket route for terminal sessions. */
const PTY_PATH = '/remote-suite/pty'

/** Largest request body the API accepts (a full editor buffer). */
const MAX_BODY_BYTES = 8 * 1024 * 1024

/** Only this plugin's own client calls the API; a custom header cannot be sent cross-site. */
const CLIENT_HEADER = 'x-remote-suite'

const HERE = dirname(fileURLToPath(import.meta.url))
const ASSET_ROOT = join(HERE, 'assets')

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
function trace(req, tag) {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const file = join(home, 'remote-suite', 'debug.log')
  const line = `${new Date().toISOString()} ${tag} ${req.method} url=${req.url} host=${req.headers.host} origin=${req.headers.origin || '-'} ua=${String(req.headers['user-agent'] || '-').slice(0, 40)}\n`
  mkdir(dirname(file), { recursive: true })
    .then(() => appendFile(file, line))
    .catch(() => {})
}

export function apply(ctx, config = {}) {
  const registry = createRegistry({
    config,
    spawnPty: createPtySpawner(ctx),
    savedProfiles: async () => (await loadState()).profiles,
    hiddenProfiles: async () => (await loadState()).hiddenProfiles,
  })
  const api = createApi({ registry })
  const disposers = [ctx.tools.register(createRemoteTool({ registry, config }))]

  const mountApi = (webServer) => {
    const dispose = webServer.register({
      kind: 'prefix',
      path: API_BASE,
      handler: async (req, res) => {
        trace(req, 'api')
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

  // `webServer` is optional: a bare CLI host has no routes to serve, and the
  // `remote` tool must keep working there.
  const offWeb = ctx.inject(['webServer'], (scoped) => {
    try {
      disposers.push(mountApi(scoped.webServer))
      disposers.push(mountAssets(scoped.webServer))
      const pty = createPtyServer({ registry, WebSocketServer: loadWebSocketServer() })
      disposers.push(() => pty.dispose())
      disposers.push(
        scoped.webServer.registerUpgrade({
          path: PTY_PATH,
          handler: (req, socket, head) => {
            trace(req, 'ws')
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
        }),
      )
    } catch (error) {
      console.error('remote-suite: mounting routes failed', error)
    }
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
