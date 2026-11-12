// Docker backend: a container addressed through the `docker` CLI.
//
// The container is the unit of addressability, exactly like a WSL distribution
// or an SSH host: `docker:<name>`. Everything inside runs through
// `docker exec -i <name> sh -lc <script>`, so the image only needs a POSIX shell
// (busybox is enough); file reads/writes, search and the terminal all reuse that
// one transport. Nothing here runs the Docker API directly — the CLI is the
// contract, which keeps the plugin working with Docker Desktop, a remote daemon
// via `DOCKER_HOST`, and rootless docker alike.
//
// The shell is assumed to be Linux: Windows containers do not have `sh`, and
// this backend reports that clearly instead of guessing.

import { spawn } from 'node:child_process'
import { truncate, MAX_OUTPUT_BYTES } from './base.js'
import { explain, isTransient } from '../errors.js'
import { globToRegExp, isAbsoluteRemote } from '../fs-util.js'

const DOCKER_TTL_MS = 10_000
const LIST_TIMEOUT_MS = 5_000
const MAX_GREP_FILE_BYTES = 1024 * 1024

/** Quote one shell word for a POSIX shell. */
function sq(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

function dockerCommand() {
  return process.env.DSH_DOCKER || 'docker'
}

function posixJoin(base, rel) {
  if (isAbsoluteRemote(rel)) return rel
  if (base === '' || base === undefined) return rel
  const left = base.replace(/\/+$/, '')
  const right = rel.replace(/^\/+/, '')
  if (left === '') return `/${right}`
  return right === '' ? left : `${left}/${right}`
}

/** Run a process and collect its output. */
function runProcess(command, args, { stdin, timeoutMs = 120_000, cwd } = {}) {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(command, args, { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (error) {
      reject(error)
      return
    }
    let stdout = ''
    let stderr = ''
    let truncated = false
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    const append = (current, chunk) => {
      if (current.length >= MAX_OUTPUT_BYTES) return current
      const capped = truncate(String(chunk), MAX_OUTPUT_BYTES)
      if (capped.truncated) truncated = true
      return current + capped.text
    }
    child.stdout?.on('data', (chunk) => {
      stdout = append(stdout, chunk)
    })
    child.stderr?.on('data', (chunk) => {
      stderr = append(stderr, chunk)
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ stdout, stderr, exitCode: code ?? -1, timedOut, truncated })
    })
    if (stdin !== undefined) child.stdin?.end(stdin)
    else child.stdin?.end()
  })
}

/**
 * One `docker exec` invocation inside a container.
 *
 * A registry hiccup or a TLS handshake timeout is worth one retry; a command
 * that genuinely failed is not retried (it may have had side effects).
 *
 * @returns {{ stdout, stderr, exitCode, timedOut, truncated }}
 */
async function execViaCli(container, script, options = {}) {
  const command = dockerCommand()
  const args = ['exec', '-i', container, 'sh', '-lc', script]
  let result
  try {
    result = await runProcess(command, args, options)
  } catch (error) {
    if (!isTransient(error)) throw error
    return runProcess(command, args, options)
  }
  if (result.exitCode !== 0 && !result.timedOut && isTransient(result.stderr)) {
    return runProcess(command, args, options)
  }
  return result
}

