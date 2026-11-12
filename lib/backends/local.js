// Local backend: the host's own filesystem and shells.
//
// This exists so the seam itself is exercised: the tool can address "this
// computer" the same way it addresses a WSL distro, and later an SSH host.
// It is also the reference implementation for the other backends.

import { spawn } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import { homedir } from 'node:os'
import { join as joinPath } from 'node:path'
import { truncate, MAX_OUTPUT_BYTES } from './base.js'
import { globToRegExp, isAbsoluteRemote, walkFiles } from '../fs-util.js'
import { localShellArgv } from '../pty.js'

const MAX_GREP_FILE_BYTES = 1024 * 1024

function expandHome(p) {
  if (p === '~') return homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return p.replace(/^~/, homedir())
  return p
}

export function createLocalBackend({ id = 'local', label = '此电脑', spawnPty = null } = {}) {
  return {
    id,
    kind: 'local',
    label,

    home() {
      return homedir()
    },

    join(base, rel) {
      return isAbsoluteRemote(rel) ? rel : joinPath(base, rel)
    },

    async probe() {
      return {
        kind: 'local',
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        cwd: process.cwd(),
      }
    },

    /**
     * Open a local shell through the Host PTY provider.
     *
     * @param {{ cwd?: string, cols?: number, rows?: number, signal?: AbortSignal }} [options]
     * @returns the provider handle (`output`/`done`/`write`/`resize`/`terminate`)
     */
    async openTerminal({ cwd, cols, rows, signal } = {}) {
      if (typeof spawnPty !== 'function') {
        throw new Error('remote-suite: this host cannot open a local terminal (no PTY provider)')
      }
      return spawnPty({
        argv: localShellArgv(),
        cwd: cwd === undefined || cwd === '' ? homedir() : cwd,
        cols,
        rows,
        signal,
      })
    },

    async exec({ command, workdir, timeoutMs = 120_000, stdin }) {
      if (typeof command !== 'string' || command.trim() === '') {
        throw new Error('remote: exec needs a non-empty command')
      }
      const cwd = workdir === undefined ? undefined : expandHome(workdir)

      return new Promise((resolve, reject) => {
        let child
        try {
          child = spawn(command, {
            cwd,
            // Windows has no exec bit and no shebang convention: route through
            // the platform shell so `echo hi` behaves like it does in a terminal.
            shell: process.platform === 'win32' ? process.env.ComSpec || true : '/bin/sh',
            windowsHide: true,
            env: process.env,
          })
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

        child.stdout?.on('data', (chunk) => {
          if (stdout.length < MAX_OUTPUT_BYTES) {
            const capped = truncate(String(chunk), MAX_OUTPUT_BYTES)
            if (capped.truncated) truncated = true
            stdout += capped.text
          }
        })
        child.stderr?.on('data', (chunk) => {
          if (stderr.length < MAX_OUTPUT_BYTES) {
            const capped = truncate(String(chunk), MAX_OUTPUT_BYTES)
            if (capped.truncated) truncated = true
            stderr += capped.text
          }
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
    },

    async read({ path, maxBytes = 256 * 1024, offset, limit }) {
      const p = expandHome(path)
      const stat = await fsp.stat(p)
      if (!stat.isFile()) throw new Error(`remote: not a file: ${path}`)
      let buffer = await fsp.readFile(p)
      let suffix = ''
      if (buffer.byteLength > maxBytes) {
        buffer = buffer.subarray(0, maxBytes)
        suffix = `\n[truncated: file is ${stat.size} bytes]`
      }
      let text = buffer.toString('utf8')
      if (offset !== undefined || limit !== undefined) {
        const lines = text.split('\n')
        const start = Math.max(0, (offset ?? 1) - 1)
        const end = limit === undefined ? lines.length : start + limit
        text = lines.slice(start, end).join('\n')
      }
      return text + suffix
    },

    async write({ path, data }) {
      const p = expandHome(path)
      const bytes = Buffer.byteLength(data, 'utf8')
      await fsp.mkdir(p.replace(/[\\/][^\\/]+$/, ''), { recursive: true }).catch(() => {})
      await fsp.writeFile(p, data, 'utf8')
      return { bytes }
    },

    async stat({ path }) {
      const p = expandHome(path)
      const s = await fsp.stat(p)
      return {
        type: s.isDirectory() ? 'dir' : s.isFile() ? 'file' : 'other',
        size: s.size,
        mtimeMs: s.mtimeMs,
        mode: s.mode,
      }
    },

    async list({ path, limit = 500 }) {
      const p = expandHome(path)
      const entries = await fsp.readdir(p, { withFileTypes: true })
      const out = []
      for (const entry of entries.slice(0, limit)) {
        let size = 0
        try {
          size = (await fsp.stat(joinPath(p, entry.name))).size
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
      const root = expandHome(path)
      const re = new RegExp(pattern, ignoreCase ? 'i' : '')
      const matcher = glob === undefined ? null : globToRegExp(glob)
      const hits = []
      for await (const file of walkFiles(root, { maxFiles: 20_000 })) {
        if (hits.length >= maxResults) break
        if (matcher !== null && !matcher.test(file.rel)) continue
        let buffer
        try {
          const stat = await fsp.stat(file.abs)
          if (stat.size > MAX_GREP_FILE_BYTES) continue
          buffer = await fsp.readFile(file.abs)
        } catch {
          continue
        }
        if (buffer.includes(0)) continue
        const lines = buffer.toString('utf8').split(/\r?\n/)
        for (let i = 0; i < lines.length && hits.length < maxResults; i++) {
          if (re.test(lines[i])) {
            hits.push({ file: file.rel, line: i + 1, text: lines[i].slice(0, 400) })
          }
        }
      }
      return { hits, truncated: hits.length >= maxResults }
    },

    async glob({ pattern, root = '.', maxResults = 500 }) {
      const base = expandHome(root)
      const matcher = globToRegExp(pattern)
      const files = []
      for await (const file of walkFiles(base, { maxFiles: 50_000 })) {
        if (matcher.test(file.rel)) {
          files.push(file.rel)
          if (files.length >= maxResults) break
        }
      }
      return { files, truncated: files.length >= maxResults }
    },

    async dispose() {},
  }
}
