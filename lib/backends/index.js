// Target registry: turns a target id into a live Backend.
//
// M0 knows two kinds, local and WSL. M2 adds SSH profiles discovered from
// ~/.ssh/config; Docker (M4) lands behind the same `backend(id)` call, so the
// tool layer never changes.
//
// Target ids are stable strings because they travel through tool arguments and
// the workspace state file:
//   local           the host itself
//   wsl:<distro>    a distribution
//   ssh:<alias>     a Host alias from ~/.ssh/config
//   docker:<name>   a running container
//
// `backend()` may return a promise (SSH profile lookup touches the filesystem);
// callers await it, which is a no-op for the synchronous kinds.

import { createDockerBackend, listContainers, DOCKER_TTL_MS } from './docker.js'
import { createLocalBackend } from './local.js'
import { createSshBackend } from './ssh.js'
import { createWslBackend, listDistros } from './wsl.js'
import { readSshConfig } from '../ssh-config.js'

const SSH_PROFILES_TTL_MS = 10_000

export function createRegistry({ config = {}, spawnPty = null, savedProfiles = null } = {}) {
  /** id -> Backend | Promise<Backend> */
  const live = new Map()
  let disposed = false

  let sshCache = { at: 0, profiles: [] }
  let dockerCache = { at: 0, containers: [] }

  /**
   * `~/.ssh/config` entries first, then hosts the user added through the panel
   * (they live in the plugin state file, so a target works without editing the
   * config). An alias that exists in both keeps the config entry — that file is
   * the user's own source of truth.
   */
  async function loadSshProfiles() {
    const now = Date.now()
    if (now - sshCache.at < SSH_PROFILES_TTL_MS) return sshCache.profiles
    let profiles = []
    try {
      profiles = await readSshConfig()
    } catch {
      profiles = []
    }
    if (typeof savedProfiles === 'function') {
      try {
        const saved = await savedProfiles()
        const known = new Set(profiles.map((profile) => profile.alias))
        for (const profile of saved) {
          if (!known.has(profile.alias)) profiles.push(profile)
        }
      } catch {
        // a broken state file must not take the config entries down with it
      }
    }
    sshCache = { at: now, profiles }
    return profiles
  }

  async function loadContainers() {
    const now = Date.now()
    if (now - dockerCache.at < DOCKER_TTL_MS) return dockerCache.containers
    try {
      dockerCache = { at: now, containers: await listContainers() }
    } catch {
      dockerCache = { at: now, containers: [] }
    }
    return dockerCache.containers
  }

  function create(id) {
    if (id === 'local') return createLocalBackend({ label: config.localLabel || '此电脑', spawnPty })

    if (id.startsWith('wsl:')) {
      const distro = id.slice(4)
      if (distro === '') throw new Error('remote: malformed WSL target id')
      return createWslBackend({ distro, spawnPty })
    }

    if (id.startsWith('ssh:')) {
      const alias = id.slice(4)
      if (alias === '') throw new Error('remote: malformed SSH target id')
      return loadSshProfiles().then((profiles) => {
        const profile = profiles.find((candidate) => candidate.alias === alias)
        if (profile === undefined) {
          throw new Error(`remote: unknown SSH profile ${JSON.stringify(alias)} — check ~/.ssh/config`)
        }
        return createSshBackend({ id, profile, profiles })
      })
    }

    if (id.startsWith('daemon:')) {
      const alias = id.slice(7)
      if (alias === '') throw new Error('remote: malformed daemon target id')
      return loadSshProfiles().then((profiles) => {
        const profile = profiles.find((candidate) => candidate.alias === alias)
        if (profile === undefined) {
          throw new Error(`remote: unknown SSH profile ${JSON.stringify(alias)} — check ~/.ssh/config`)
        }
        return createSshBackend({ id, profile, profiles, persistent: true })
      })
    }

    if (id.startsWith('docker:')) {
      const container = id.slice(7)
      if (container === '') throw new Error('remote: malformed Docker target id')
      return createDockerBackend({ id, container, spawnPty })
    }

    throw new Error(`remote: unknown target ${JSON.stringify(id)}`)
  }

  return {
    async listTargets() {
      const targets = [
        { id: 'local', kind: 'local', label: config.localLabel || '此电脑' },
      ]
      if (process.platform === 'win32') {
        for (const distro of await listDistros()) {
          targets.push({ id: `wsl:${distro}`, kind: 'wsl', label: `WSL · ${distro}`, distro })
        }
      }
      for (const profile of await loadSshProfiles()) {
        targets.push({ id: `ssh:${profile.alias}`, kind: 'ssh', label: `SSH · ${profile.alias}`, host: profile.hostname })
        targets.push({
          id: `daemon:${profile.alias}`,
          kind: 'daemon',
          label: `SSH · ${profile.alias} (session)`,
          host: profile.hostname,
        })
      }
      for (const container of await loadContainers()) {
        targets.push({
          id: `docker:${container.name}`,
          kind: 'docker',
          label: `Docker · ${container.name}`,
          image: container.image,
        })
      }
      return targets
    },

    backend(id) {
      if (disposed) throw new Error('remote: the plugin has been disposed')
      const existing = live.get(id)
      if (existing !== undefined) return existing
      const created = create(id)
      live.set(id, created)
      return created
    },

    /** Drop the cached SSH profile list (after the panel adds or removes one). */
    refreshProfiles() {
      sshCache = { at: 0, profiles: [] }
    },

    /** The `~/.ssh/config` entry behind an `ssh:<alias>` / `daemon:<alias>` target id. */
    async sshProfile(id) {
      const alias = id.startsWith('ssh:') ? id.slice(4) : id.startsWith('daemon:') ? id.slice(7) : ''
      if (alias === '') throw new Error(`remote: ${JSON.stringify(id)} is not an SSH target`)
      const profiles = await loadSshProfiles()
      const profile = profiles.find((candidate) => candidate.alias === alias)
      if (profile === undefined) {
        throw new Error(`remote: unknown SSH profile ${JSON.stringify(alias)} — check ~/.ssh/config`)
      }
      return profile
    },

    dispose() {
      disposed = true
      for (const backend of live.values()) {
        Promise.resolve(backend)
          .then((b) => (typeof b?.dispose === 'function' ? b.dispose() : undefined))
          .catch((error) => console.error('remote-suite: disposing a backend failed', error))
      }
      live.clear()
    },
  }
}