function assertOk(result, what) {
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`
    throw new Error(explain(`remote-suite: ${what} failed in the container: ${detail}`))
  }
  return result
}

/** Trim a trailing newline from a one-line probe. */
function firstLine(text) {
  const index = text.indexOf('\n')
  return (index === -1 ? text : text.slice(0, index)).trim()
}

/**
 * @param {object} options
 * @param {string} options.id           target id, e.g. `docker:web`
 * @param {string} options.container    container name or id
 * @param {string} [options.label]
 * @param {Function|null} [options.spawnPty]
 * @param {Function} [options.exec]     test seam: run one script inside the
 *   container without the docker CLI; production uses `docker exec -i`.
 */
export function createDockerBackend({ id, container, label, spawnPty = null, exec = null }) {
  const run = exec === null ? (script, options) => execViaCli(container, script, options) : exec

  /** Every script the backend runs goes through here (that is the test seam). */
  const containerExec = (script, options = {}) => run(script, options)

  let homeCache = null

  const backend = {
    id,
    kind: 'docker',
    label: label || `Docker 路 ${container}`,

    async home() {
      if (homeCache !== null) return homeCache
      try {
        const result = await containerExec('printf %s "$HOME"', { timeoutMs: 20_000 })
        homeCache = assertOk(result, 'home').stdout.trim() || '/root'
      } catch {
        homeCache = '/root'
      }
      return homeCache
    },

    join(base, rel) {
      return posixJoin(base, rel)
    },

    async probe() {
      const result = await containerExec('uname -sr 2>/dev/null; printf "home=%s\\n" "$HOME"; printf "cwd=%s\\n" "$(pwd)"',
        { timeoutMs: 20_000 },
      )
      assertOk(result, 'probe')
      const lines = result.stdout.split(/\r?\n/).filter((line) => line !== '')
      return {
        kind: 'docker',
        container,
        os: lines[0] || 'unknown',
        home: (lines.find((line) => line.startsWith('home=')) || 'home=').slice(5),
        cwd: (lines.find((line) => line.startsWith('cwd=')) || 'cwd=').slice(4),
      }
    },

    async openTerminal({ cols, rows, signal } = {}) {
      if (typeof spawnPty !== 'function') {
        throw new Error('remote-suite: this host cannot open a terminal (no PTY provider)')
      }
      return spawnPty({
        argv: [dockerCommand(), 'exec', '-it', container, 'sh'],
        cols,
        rows,
        signal,
      })
    },

    async exec({ command, workdir, timeoutMs = 120_000, stdin }) {
      if (typeof command !== 'string' || command.trim() === '') {
        throw new Error('remote: exec needs a non-empty command')
      }
      const script =
        workdir === undefined || workdir === ''
          ? command
          : `cd ${sq(workdir)} 2>/dev/null || exit 66; ${command}`
      const result = await containerExec(script, { stdin, timeoutMs })
      if (result.exitCode === 66) {
        throw new Error(`remote-suite: no such directory in the container: ${workdir}`)
      }
      return result
    },

    async read({ path, maxBytes = 256 * 1024, offset, limit }) {
      if (offset !== undefined || limit !== undefined) {
        const start = Math.max(1, offset ?? 1)
        const end = limit === undefined ? '$' : String(start + limit - 1)
        const script = `sed -n '${start},${end}p' -- ${sq(path)}`
        const result = await containerExec(script, { timeoutMs: 60_000 })
        const text = assertOk(result, `read ${path}`).stdout
        // `sed` always terminates the line it prints; the local backend joins
        // lines without a trailing newline, so match that shape here.
        return text.endsWith('\n') ? text.slice(0, -1) : text
      }
      const script = `if head -c 1 -- ${sq(path)} >/dev/null 2>&1; then wc -c < ${sq(path)}; else printf 'no-file\\n'; fi`
      const stat = assertOk(await containerExec(script, { timeoutMs: 30_000 }), `read ${path}`).stdout.trim()
      if (stat === 'no-file') throw new Error(`remote: not a file: ${path}`)
      const size = Number.parseInt(stat, 10)
      if (!Number.isFinite(size)) throw new Error(`remote: not a file: ${path}`)
      const take = Number.isFinite(maxBytes) ? maxBytes : 256 * 1024
      const data = assertOk(
        await containerExec(`head -c ${take} -- ${sq(path)}`, { timeoutMs: 60_000 }),
        `read ${path}`,
      )
      const buffer = Buffer.from(data.stdout, 'utf8')
      const suffix = size > take ? `\n[truncated: file is ${size} bytes]` : ''
      return buffer.toString('utf8') + suffix
    },

    async write({ path, data }) {
      const script = `mkdir -p -- "$(dirname -- ${sq(path)})" && cat > ${sq(path)}`
      assertOk(await containerExec(script, { stdin: data, timeoutMs: 60_000 }), `write ${path}`)
      return { bytes: Buffer.byteLength(data, 'utf8') }
    },

    async stat({ path }) {
      const script = [
        `if [ -d ${sq(path)} ]; then printf 'dir\\n'; elif [ -f ${sq(path)} ]; then printf 'file\\n'; else printf 'other\\n'; fi`,
        `if [ -f ${sq(path)} ]; then wc -c < ${sq(path)}; else printf '0\\n'; fi`,
        `stat -c %Y ${sq(path)} 2>/dev/null || printf '0\\n'`,
      ].join('\n')
      const result = assertOk(await containerExec(script, { timeoutMs: 30_000 }), `stat ${path}`)
      const [type, size, mtime] = result.stdout.split(/\r?\n/)
      return {
        type: type === 'dir' ? 'dir' : type === 'file' ? 'file' : 'other',
        size: Number.parseInt(size || '0', 10) || 0,
        mtimeMs: (Number.parseInt(mtime || '0', 10) || 0) * 1000,
      }
    },

    async list({ path, limit = 500 }) {
      const script = [
        `cd ${sq(path)} 2>/dev/null || exit 66`,
        `for f in .[!.]* *; do`,
        `  [ -e "$f" ] || continue`,
        `  if [ -d "$f" ]; then printf 'd %s\\n' "$f"; elif [ -f "$f" ]; then printf 'f %s\\n' "$f"; else printf 'o %s\\n' "$f"; fi`,
        `done`,
      ].join('\n')
      const result = await containerExec(script, { timeoutMs: 60_000 })
      if (result.exitCode === 66) throw new Error(`remote: not a directory: ${path}`)
      assertOk(result, `list ${path}`)
      const entries = []
      for (const line of result.stdout.split(/\r?\n/)) {
        if (line.length < 3) continue
        const kind = line[0]
        const name = line.slice(2)
        entries.push({ name, type: kind === 'd' ? 'dir' : kind === 'f' ? 'file' : 'other', size: 0 })
      }
      entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1))
      return { entries: entries.slice(0, limit), truncated: entries.length > limit }
    },

    async grep({ pattern, path, glob, maxResults = 100, ignoreCase = false }) {
      if (typeof pattern !== 'string' || pattern === '') throw new Error('remote: grep needs a pattern')
      const flags = ignoreCase ? '-i' : ''
      const rgGlob = glob === undefined ? '' : ` --glob ${sq(glob)}`
      const script = [
        `cd ${sq(path)} 2>/dev/null || exit 66`,
        `if command -v rg >/dev/null 2>&1; then`,
        `  rg --no-heading -n --color never ${flags}${rgGlob} --max-count ${maxResults} -e ${sq(pattern)} .`,
        `else`,
        `  grep -rnIE ${ignoreCase ? '-i' : ''} -e ${sq(pattern)} . | head -n ${maxResults}`,
        `fi`,
      ].join('\n')
      const result = await containerExec(script, { timeoutMs: 120_000 })
      if (result.exitCode === 66) throw new Error(`remote: not a directory: ${path}`)
      // rg exits 1 when nothing matched; grep does too. Only a real failure is fatal.
      if (result.exitCode !== 0 && result.exitCode !== 1) assertOk(result, `grep ${path}`)
      const matcher = glob === undefined ? null : globToRegExp(glob)
      const hits = []
      for (const line of result.stdout.split(/\r?\n/)) {
        if (line === '') continue
        const first = line.indexOf(':')
        if (first === -1) continue
        const second = line.indexOf(':', first + 1)
        if (second === -1) continue
        const file = line.slice(0, first).replace(/^\.\//, '')
        if (matcher !== null && !matcher.test(file)) continue
        hits.push({ file, line: Number.parseInt(line.slice(first + 1, second), 10) || 0, text: line.slice(second + 1) })
        if (hits.length >= maxResults) break
      }
      return { hits, truncated: hits.length >= maxResults }
    },

    async glob({ pattern, root = '.', maxResults = 500 }) {
      const script = `cd ${sq(root)} 2>/dev/null || exit 66; find . -type f 2>/dev/null | head -n 20000`
      const result = await containerExec(script, { timeoutMs: 120_000 })
      if (result.exitCode === 66) throw new Error(`remote: not a directory: ${root}`)
      assertOk(result, `glob ${root}`)
      const matcher = globToRegExp(pattern)
      const files = []
      for (const raw of result.stdout.split(/\r?\n/)) {
        if (raw === '') continue
        const rel = raw.replace(/^\.\//, '')
        if (matcher.test(rel)) {
          files.push(rel)
          if (files.length >= maxResults) break
        }
      }
      return { files, truncated: files.length >= maxResults }
    },

    async dispose() {},
  }

  return backend
}

/**
 * Containers currently running, as `{ name, id, image }`.
 *
 * A host without Docker simply gets an empty list: the plugin must keep working
 * next to a machine that never installed it.
 */
export async function listContainers() {
  try {
    const result = await runProcess(
      dockerCommand(),
      ['ps', '--format', '{{.Names}}\t{{.ID}}\t{{.Image}}'],
      { timeoutMs: LIST_TIMEOUT_MS },
    )
    if (result.exitCode !== 0) return []
    const containers = []
    for (const line of result.stdout.split(/\r?\n/)) {
      if (line.trim() === '') continue
      const [name, containerId, image] = line.split('\t')
      if (name === undefined || name === '') continue
      containers.push({ name, id: containerId || '', image: image || '' })
    }
    return containers
  } catch {
    return []
  }
}

export { DOCKER_TTL_MS }
