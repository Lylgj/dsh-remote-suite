// SSH passwords live outside the normal state file: `state.json` is plain text,
// easy to copy around, and holds workspaces rather than credentials.
//
// Storage: `$DSH_HOME/remote-suite/secrets.json`, mode 0600. On Windows the mode
// is a no-op, so the file still inherits the profile directory's ACL — the same
// trust boundary as `~/.ssh/authorized_keys` on a development machine. Keeping
// the password out of tool arguments and state keeps accidental sharing down.

import { promises as fsp } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

export function secretsPath() {
  const override = process.env.DSH_REMOTE_SUITE_SECRETS
  if (typeof override === 'string' && override.trim() !== '') return override
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'remote-suite', 'secrets.json')
}

/** `user@host:port` — the same address block we might add to one day. */
export function secretKey(profile) {
  return `${profile.user ?? ''}@${profile.hostname ?? profile.alias}:${profile.port ?? 22}`
}

/**
 * Every key a profile may be stored under: the exact address first, then the
 * alias and bare hostname, then any entry for the same user@host on another
 * port (a host that moved from 22 to 2222 keeps its password).
 */
function candidateKeys(profile, secrets) {
  const keys = [secretKey(profile), profile.alias, profile.hostname].filter(
    (key) => typeof key === 'string' && key !== '',
  )
  const address = `${profile.user ?? ''}@${profile.hostname ?? profile.alias}`
  for (const key of Object.keys(secrets)) {
    if (key.startsWith(`${address}:`) || key.endsWith(`@${profile.hostname}`)) keys.push(key)
  }
  return [...new Set(keys)]
}

export async function loadSecrets() {
  try {
    const text = await fsp.readFile(secretsPath(), 'utf8')
    const parsed = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

export async function saveSecrets(secrets) {
  const path = secretsPath()
  await fsp.mkdir(dirname(path), { recursive: true })
  await fsp.writeFile(path, `${JSON.stringify(secrets, null, 2)}\n`, 'utf8')
  try {
    await fsp.chmod(path, 0o600)
  } catch {
    // Windows: the profile directory's ACL is the boundary.
  }
  return path
}

/** Password for a profile: exact `user@host:port`, then alias, then host. */
export async function lookupPassword(profile) {
  const secrets = await loadSecrets()
  for (const key of candidateKeys(profile, secrets)) {
    const value = secrets[key]
    if (typeof value === 'string' && value !== '') return value
  }
  return undefined
}

export async function setPassword(profile, password) {
  const secrets = await loadSecrets()
  secrets[secretKey(profile)] = password
  await saveSecrets(secrets)
}

export async function removePassword(profile) {
  const secrets = await loadSecrets()
  let removed = false
  for (const key of candidateKeys(profile, secrets)) {
    if (key in secrets) {
      delete secrets[key]
      removed = true
    }
  }
  if (removed) await saveSecrets(secrets)
  return removed
}
