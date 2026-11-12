// Terminal plumbing shared by every backend.
//
// The Host owns the PTY: `ctx.subprocess.spawnTerminal` is the one supported way
// to get a real terminal, so this plugin never spawns a shell itself (no
// node-pty, no winpty, nothing to compile). Local and WSL backends hand their
// argv to that provider; SSH uses its own `shell` channel on the existing ssh2
// connection, so an SSH terminal inherits the same auth (key, agent, ProxyJump)
// the file tools already use.
//
// A handle is whatever the provider returns: `{ output, done, write, resize,
// terminate }`. Every backend's `openTerminal()` returns that shape, and
// lib/pty-server.js only ever talks to the handle.

export const DEFAULT_COLS = 120
export const DEFAULT_ROWS = 30

const MAX_COLS = 400
const MAX_ROWS = 200

/** Keep a client-supplied size inside what a real terminal can display. */
export function clampSize(cols, rows) {
  const width = Number.isSafeInteger(cols) && cols >= 2 ? Math.min(cols, MAX_COLS) : DEFAULT_COLS
  const height = Number.isSafeInteger(rows) && rows >= 1 ? Math.min(rows, MAX_ROWS) : DEFAULT_ROWS
  return { cols: width, rows: height }
}

/**
 * The terminal-capable subprocess provider, if this build has one.
 *
 * Looked up through `ctx.get` rather than `inject` on purpose: a Host without it
 * must still mount this plugin (the file tools do not need a PTY).
 *
 * @param ctx - the plugin context
 * @returns the provider, or null
 */
export function terminalProvider(ctx) {
  try {
    const provider = typeof ctx?.get === 'function' ? ctx.get('subprocess') : undefined
    if (provider !== null && typeof provider === 'object' && typeof provider.spawnTerminal === 'function') {
      return provider
    }
  } catch {
    // A host that faults on the lookup simply has no PTY.
  }
  return null
}

/**
 * Wrap the Host provider as `spawnPty({ argv, cwd, cols, rows, env, signal })`.
 *
 * @param ctx - the plugin context
 * @returns an async function; it throws a useful error on hosts without a PTY
 */
export function createPtySpawner(ctx) {
  const provider = terminalProvider(ctx)
  return async function spawnPty({ argv, cwd, cols, rows, env = {}, signal }) {
    if (provider === null) {
      throw new Error('remote-suite: this DSH build has no PTY provider (ctx.subprocess.spawnTerminal)')
    }
    const size = clampSize(cols, rows)
    return provider.spawnTerminal({
      argv,
      cwd,
      cols: size.cols,
      rows: size.rows,
      terminalType: 'xterm-256color',
      env,
      graceMs: 2000,
      signal,
    })
  }
}

/**
 * The shell to open for a local terminal.
 *
 * `DSH_REMOTE_SHELL` wins, so a user on Windows can ask for `cmd.exe` or `nu`
 * without a rebuild. Otherwise: PowerShell on Windows, `$SHELL` elsewhere.
 */
export function localShellArgv() {
  const override = process.env.DSH_REMOTE_SHELL
  if (override !== undefined && override.trim() !== '') return [override.trim()]
  if (process.platform === 'win32') return ['powershell.exe', '-NoLogo']
  return [process.env.SHELL || '/bin/bash', '-l']
}

/** `wsl.exe -d <distro> --cd <dir> -e bash -l` — the launcher switches the directory itself. */
export function wslShellArgv({ distro, cwd } = {}) {
  const args = ['wsl.exe']
  if (typeof distro === 'string' && distro !== '') args.push('-d', distro)
  if (typeof cwd === 'string' && cwd !== '') args.push('--cd', cwd)
  args.push('-e', 'bash', '-l')
  return args
}
