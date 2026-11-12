// WSL backend: a Linux distribution reached through wsl.exe.
//
// Two transports, deliberately:
//   - commands run from a script written to the distribution's /tmp over the
//     9p share (`bash /tmp/x.sh`): wsl.exe re-evaluates everything after `--` as
//     one command line, so a script passed as an argv element loses its `$vars`;
//   - file operations go through the 9p share (\\wsl.localhost\<distro>\...),
//     EXCEPT writes, which a 9p share cannot do atomically — those are streamed
//     to `cat` inside the distribution instead.
//
// `WSL_UTF8=1` makes wsl.exe emit UTF-8; without it every pipe is UTF-16LE and
// the output looks like `s\u0000t\u0000d\u0000...`.
//
// grep and glob run INSIDE the distribution: a 9p walk of a node_modules-sized
// tree costs seconds, an in-distro `rg`/`find` costs milliseconds.

import { spawn } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import { truncate, MAX_OUTPUT_BYTES } from './base.js'
import { explain, isTransient } from '../errors.js'
import { wslShellArgv } from '../pty.js'
import { globToRegExp, isAbsoluteRemote, toPosix } from '../fs-util.js'

const EXE = process.env.DSH_WSL_EXE || 'wsl.exe'
const UNC_ROOT = '\\\\wsl.localhost\\'
const MAX_GREP_RESULTS = 200

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

function decode(buffer) {
  if (buffer.length === 0) return ''
  // UTF-16LE has a NUL in every other byte; WSL_UTF8=1 should prevent it, but a
  // Host or a shell profile can still hand us the old encoding.
  const nul = buffer.indexOf(0)
  if (nul !== -1 && nul < 20) return buffer.toString('utf16le').replace(/\u0000/g, '')
  return buffer.toString('utf8')
}

/** Run a command inside the distribution; resolves always, rejects only on spawn errors. */
function runWslOnce(distro, argv, { cwd, stdin, timeoutMs = 120_000, env } = {}) {
  const args = []
  if (distro) args.push('-d', distro)
  if (cwd) args.push('--cd', cwd)
  args.push('--', ...argv)

  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(EXE, args, {
        windowsHide: true,
        env: { ...process.env, WSL_UTF8: '1', ...(env || {}) },
      })
    } catch (error) {
      reject(error)
      return
    }

    const stdout = []
    const stderr = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let truncated = false
    let timedOut = false

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)

    child.stdout?.on('data', (chunk) => {
      if (stdoutBytes >= MAX_OUTPUT_BYTES) return
      stdoutBytes += chunk.length
      stdout.push(chunk)
      if (stdoutBytes > MAX_OUTPUT_BYTES) truncated = true
    })
    child.stderr?.on('data', (chunk) => {
      if (stderrBytes >= MAX_OUTPUT_BYTES) return
      stderrBytes += chunk.length
      stderr.push(chunk)
      if (stderrBytes > MAX_OUTPUT_BYTES) truncated = true
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({
        stdout: truncate(decode(Buffer.concat(stdout)), MAX_OUTPUT_BYTES).text,
        stderr: truncate(decode(Buffer.concat(stderr)), MAX_OUTPUT_BYTES).text,
        exitCode: code ?? -1,
        timedOut,
        truncated,
      })
    })

    if (stdin !== undefined) child.stdin?.end(stdin)
    else child.stdin?.end()
  })
}

/**
 * Run inside the distribution with one transparent retry for the failures WSL
 * itself recovers from (a stopped instance cold-starting again, a socket reset).
 * A timed-out or genuinely failed command is returned as-is.
 */
export async function runWsl(distro, argv, options = {}) {
  let result
  try {
    result = await runWslOnce(distro, argv, options)
  } catch (error) {
    if (!isTransient(error)) throw error
    result = await runWslOnce(distro, argv, options)
    return result
  }
  if (result.exitCode !== 0 && !result.timedOut && isTransient(result.stderr)) {
    await new Promise((resolve) => setTimeout(resolve, 300))
    result = await runWslOnce(distro, argv, options)
  }
  return result
}

/** Every installed distribution, or [] when this machine has no WSL at all. */
export async function listDistros() {
  const out = await new Promise((resolve) => {
    let child
    try {
      child = spawn(EXE, ['-l', '-q'], { windowsHide: true, env: { ...process.env, WSL_UTF8: '1' } })
    } catch {
      resolve('')
      return
    }
    const chunks = []
    child.stdout?.on('data', (c) => chunks.push(c))
    child.on('error', () => resolve(''))
    child.on('close', () => resolve(decode(Buffer.concat(chunks))))
  })
  return out
    .split(/\r?\n/)
    .map((line) => line.replace(/\u0000/g, '').trim())
    .filter((line) => line !== '')
}

