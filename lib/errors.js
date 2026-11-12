// Turning transport noise into something a person (or a model) can act on.
//
// Backends surface whatever the transport said — a Node errno, a `wsl.exe`
// HRESULT, a Docker daemon string, an ssh2 failure. Those are precise but not
// useful on their own, so one table maps the recurring ones to a sentence with
// the next step in it. Anything unmatched is returned untouched: inventing a
// hint for an unknown error would hide the real message.

const RULES = [
  [
    /no such file or directory|ENOENT/i,
    'no such file or directory',
  ],
  [
    /permission denied|EACCES|EPERM/i,
    'permission denied',
  ],
  [
    /ECONNREFUSED/i,
    'connection refused (is the service running, and listening on that address?)',
  ],
  [
    /ECONNRESET|ECONNABORTED/i,
    'the connection was reset',
  ],
  [
    /ETIMEDOUT|timed out|operation timed out/i,
    'timed out',
  ],
  [
    /no distribution with the supplied name|WSL_E_DISTRO_NOT_FOUND|0x8007019e/i,
    'that WSL distribution is not installed — check `wsl -l -q`',
  ],
  [
    /0x800701bc/i,
    'WSL2 is not installed or its kernel is missing — run `wsl --update`',
  ],
  [
    /instance has terminated|WSL_E_DISTRO_NOT_FOUND/i,
    'the WSL instance stopped; it restarts on the next command',
  ],
  [
    /Cannot connect to the Docker daemon|docker daemon|Is the docker daemon running/i,
    'the Docker engine is not reachable — start it, or point DSH_DOCKER at another engine',
  ],
  [
    /All configured authentication methods failed/i,
    'SSH authentication failed for every key, agent identity and stored password — check IdentityFile / DSH_SSH_IDENTITY, or `remote { action: "secret-set" }`',
  ],
]

/** Transient transport failures worth one silent retry. */
const TRANSIENT = /ECONNRESET|ECONNABORTED|i\/o timeout|TLS handshake timeout|connection reset|instance has terminated|WSL_E_DISTRO_NOT_FOUND|0x8007019e/i

/** A hint for a known failure, or the original message unchanged. */
export function explain(error) {
  const text = error instanceof Error ? error.message : String(error)
  for (const [pattern, hint] of RULES) {
    if (pattern.test(text)) {
      if (text.includes(hint)) return text
      return `${text}\n${hint}`
    }
  }
  return text
}

export function isTransient(error) {
  const text = error instanceof Error ? error.message : String(error)
  return TRANSIENT.test(text)
}

/** Wrap an error with the hint, keeping it an Error so the stack survives. */
export function withHint(error) {
  const text = explain(error)
  const message = error instanceof Error ? error.message : String(error)
  if (text === message) return error
  const wrapped = new Error(text)
  if (error instanceof Error && error.stack !== undefined) {
    wrapped.stack = `${wrapped.stack}\nCaused by: ${error.stack}`
  }
  return wrapped
}
