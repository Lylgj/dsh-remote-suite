// Minimal `~/.ssh/config` reader.
//
// Only what a workspace target needs: alias → hostname/port/user/identity files.
// `Match` stanzas are skipped entirely (they need the full OpenSSH condition
// grammar, and silently applying them would be worse than ignoring them).
// Wildcard aliases (`Host *`, `Host 192.168.*`) are skipped too: they are
// defaults or patterns, not connectable targets.

import { homedir } from 'node:os'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const KEY_ALIASES = {
  hostname: 'hostname',
  user: 'user',
  port: 'port',
  identityfile: 'identityFiles',
  proxyjump: 'proxyJump',
}

function stripComment(line) {
  // `#` starts a comment when it begins the line or follows whitespace.
  const match = /\s#|^#/.exec(line)
  return match === null ? line : line.slice(0, match.index)
}

function expandHome(path) {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

function parseValue(raw) {
  const trimmed = raw.trim()
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

/**
 * Parse OpenSSH config text into connectable profiles.
 * @param {string} text
 * @returns {Array<{ alias: string, hostname: string, user?: string, port?: number, identityFiles: string[], proxyJump?: string }>}
 */
export function parseSshConfig(text) {
  const profiles = []
  let current = null
  let skipping = false

  const flush = () => {
    if (current !== null) {
      for (const alias of current.aliases) {
        if (!alias.includes('*') && !alias.includes('?')) {
          profiles.push({
            alias,
            hostname: current.hostname ?? alias,
            user: current.user,
            port: current.port,
            identityFiles: current.identityFiles,
            proxyJump: current.proxyJump,
          })
        }
      }
    }
    current = null
  }

  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripComment(rawLine).trim()
    if (line === '') continue

    const space = line.search(/\s/)
    const keyword = (space === -1 ? line : line.slice(0, space)).toLowerCase()
    const rest = space === -1 ? '' : line.slice(space + 1)

    if (keyword === 'host') {
      flush()
      skipping = false
      const aliases = rest.split(/\s+/).filter((a) => a !== '')
      current = { aliases, hostname: undefined, user: undefined, port: undefined, identityFiles: [], proxyJump: undefined }
      continue
    }
    if (keyword === 'match') {
      flush()
      skipping = true
      continue
    }
    if (skipping || current === null) continue

    const field = KEY_ALIASES[keyword]
    if (field === undefined) continue

    const value = parseValue(rest)
    if (value === '') continue

    if (field === 'identityFiles') {
      current.identityFiles.push(expandHome(value))
    } else if (field === 'port') {
      const port = Number(value)
      if (Number.isInteger(port) && port > 0) current.port = port
    } else if (field === 'proxyJump') {
      current.proxyJump = value === 'none' ? undefined : value
    } else {
      current[field] = value
    }
  }
  flush()

  return profiles.sort((a, b) => a.alias.localeCompare(b.alias))
}

/** Read and parse the user's SSH config; missing file means "no profiles". */
export async function readSshConfig(path) {
  const target =
    path ??
    (typeof process.env.DSH_SSH_CONFIG === 'string' && process.env.DSH_SSH_CONFIG.trim() !== ''
      ? process.env.DSH_SSH_CONFIG
      : join(homedir(), '.ssh', 'config'))
  let text
  try {
    text = await readFile(target, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  return parseSshConfig(text)
}