function uncPath(distro, linuxPath) {
  const rest = linuxPath.replace(/^\/+/, '').replace(/\//g, '\\')
  return `${UNC_ROOT}${distro}\\${rest}`
}

let scriptCounter = 0

/**
 * Run a script inside the distribution.
 *
 * The script never travels as an argv element: `wsl.exe` treats everything after
 * `--` as one command line and re-evaluates it, so a `$name` inside the script
 * would be expanded (to empty) before bash ever saw it. Instead the script is
 * streamed to a private file in the distribution's /tmp and executed by path;
 * stdin stays free for the caller's data.
 *
 * The file is created by the distribution itself (`cat > …` from stdin) rather
 * than over the 9p share: a 9p write can still be missing when the very next
 * `wsl.exe` starts, and Ubuntu-22.04 hit exactly that race.
 */
export async function runWslScript(distro, script, options = {}) {
  if (!distro) throw new Error('remote-suite: the WSL backend needs a distribution name')
  const name = `/tmp/dsh-remote-suite-${process.pid}-${++scriptCounter}-${Date.now().toString(36)}.sh`
  const staged = await runWsl(distro, ['bash', '-c', `cat > ${shellQuote(name)}`], {
    stdin: script,
    timeoutMs: 20_000,
  })
  if (staged.exitCode !== 0) {
    throw new Error(
      explain(
        `remote-suite: staging a script in ${distro} failed: ${staged.stderr.trim() || `exit code ${staged.exitCode}`}`,
      ),
    )
  }
  try {
    return await runWsl(distro, ['bash', name], options)
  } finally {
    runWsl(distro, ['bash', '-c', `rm -f ${shellQuote(name)}`], { timeoutMs: 20_000 }).catch(() => {})
  }
}

/** POSIX join that leaves absolute paths and `~` alone. */
function posixJoin(base, rel) {
  if (isAbsoluteRemote(rel)) return rel
  return `${base.replace(/\/+$/, '')}/${rel}`
}

export function createWslBackend({ distro, id = `wsl:${distro}`, label, spawnPty = null }) {
  const backend = {
    id,
    kind: 'wsl',
    distro,
    label: label || `WSL · ${distro}`,

    _home: undefined,
    _hasRg: undefined,

    join(base, rel) {
      return posixJoin(base, rel)
    },

    async home() {
      if (backend._home === undefined) {
        const result = await runWslScript(distro, 'echo "$HOME"', { timeoutMs: 20_000 })
        backend._home = result.stdout.trim() || '/root'
      }
      return backend._home
    },

    async resolvePath(path) {
      if (path === '~' || path.startsWith('~/')) {
        return (await backend.home()) + path.slice(1)
      }
      return path
    },

    async hasRg() {
      if (backend._hasRg === undefined) {
        const result = await runWslScript(
          distro,
          'command -v rg >/dev/null 2>&1 && echo yes || echo no',
          { timeoutMs: 20_000 },
        )
        backend._hasRg = result.stdout.trim() === 'yes'
      }
      return backend._hasRg
    },

    async probe() {
      const result = await runWslScript(
        distro,
        'uname -sr; id -un; echo "$HOME"',
        { timeoutMs: 30_000 },
      )
      const [uname = '', user = '', home = ''] = result.stdout.trim().split(/\r?\n/)
      return { kind: 'wsl', distro, uname, user, home, exitCode: result.exitCode }
    },

    async exec({ command, workdir, timeoutMs = 120_000, stdin }) {
      if (typeof command !== 'string' || command.trim() === '') {
        throw new Error('remote: exec needs a non-empty command')
      }
      const cwd = workdir === undefined ? undefined : await backend.resolvePath(workdir)
      return runWslScript(distro, command, { cwd, stdin, timeoutMs })
    },

    /**
     * Open an interactive shell inside the distribution.
     *
     * `--cd` is applied by the launcher before the shell starts, so the prompt
     * opens in the requested directory instead of a `cd` printed afterwards.
     * `WSL_UTF8` keeps the launcher from answering in UTF-16LE.
     *
     * @param {{ cwd?: string, cols?: number, rows?: number, signal?: AbortSignal }} [options]
     * @returns the provider handle
     */
    async openTerminal({ cwd, cols, rows, signal } = {}) {
      if (typeof spawnPty !== 'function') {
        throw new Error(`remote-suite: this host cannot open a terminal in ${distro} (no PTY provider)`)
      }
      const target = cwd === undefined || cwd === '' ? undefined : await backend.resolvePath(cwd)
      return spawnPty({
        argv: wslShellArgv({ distro, cwd: target }),
        cwd: process.cwd(),
        cols,
        rows,
        env: { WSL_UTF8: '1' },
        signal,
      })
    },

    async read({ path, maxBytes = 256 * 1024, offset, limit }) {
      const linux = await backend.resolvePath(path)
      const buffer = await fsp.readFile(uncPath(distro, linux))
      let suffix = ''
      let view = buffer
      if (buffer.byteLength > maxBytes) {
        view = buffer.subarray(0, maxBytes)
        suffix = `\n[truncated: file is ${buffer.byteLength} bytes]`
      }
      let text = view.toString('utf8')
      if (offset !== undefined || limit !== undefined) {
        const lines = text.split('\n')
        const start = Math.max(0, (offset ?? 1) - 1)
        const end = limit === undefined ? lines.length : start + limit
        text = lines.slice(start, end).join('\n')
      }
      return text + suffix
    },

    async write({ path, data }) {
      const linux = await backend.resolvePath(path)
      const bytes = Buffer.byteLength(data, 'utf8')
      // 9p cannot rename atomically, so the write happens inside the distro.
      const result = await runWslScript(
        distro,
        `mkdir -p -- ${shellQuote(linux.replace(/\/[^/]*$/, '') || '/')} && cat > ${shellQuote(linux)}`,
        { stdin: data, timeoutMs: 60_000 },
      )
      if (result.exitCode !== 0) {
        throw new Error(`remote: writing ${linux} failed: ${result.stderr.trim() || `exit code ${result.exitCode}`}`)
      }
      return { bytes }
    },

    async stat({ path }) {
      const linux = await backend.resolvePath(path)
      const s = await fsp.stat(uncPath(distro, linux))
      return {
        type: s.isDirectory() ? 'dir' : s.isFile() ? 'file' : 'other',
        size: s.size,
        mtimeMs: s.mtimeMs,
        mode: s.mode,
      }
    },

    async list({ path, limit = 500 }) {
      const linux = await backend.resolvePath(path)
      const entries = await fsp.readdir(uncPath(distro, linux), { withFileTypes: true })
      const out = []
      for (const entry of entries.slice(0, limit)) {
        let size = 0
        try {
          size = (await fsp.stat(uncPath(distro, `${linux.replace(/\/$/, '')}/${entry.name}`))).size
        } catch {
          size = 0
        }
        out.push({
          name: entry.name,
          type: entry.isDirectory() ? 'dir' : entry.isFile() ? 'file' : 'other',
          size,
        })
      }
      return { entries: out, truncated: entries.length > limit }
    },

    async grep({ pattern, path, glob, maxResults = 100, ignoreCase = false }) {
      const root = await backend.resolvePath(path)
      const limit = Math.min(maxResults, MAX_GREP_RESULTS)
      const flags = ignoreCase ? '-i' : ''
      const rgGlob = glob === undefined ? '' : `-g ${shellQuote(glob)}`
      const command = (await backend.hasRg())
        ? `cd ${shellQuote(root)} && rg --no-heading --line-number --color never ${flags} ${rgGlob} -e ${shellQuote(pattern)} . | head -n ${limit}`
        : `cd ${shellQuote(root)} && grep -rnIE ${flags} --exclude-dir=.git --exclude-dir=node_modules -e ${shellQuote(pattern)} . | head -n ${limit}`

      const result = await runWslScript(distro, command, { timeoutMs: 120_000 })
      const hits = parseGrepOutput(result.stdout, limit)
      return { hits, truncated: hits.length >= limit }
    },

    async glob({ pattern, root = '.', maxResults = 500 }) {
      const base = await backend.resolvePath(root)
      const matcher = globToRegExp(pattern)
      const command = `cd ${shellQuote(base)} && find . -type f -not -path '*/.git/*' -not -path '*/node_modules/*' | head -n 20000`
      const result = await runWslScript(distro, command, { timeoutMs: 120_000 })
      const files = []
      for (const line of result.stdout.split(/\r?\n/)) {
        if (line === '') continue
        const rel = toPosix(line.replace(/^\.\//, ''))
        if (matcher.test(rel)) {
          files.push(rel)
          if (files.length >= maxResults) break
        }
      }
      return { files, truncated: files.length >= maxResults }
    },

    async dispose() {
      backend._home = undefined
      backend._hasRg = undefined
    },
  }

  return backend
}

/** `path:line:text` — split on the first two colons only, a text may contain more. */
function parseGrepOutput(stdout, limit) {
  const hits = []
  for (const raw of stdout.split(/\r?\n/)) {
    if (raw === '' || hits.length >= limit) continue
    const first = raw.indexOf(':')
    if (first <= 0) continue
    const second = raw.indexOf(':', first + 1)
    if (second <= first) continue
    const line = Number(raw.slice(first + 1, second))
    if (!Number.isInteger(line)) continue
    hits.push({
      file: raw.slice(0, first).replace(/^\.\//, ''),
      line,
      text: raw.slice(second + 1).slice(0, 400),
    })
  }
  return hits
}
