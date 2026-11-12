// SSH backend: one `ssh2` connection per target, reused across calls.
//
// File operations go through SFTP; grep/glob run as remote commands (like the
// WSL backend, which also pushes pattern matching to the far side — walking a
// remote tree over SFTP one stat at a time is both slow and noisy). Paths are
// POSIX, so `join` delegates to path.posix no matter what the local platform is.

import ssh2 from 'ssh2'
import { existsSync, promises as fsp } from 'node:fs'
import { homedir } from 'node:os'
import posix from 'node:path/posix'
import { MAX_OUTPUT_BYTES, truncate } from './base.js'
import { globToRegExp, isAbsoluteRemote } from '../fs-util.js'
import { clampSize } from '../pty.js'
import { readSshConfig } from '../ssh-config.js'
import { lookupPassword } from '../secrets.js'
import { openTunnel as createTunnel } from '../tunnel.js'

const { Client } = ssh2

const DEFAULT_KEYS = ['id_ed25519', 'id_rsa', 'id_ecdsa']
const MAX_FIND_FILES = 20_000

/** Quote one shell word for POSIX sh. */
function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

function isBlank(value) {
  return typeof value !== 'string' || value.trim() === ''
}

function describeError(error) {
  return error instanceof Error ? error.message : String(error)
}

/** Candidate private keys for a profile, most specific first, existing files only. */
async function resolveKeys(profile) {
  const candidates = []
  if (!isBlank(process.env.DSH_SSH_IDENTITY)) {
    candidates.push(...process.env.DSH_SSH_IDENTITY.split(';').map((p) => p.trim()).filter(Boolean))
  }
  candidates.push(...(Array.isArray(profile.identityFiles) ? profile.identityFiles : []))
  for (const name of DEFAULT_KEYS) candidates.push(posix.join(homedir().replace(/\\/g, '/'), '.ssh', name))

  const keys = []
  for (const candidate of candidates) {
    const path = candidate.replace(/^~(?=$|[\\/])/, homedir())
    try {
      await fsp.access(path)
      keys.push({ path, data: await fsp.readFile(path) })
    } catch {
      // Missing or unreadable candidate: just try the next one.
    }
  }
  return keys
}

function agentHandle() {
  if (!isBlank(process.env.SSH_AUTH_SOCK)) return process.env.SSH_AUTH_SOCK
  if (process.platform === 'win32') {
    const pipe = '\\\\.\\pipe\\openssh-ssh-agent'
    if (existsSync(pipe)) return pipe
  }
  return undefined
}

function collect(stream, timeoutMs) {
  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    let truncated = false
    let timedOut = false

    const timer = setTimeout(() => {
      timedOut = true
      stream.close()
    }, timeoutMs)

    stream.on('data', (chunk) => {
      if (stdout.length < MAX_OUTPUT_BYTES) {
        const capped = truncate(String(chunk), MAX_OUTPUT_BYTES)
        if (capped.truncated) truncated = true
        stdout += capped.text
      }
    })
    stream.stderr.on('data', (chunk) => {
      if (stderr.length < MAX_OUTPUT_BYTES) {
        const capped = truncate(String(chunk), MAX_OUTPUT_BYTES)
        if (capped.truncated) truncated = true
        stderr += capped.text
      }
    })
    stream.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    stream.on('close', (code) => {
      clearTimeout(timer)
      resolve({ stdout, stderr, exitCode: code ?? -1, timedOut, truncated })
    })
  })
}

async function runCommand(client, command, timeoutMs) {
  const stream = await new Promise((resolve, reject) => {
    client.exec(command, (error, channel) => (error === undefined || error === null ? resolve(channel) : reject(error)))
  })
  return collect(stream, timeoutMs)
}

async function openSftp(client) {
  return new Promise((resolve, reject) => {
    client.sftp((error, sftp) => (error === undefined || error === null ? resolve(sftp) : reject(error)))
  })
}

async function sftpMkdirp(sftp, dir) {
  if (dir === '' || dir === '/' || dir === '.') return
  const parts = dir.split('/').filter(Boolean)
  let current = dir.startsWith('/') ? '' : '.'
  for (const part of parts) {
    current = current === '' ? `/${part}` : `${current}/${part}`
    await new Promise((resolve) => sftp.mkdir(current, () => resolve()))
  }
}

