// Filesystem helpers shared by the local backend and the WSL glob filter.
//
// Deliberately dependency-free: a glob → RegExp translation and a bounded walk.
// The patterns this plugin accepts are the ones a workspace user actually types
// (`**/*.ts`, `src/**/*.md`, `*.json`), not the full minimatch grammar.

import { promises as fsp } from 'node:fs'
import { join, relative, sep } from 'node:path'

const SKIP_DIRS = new Set([
  '.git', 'node_modules', '.next', 'dist', 'build', 'target',
  '.venv', '__pycache__', '.idea', '.vscode', '.cache', 'out', 'bin', 'obj',
])

/** `**` crosses directories, `*` and `?` do not. Returns an anchored RegExp over `/`-joined paths. */
export function globToRegExp(glob) {
  const source = String(glob).replace(/\\/g, '/').replace(/^\.\//, '')
  let out = ''
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]
    if (ch === '*') {
      if (source[i + 1] === '*') {
        i++
        if (source[i + 1] === '/') {
          i++
          out += '(?:[^/]+/)*'
        } else {
          out += '.*'
        }
      } else {
        out += '[^/]*'
      }
    } else if (ch === '?') {
      out += '[^/]'
    } else if ('\\^$.|+()[]{}'.includes(ch)) {
      out += `\\${ch}`
    } else {
      out += ch
    }
  }
  return new RegExp(`^${out}$`)
}

export function toPosix(p) {
  return p.split(sep).join('/')
}

/** True for paths a backend must not join onto a workspace base: absolute, UNC or `~`. */
export function isAbsoluteRemote(p) {
  return /^([a-zA-Z]:[\\/]|[\\/]{1,2}|~)/.test(p)
}

/**
 * Yield `{ abs, rel }` for every regular file under `root`, skipping the usual
 * noise directories and stopping after `maxFiles` entries. Errors on individual
 * entries are skipped, not thrown: a permission-denied subdirectory must not
 * abort a whole search.
 */
export async function* walkFiles(root, { maxFiles = 5000, maxDepth = 24 } = {}) {
  let count = 0
  const stack = [{ dir: root, depth: 0 }]
  while (stack.length > 0) {
    const { dir, depth } = stack.pop()
    if (depth > maxDepth) continue
    let entries
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        stack.push({ dir: abs, depth: depth + 1 })
      } else if (entry.isFile()) {
        if (count >= maxFiles) return
        count++
        yield { abs, rel: toPosix(relative(root, abs)) }
      }
    }
  }
}