/**
 * @param {object} options
 * @param {string} options.id          target id, `ssh:<alias>` or `daemon:<alias>`
 * @param {object} options.profile     { alias, hostname, user, port, identityFiles, proxyJump }
 * @param {Array<object>} [options.profiles]  all known profiles, for ProxyJump lookups
 * @param {boolean} [options.persistent]  reuse one non-interactive bash channel for every
 *   `exec`, so `cd` and shell exports survive between calls (`daemon:<alias>` targets)
 */
export function createSshBackend({ id, profile: initialProfile, profiles = [], persistent = false }) {
  let profile = initialProfile
  let client = null
  let pending = null
  let sftpSession = null
  let homeCache = null
  let session = null
  let execQueue = Promise.resolve()
  const tunnels = new Set()

  function baseOptions(target) {
    return {
      host: target.hostname ?? target.alias,
      port: target.port ?? 22,
      username: target.user ?? (process.env.USER || process.env.USERNAME || 'root'),
      readyTimeout: 20_000,
      keepaliveInterval: 15_000,
      keepaliveCountMax: 3,
    }
  }

  async function connectWithAuth(target, extra = {}) {
    const keys = await resolveKeys(target)
    const agent = agentHandle()
    const password =
      typeof process.env.DSH_SSH_PASSWORD === 'string' && process.env.DSH_SSH_PASSWORD !== ''
        ? process.env.DSH_SSH_PASSWORD
        : await lookupPassword(target)
    const attempts = [
      ...keys.map((key) => ({ privateKey: key.data })),
      ...(agent === undefined ? [] : [{ agent }]),
      ...(password === undefined ? [] : [{ password }]),
    ]

    if (attempts.length === 0) {
      throw new Error(
        `ssh: no identity or password for ${target.alias} — add IdentityFile to ~/.ssh/config, set DSH_SSH_IDENTITY, start ssh-agent, or store a password with remote { action: 'secret-set' }`,
      )
    }

    let lastError
    for (const attempt of attempts) {
      const client = new Client()
      try {
        await new Promise((resolve, reject) => {
          client.on('ready', resolve)
          client.on('error', reject)
          if (attempt.password !== undefined) {
            // Some servers only advertise keyboard-interactive, not `password`.
            client.on('keyboard-interactive', (_name, _instructions, _language, _prompts, finish) =>
              finish([attempt.password]),
            )
          }
          client.connect({
            ...baseOptions(target),
            ...extra,
            ...attempt,
            ...(attempt.password === undefined ? {} : { tryKeyboard: true }),
          })
        })
        client.on('error', () => {})
        return client
      } catch (error) {
        lastError = error
        client.destroy()
      }
    }
    throw new Error(`ssh: cannot connect to ${profile.alias}: ${describeError(lastError)}`)
  }

  /** `user@host:port`, or an alias from `~/.ssh/config` (its options win). */
  function resolveHop(spec) {
    const at = spec.lastIndexOf('@')
    const user = at === -1 ? undefined : spec.slice(0, at)
    const rest = at === -1 ? spec : spec.slice(at + 1)
    const colon = rest.lastIndexOf(':')
    const host = colon === -1 ? rest : rest.slice(0, colon)
    const port = colon === -1 ? undefined : Number(rest.slice(colon + 1))
    const known = profiles.find((entry) => entry.alias === host)
    if (known !== undefined) {
      return {
        ...known,
        ...(user === undefined ? {} : { user }),
        ...(Number.isInteger(port) ? { port } : {}),
      }
    }
    return { alias: host, hostname: host, ...(user === undefined ? {} : { user }), ...(Number.isInteger(port) ? { port } : {}) }
  }

  function forwardThrough(conn, target) {
    return new Promise((resolve, reject) => {
      conn.forwardOut('127.0.0.1', 0, target.hostname ?? target.alias, target.port ?? 22, (error, channel) => {
        if (error === undefined || error === null) resolve(channel)
        else reject(error)
      })
    })
  }

  /**
   * Connect to `target`, walking any ProxyJump chain (`a,b,c` = through b and c).
   * Each hop is a full connection of its own, so a hop may itself carry a jump.
   */
  async function dial(target, seen = []) {
    const specs = isBlank(target.proxyJump)
      ? []
      : target.proxyJump.split(',').map((part) => part.trim()).filter(Boolean)
    if (specs.length === 0) return connectWithAuth(target)
    if (seen.includes(target.alias)) {
      throw new Error(`ssh: ProxyJump loop at ${target.alias}`)
    }

    const hops = specs.map(resolveHop)
    let current = await dial(hops[0], [...seen, target.alias])
    try {
      for (const hop of hops.slice(1)) {
        const stream = await forwardThrough(current, hop)
        const next = await connectWithAuth(hop, { sock: stream })
        next.on('close', () => current.end())
        current = next
      }
      const stream = await forwardThrough(current, target)
      const client = await connectWithAuth(target, { sock: stream })
      client.on('close', () => current.end())
      return client
    } catch (error) {
      current.end()
      throw error
    }
  }

  async function getClient() {
    if (client !== null) return client
    if (pending !== null) return pending

    pending = dial(profile).then(
      (connected) => {
        client = connected
        client.once('close', () => {
          client = null
          sftpSession = null
        })
        pending = null
        return connected
      },
      async (error) => {
        pending = null
        // ~/.ssh/config may have been edited while a backend was cached (a new
        // IdentityFile is the usual case). Re-read it once before giving up.
        if (isAuthError(error)) {
          const refreshed = reloadProfile()
          if (refreshed !== null) {
            const connected = await dial(refreshed)
            client = connected
            client.once('close', () => {
              client = null
              sftpSession = null
            })
            profile = refreshed
            return connected
          }
        }
        throw error
      },
    )
    return pending
  }

  function isAuthError(error) {
    const text = error instanceof Error ? error.message : String(error)
    return /authentication methods failed|no identity or password|permission denied|publickey/i.test(text)
  }

  /** Re-read this alias from `~/.ssh/config`; null when nothing usable changed. */
  function reloadProfile() {
    try {
      const fresh = readSshConfig(process.env.DSH_SSH_CONFIG).find((entry) => entry.alias === profile.alias)
      if (fresh === undefined) return null
      const merged = { ...profile, ...fresh }
      const same =
        JSON.stringify(merged.identityFiles ?? []) === JSON.stringify(profile.identityFiles ?? []) &&
        merged.user === profile.user &&
        merged.port === profile.port &&
        merged.hostname === profile.hostname &&
        merged.proxyJump === profile.proxyJump
      return same ? null : merged
    } catch {
      return null
    }
  }

  /**
   * A dropped connection shows up as an error on whichever operation happened to
   * be running. Nothing in the backend is stateful enough to make a second try
   * unsafe, so one transparent reconnect is a better experience than a transient
   * failure the caller would have to retry by hand.
   */
  function isConnectionError(error) {
    const text = error instanceof Error ? error.message : String(error)
    return /ECONNRESET|EPIPE|ECONNABORTED|channel closed|client is not connected|no response from server|connection lost|socket closed|timed out while waiting/i.test(text)
  }

  function dropConnection() {
    pending = null
    sftpSession = null
    if (session !== null) session = null
    if (client !== null) {
      try {
        client.end()
      } catch {
        // already gone
      }
      client = null
    }
  }

  async function guarded(operation) {
    try {
      return await operation()
    } catch (error) {
      if (!isConnectionError(error)) throw error
      dropConnection()
      return operation()
    }
  }

  async function withSftp(fn) {
    const connected = await getClient()
    if (sftpSession === null) {
      sftpSession = await openSftp(connected)
      sftpSession.on('error', () => {
        sftpSession = null
      })
      sftpSession.on('close', () => {
        sftpSession = null
      })
    }
    try {
      return await fn(sftpSession)
    } catch (error) {
      // A dead SFTP channel is not recoverable; drop it and let the next call reopen.
      if (error && typeof error === 'object' && error.code === 'ENOENT') throw error
      sftpSession = null
      throw error
    }
  }

  // --- persistent session (`daemon:<alias>` targets) -----------------------
  //
  // One non-interactive `bash` channel per target: no PTY, no prompt, no line
  // editing, but every command runs in the same shell, so `cd` and exports
  // survive between `exec` calls. Commands are serialized through a queue, and
  // each one ends with an escaped marker carrying `$?`.

  async function ensureSession() {
    if (session !== null && !session.closed) return session
    const connected = await getClient()
    const stream = await new Promise((resolve, reject) => {
      connected.exec('bash', (error, channel) =>
        error === undefined || error === null ? resolve(channel) : reject(error),
      )
    })
    const state = { stream, buffer: '', closed: false, wake: null }
    const wake = () => {
      const pendingWake = state.wake
      state.wake = null
      if (pendingWake !== null) pendingWake()
    }
    stream.setEncoding('utf8')
    stream.on('data', (chunk) => {
      state.buffer += chunk
      wake()
    })
    stream.on('close', () => {
      state.closed = true
      wake()
    })
    stream.on('error', () => {
      state.closed = true
      wake()
    })
    session = state
    return state
  }

  function dropSession(state) {
    if (session === state) session = null
    try {
      state.stream.close()
    } catch {
      // already closed
    }
  }

  async function runInSession(command, workdir, timeoutMs) {
    const state = await ensureSession()
    const token = `rs${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
    const marker = `\u0001${token}:`
    const directory = isBlank(workdir) ? undefined : await expand(workdir)
    const lines = directory === undefined
      ? [`{ ${command}`, '} 2>&1']
      : [`if cd ${shQuote(directory)} 2>/dev/null; then`, `{ ${command}`, '} 2>&1', 'else', `echo "remote: no such directory: ${directory}"; false; fi`]

    state.buffer = ''
    state.stream.write(`${lines.join('\n')}\nprintf '\\001${token}:%s\\001\\n' "$?"\n`)

    const deadline = Date.now() + timeoutMs
    for (;;) {
      const start = state.buffer.indexOf(marker)
      if (start !== -1) {
        const end = state.buffer.indexOf('\u0001', start + marker.length)
        if (end !== -1) {
          const code = Number.parseInt(state.buffer.slice(start + marker.length, end).trim(), 10)
          return {
            stdout: state.buffer.slice(0, start),
            stderr: '',
            exitCode: Number.isInteger(code) ? code : 0,
            timedOut: false,
          }
        }
      }
      if (state.closed) {
        session = null
        throw new Error('ssh: the daemon session closed')
      }
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        dropSession(state)
        return { stdout: truncate(state.buffer).text, stderr: '', exitCode: null, timedOut: true }
      }
      await new Promise((resolve) => {
        state.wake = resolve
        setTimeout(resolve, Math.min(remaining, 250))
      })
    }
  }

  async function execPersistent(command, workdir, timeoutMs) {
    const attempt = async () => {
      const result = await runInSession(command, workdir, timeoutMs)
      return { ...result, stdout: truncate(result.stdout).text }
    }
    const run = async () => {
      try {
        return await attempt()
      } catch (error) {
        if (error instanceof Error && error.message.includes('session closed')) {
          // The command ran `exit` (or the channel dropped): the shell is gone,
          // not the target. Report it, and let the next call open a fresh one.
          session = null
          return {
            stdout: '',
            stderr: 'remote: the session ended while running this command (did it call exit?) — a fresh session will be used next time',
            exitCode: null,
            timedOut: false,
          }
        }
        if (isConnectionError(error)) {
          dropConnection()
          return attempt()
        }
        throw error
      }
    }
    const queued = execQueue.then(run, run)
    execQueue = queued.then(() => undefined, () => undefined)
    return queued
  }

  function wrap(command, workdir) {
    if (isBlank(workdir)) return command
    return `cd ${shQuote(workdir)} && ${command}`
  }

  /** The remote `$HOME`, fetched once. Absolute paths stay untouched. */
  async function remoteHome() {
    if (homeCache !== null) return homeCache
    try {
      const result = await guarded(async () => runCommand(await getClient(), 'printf %s "$HOME"', 15_000))
      homeCache = result.stdout.trim() || '/'
    } catch {
      homeCache = '/'
    }
    return homeCache
  }

  async function expand(path) {
    if (isBlank(path)) return path
    if (path === '~') return remoteHome()
    if (path.startsWith('~/')) return posix.join(await remoteHome(), path.slice(2))
    return path
  }

  return {
    id,
    kind: persistent ? 'daemon' : 'ssh',
    label: persistent ? `${profile.alias} (session)` : profile.alias,
    profile,

    home() {
      return '~'
    },

    join(base, rel) {
      if (isAbsoluteRemote(rel)) return rel
      return posix.join(base, rel)
    },

    async probe() {
      const result = await this.exec({
        command: 'uname -s 2>/dev/null; uname -m 2>/dev/null; whoami 2>/dev/null; pwd 2>/dev/null; command -v node 2>/dev/null || true',
        timeoutMs: 15_000,
      })
      const [system, machine, user, cwd, node] = result.stdout.split('\n')
      return {
        kind: persistent ? 'daemon' : 'ssh',
        alias: profile.alias,
        host: profile.hostname,
        system,
        machine,
        user,
        cwd,
        node: node || '(none)',
      }
    },

    async exec({ command, workdir, timeoutMs = 120_000 }) {
      if (isBlank(command)) throw new Error('remote: exec needs a non-empty command')
      if (persistent) return execPersistent(command, workdir, timeoutMs)
      return guarded(async () =>
        runCommand(await getClient(), wrap(command, await expand(workdir)), timeoutMs),
      )
    },

    /**
     * Open an interactive shell on the host, on the connection already in use.
     *
     * The channel is a real PTY on the remote side (`term`, `cols`, `rows` are
     * sent in the `shell` request), so line editing, colours and `top` all work.
     * A `cwd` is applied with one `cd` after the channel opens — the remote shell
     * itself decides what exists, so an invalid directory is reported by the
     * shell rather than swallowed here.
     *
     * @param {{ cwd?: string, cols?: number, rows?: number, signal?: AbortSignal }} [options]
     * @returns a handle shaped like the Host PTY handle
     */
    async openTerminal({ cwd, cols, rows, signal } = {}) {
      return guarded(async () => {
        const connected = await getClient()
        const size = clampSize(cols, rows)
        const stream = await new Promise((resolve, reject) => {
          connected.shell({ term: 'xterm-256color', cols: size.cols, rows: size.rows }, (error, channel) =>
            error === undefined || error === null ? resolve(channel) : reject(error),
          )
        })
        const directory = cwd === undefined || cwd === '' ? undefined : await expand(cwd)
        if (directory !== undefined) stream.write(`cd ${shQuote(directory)} 2>/dev/null\r`)
        const done = new Promise((resolve) => {
          stream.on('close', (code, exitSignal) => resolve({ exitCode: code ?? null, signal: exitSignal ?? null }))
        })
        if (signal !== undefined && typeof signal.addEventListener === 'function') {
          if (signal.aborted) stream.close()
          else signal.addEventListener('abort', () => stream.close(), { once: true })
        }
        return {
          output: stream,
          done,
          write: (data) => {
            stream.write(data)
          },
          resize: (colCount, rowCount) => stream.setWindow(rowCount, colCount, 0, 0),
          terminate: async () => {
            stream.close()
          },
        }
      })
    },

    async read({ path, maxBytes = 256 * 1024, offset, limit }) {
      path = await expand(path)
      return guarded(async () => {
        const stats = await withSftp((sftp) => new Promise((resolve, reject) => {
          sftp.stat(path, (error, value) => (error === undefined || error === null ? resolve(value) : reject(error)))
        }))
        if (stats.isDirectory()) throw new Error(`remote: not a file: ${path}`)
        const buffer = await withSftp((sftp) => new Promise((resolve, reject) => {
          sftp.readFile(path, (error, data) => (error === undefined || error === null ? resolve(data) : reject(error)))
        }))

        let body = buffer
        let suffix = ''
        if (buffer.byteLength > maxBytes) {
          body = buffer.subarray(0, maxBytes)
          suffix = `\n[truncated: file is ${stats.size} bytes]`
        }
        let text = body.toString('utf8')
        if (offset !== undefined || limit !== undefined) {
          const lines = text.split('\n')
          const start = Math.max(0, (offset ?? 1) - 1)
          const end = limit === undefined ? lines.length : start + limit
          text = lines.slice(start, end).join('\n')
        }
        return text + suffix
      })
    },

    async write({ path, data }) {
      path = await expand(path)
      const text = typeof data === 'string' ? data : ''
      await guarded(async () => {
        await withSftp(async (sftp) => {
          await sftpMkdirp(sftp, posix.dirname(path))
          await new Promise((resolve, reject) => {
            sftp.writeFile(path, text, 'utf8', (error) => (error === undefined || error === null ? resolve() : reject(error)))
          })
        })
      })
      return { bytes: Buffer.byteLength(text, 'utf8') }
    },

    async stat({ path }) {
      path = await expand(path)
      return guarded(async () => {
        const stats = await withSftp((sftp) => new Promise((resolve, reject) => {
          sftp.stat(path, (error, value) => (error === undefined || error === null ? resolve(value) : reject(error)))
        }))
        return {
          type: stats.isDirectory() ? 'dir' : stats.isFile() ? 'file' : 'other',
          size: stats.size,
          mtimeMs: stats.mtime * 1000,
          mode: stats.mode,
        }
      })
    },

    async list({ path, limit = 500 }) {
      path = await expand(path)
      return guarded(async () => {
        const entries = await withSftp((sftp) => new Promise((resolve, reject) => {
          sftp.readdir(path, (error, value) => (error === undefined || error === null ? resolve(value) : reject(error)))
        }))
        const out = entries.slice(0, limit).map((entry) => ({
          name: entry.filename,
          type: entry.attrs.isDirectory() ? 'dir' : entry.attrs.isFile() ? 'file' : 'other',
          size: entry.attrs.size ?? 0,
        }))
        return { entries: out, truncated: entries.length > limit }
      })
    },

    async grep({ pattern, path, glob, maxResults = 100, ignoreCase = false }) {
      if (isBlank(pattern)) throw new Error('remote: grep needs a non-empty pattern')
      path = await expand(path)
      const flags = ignoreCase ? '-i' : ''
      const useGlob = !isBlank(glob)
      // rg understands `--glob` natively; GNU grep's `--include` is
      // basename-only and `**/` patterns silently match nothing there, so the
      // grep branch searches everything and the glob filter is applied here.
      const command = [
        `cd ${shQuote(path)} && {`,
        'if command -v rg >/dev/null 2>&1; then',
        `rg --no-heading -n ${flags} ${useGlob ? `--glob ${shQuote(glob)}` : ''} -e ${shQuote(pattern)} -- .`,
        'else',
        `grep -rnIE ${flags} -e ${shQuote(pattern)} -- .`,
        'fi',
        `} | head -n ${maxResults + 1}`,
      ].join('\n')

      return guarded(async () => {
        const result = await runCommand(await getClient(), command, 120_000)
        const matcher = useGlob ? globToRegExp(glob) : null
        const hits = []
        for (const line of result.stdout.split('\n')) {
          if (hits.length >= maxResults) break
          const match = /^(.*?):(\d+):(.*)$/.exec(line)
          if (match === null) continue
          const file = match[1].replace(/^\.\//, '')
          if (matcher !== null && !matcher.test(file)) continue
          hits.push({ file, line: Number(match[2]), text: match[3].slice(0, 400) })
        }
        return { hits, truncated: hits.length >= maxResults }
      })
    },

    /**
     * Forward one remote port to a loopback listener on this machine.
     *
     * This is how a remote web UI (a `dsh web`, a dev server, a notebook) can be
     * embedded in the workspace view without another SSH connection or exposing
     * the remote host to the network.
     */
    async openTunnel({ host = '127.0.0.1', port } = {}) {
      if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        throw new Error('remote: forward needs a port between 1 and 65535')
      }
      return guarded(async () => {
        const connected = await getClient()
        const tunnel = await createTunnel(connected, host, port)
        tunnels.add(tunnel)
        return tunnel
      })
    },

    async glob({ pattern, root = '.', maxResults = 500 }) {
      if (isBlank(pattern)) throw new Error('remote: glob needs a non-empty pattern')
      root = await expand(root)
      const command = `cd ${shQuote(root)} && find . -type f -print | head -n ${MAX_FIND_FILES}`
      return guarded(async () => {
        const result = await runCommand(await getClient(), command, 120_000)
        const matcher = globToRegExp(pattern)
        const files = []
        for (const raw of result.stdout.split('\n')) {
          if (files.length >= maxResults) break
          if (raw === '') continue
          const rel = raw.replace(/^\.\//, '')
          if (matcher.test(rel)) files.push(rel)
        }
        return { files, truncated: files.length >= maxResults }
      })
    },

    async dispose() {
      for (const tunnel of tunnels) {
        try {
          tunnel.close()
        } catch {
          // already closed
        }
      }
      tunnels.clear()
      if (session !== null) dropSession(session)
      if (client !== null) client.end()
      client = null
      sftpSession = null
    },
  }
}
