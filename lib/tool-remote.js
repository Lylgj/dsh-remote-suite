// The `remote` tool: one entry point for every target kind.
//
// Why one tool instead of wsl-* / ssh-* families: the model should not have to
// know which transport a workspace sits on. `targets` lists what exists, every
// other action takes a `target` id (or a `workspace` id) and runs the same code
// path for all kinds.
//
// A workspace is a saved (target, path) pair. Passing `workspace` instead of
// `target` makes `path` relative to that directory and `exec` default to it,
// which is what keeps a long session from repeating absolute paths.

import { join } from 'node:path'

import { truncate } from './backends/base.js'
import { withHint } from './errors.js'
import { describeMirror, pullMirror, pushMirror } from './mirror.js'
import { positiveInt, requireString, resolvePath, resolveScope } from './scope.js'
import { removePassword, setPassword, secretKey } from './secrets.js'
import { dataDir, loadState, makeMirrorId, makeWorkspaceId, saveState } from './state.js'

const ACTIONS = [
  'targets',
  'workspaces',
  'workspace-add',
  'workspace-remove',
  'probe',
  'exec',
  'read',
  'write',
  'edit',
  'stat',
  'list',
  'grep',
  'glob',
  'secret-set',
  'secret-remove',
  'mirrors',
  'mirror-add',
  'mirror-remove',
  'mirror-sync',
]

const FILE_ACTIONS = new Set(['read', 'write', 'stat', 'list', 'grep', 'glob'])

function formatExec(target, result) {
  const markers = []
  if (result.timedOut) markers.push('timed out')
  if (result.truncated) markers.push('output truncated')
  const head = `[${target}] exit=${result.exitCode}${markers.length > 0 ? ` (${markers.join(', ')})` : ''}`
  const stderr = result.stderr.trim() === '' ? '' : `\n--- stderr ---\n${result.stderr.trimEnd()}`
  return `${head}\n${result.stdout.trimEnd()}${stderr}`
}

function formatHits(scope, result) {
  if (result.hits.length === 0) return `no matches on ${scope.label}`
  const lines = result.hits.map((hit) => `${hit.file}:${hit.line}: ${hit.text}`)
  return `${lines.join('\n')}${result.truncated ? `\n[stopped at the result limit]` : ''}`
}

export function createRemoteTool({ registry }) {
  const tool = {
    name: 'remote',
    description:
      'Operate on a remote workspace target: local, WSL distributions, SSH hosts and Docker ' +
      'containers. Actions: `targets` lists target ids; `workspaces` lists saved ' +
      '(target, directory) pairs; `probe` reports what the target really is; `exec` runs a shell ' +
      'command in the target; `read` / `write` / `edit` / `stat` / `list` operate on files; `grep` ' +
      'and `glob` search them; `secret-set` / `secret-remove` manage a stored SSH password; ' +
      '`mirrors` / `mirror-add` / `mirror-remove` / `mirror-sync` keep a local copy of a remote ' +
      'directory. Pass `workspace` instead of `target` to make paths relative to a saved directory.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ACTIONS,
          description: 'What to do.',
        },
        target: {
          type: 'string',
          description: 'Target id from `targets` (local, wsl:<distro>, ...). Required unless `workspace` is given.',
        },
        workspace: {
          type: 'string',
          description: 'Workspace id from `workspaces`. Mutually exclusive with `target`.',
        },
        name: {
          type: 'string',
          description: 'For `workspace-add`: display name. Defaults to the directory basename.',
        },
        command: {
          type: 'string',
          description: 'For `exec`: the command line to run.',
        },
        path: {
          type: 'string',
          description: 'Path inside the target; relative paths resolve against the workspace base.',
        },
        root: {
          type: 'string',
          description: 'For `glob`: directory to search. Defaults to the workspace base or `.`.',
        },
        data: {
          type: 'string',
          description: 'For `write`: full file content (truncates the file).',
        },
        old: {
          type: 'string',
          description: 'For `edit`: the exact text to replace.',
        },
        new: {
          type: 'string',
          description: 'For `edit`: the replacement text.',
        },
        replaceAll: {
          type: 'boolean',
          description: 'For `edit`: allow replacing every occurrence. Defaults to requiring a unique match.',
        },
        pattern: {
          type: 'string',
          description: 'For `grep`: regular expression. For `glob`: glob pattern such as `**/*.ts`.',
        },
        glob: {
          type: 'string',
          description: 'For `grep`: restrict to files matching this glob.',
        },
        workdir: {
          type: 'string',
          description: 'For `exec`: working directory. Defaults to the workspace base. `~` is expanded.',
        },
        timeoutMs: {
          type: 'integer',
          description: 'For `exec`: wall-clock budget, default 120000.',
        },
        offset: {
          type: 'integer',
          description: 'For `read`: 1-based first line.',
        },
        limit: {
          type: 'integer',
          description: 'For `read`: number of lines. For `list`: number of entries. For `grep`/`glob`: result cap.',
        },
        ignoreCase: {
          type: 'boolean',
          description: 'For `grep`: case-insensitive match.',
        },
        password: {
          type: 'string',
          description: 'For `secret-set`: the SSH password to store for this target (mode 0600 file, not state.json).',
        },
        local: {
          type: 'string',
          description: 'For `mirror-add`: local directory. Defaults to $DSH_HOME/remote-suite/mirrors/<id>.',
        },
        mirror: {
          type: 'string',
          description: 'For `mirror-remove` / `mirror-sync`: mirror id from `mirrors`.',
        },
        direction: {
          type: 'string',
          enum: ['pull', 'push'],
          description: 'For `mirror-sync`: `pull` copies remote → local (default), `push` local → remote.',
        },
        force: {
          type: 'boolean',
          description: 'For `mirror-sync`: copy even when the destination looks unchanged, and let `push` overwrite newer remote files.',
        },
        dryRun: {
          type: 'boolean',
          description: 'For `mirror-sync`: report what would be copied without touching any file.',
        },
      },
      required: ['action'],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },

    async run(args) {
      if (!ACTIONS.includes(args.action)) {
        throw new Error(`remote: unknown action ${JSON.stringify(args.action)}`)
      }

      if (args.action === 'targets') {
        const targets = await registry.listTargets()
        return `targets (${targets.length}):\n${targets.map((t) => `${t.id}\t${t.kind}\t${t.label}`).join('\n')}`
      }

      if (args.action === 'workspaces') {
        const state = await loadState()
        if (state.workspaces.length === 0) return 'no workspaces saved'
        return `workspaces (${state.workspaces.length}):\n${state.workspaces
          .map((w) => `${w.id}\t${w.targetId}\t${w.path}\t${w.name}`)
          .join('\n')}`
      }

      if (args.action === 'workspace-add') {
        const targetId = requireString(args, 'target')
        const backend = await registry.backend(targetId)
        const path = requireString(args, 'path')
        const stat = await backend.stat({ path })
        if (stat.type !== 'dir') throw new Error(`remote: workspace path is not a directory: ${path}`)

        const state = await loadState()
        const name = typeof args.name === 'string' && args.name !== ''
          ? args.name
          : path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'workspace'
        const workspace = {
          id: makeWorkspaceId(name, state.workspaces),
          name,
          targetId,
          path,
          createdAt: new Date().toISOString(),
        }
        state.workspaces.push(workspace)
        await saveState(state)
        return `added ${workspace.id} → ${targetId}:${path}`
      }

      if (args.action === 'workspace-remove') {
        const state = await loadState()
        const id = requireString(args, 'workspace')
        const before = state.workspaces.length
        state.workspaces = state.workspaces.filter((w) => w.id !== id)
        if (state.workspaces.length === before) throw new Error(`remote: unknown workspace ${JSON.stringify(id)}`)
        await saveState(state)
        return `removed ${id}`
      }

      if (args.action === 'secret-set') {
        const profile = await registry.sshProfile(requireString(args, 'target'))
        const password = requireString(args, 'password')
        await setPassword(profile, password)
        return `stored a password for ${secretKey(profile)} (mode 0600, never written to state.json)`
      }

      if (args.action === 'secret-remove') {
        const profile = await registry.sshProfile(requireString(args, 'target'))
        const removed = await removePassword(profile)
        return removed ? `removed the stored password for ${secretKey(profile)}` : `no stored password for ${secretKey(profile)}`
      }

      if (args.action === 'mirrors') {
        const state = await loadState()
        if (state.mirrors.length === 0) return 'no mirrors saved'
        return `mirrors (${state.mirrors.length}):\n${state.mirrors.map(describeMirror).join('\n')}`
      }

      if (args.action === 'mirror-add') {
        const targetId = requireString(args, 'target')
        const backend = await registry.backend(targetId)
        const remotePath = requireString(args, 'path')
        const stat = await backend.stat({ path: remotePath })
        if (stat.type !== 'dir') throw new Error(`remote: mirror path is not a directory: ${remotePath}`)

        const state = await loadState()
        const name = typeof args.name === 'string' && args.name !== ''
          ? args.name
          : remotePath.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'mirror'
        const id = makeMirrorId(name, state.mirrors)
        const localPath = typeof args.local === 'string' && args.local !== ''
          ? args.local
          : join(dataDir(), 'mirrors', id)
        const mirror = { id, name, targetId, remotePath, localPath, createdAt: new Date().toISOString() }
        state.mirrors.push(mirror)
        await saveState(state)
        return `added ${describeMirror(mirror)}`
      }

      if (args.action === 'mirror-remove') {
        const state = await loadState()
        const id = requireString(args, 'mirror')
        const before = state.mirrors.length
        state.mirrors = state.mirrors.filter((m) => m.id !== id)
        if (state.mirrors.length === before) throw new Error(`remote: unknown mirror ${JSON.stringify(id)}`)
        await saveState(state)
        return `removed ${id} (the local copy was left on disk)`
      }

      if (args.action === 'mirror-sync') {
        const state = await loadState()
        const id = requireString(args, 'mirror')
        const mirror = state.mirrors.find((m) => m.id === id)
        if (mirror === undefined) throw new Error(`remote: unknown mirror ${JSON.stringify(id)}`)
        const direction = args.direction === 'push' ? 'push' : 'pull'
        const options = { force: args.force === true, dryRun: args.dryRun === true }
        const report = direction === 'push'
          ? await pushMirror(registry, mirror, options)
          : await pullMirror(registry, mirror, options)

        const lines = [
          `${direction} ${report.copied.length} file(s), ${report.bytes} bytes, ${report.skipped} unchanged`,
        ]
        if (report.copied.length > 0) {
          const shown = report.copied.slice(0, 20)
          lines.push(shown.join('\n') + (report.copied.length > shown.length ? `\n… ${report.copied.length - shown.length} more` : ''))
        }
        if (report.conflicts?.length > 0) {
          lines.push(`skipped ${report.conflicts.length} newer remote file(s) — use force to overwrite:\n${report.conflicts.slice(0, 20).join('\n')}`)
        }
        return lines.join('\n')
      }

      const scope = await resolveScope(registry, args)
      const { backend, label } = scope
      const limitDefault = FILE_ACTIONS.has(args.action) || args.action === 'exec' ? 100 : 500

      switch (args.action) {
        case 'exec': {
          const workdir = args.workdir === undefined ? scope.base : args.workdir
          const result = await backend.exec({
            command: requireString(args, 'command'),
            workdir,
            timeoutMs: positiveInt(args.timeoutMs, 120_000),
          })
          return formatExec(label, result)
        }
        case 'read': {
          const text = await backend.read({
            path: resolvePath(backend, scope, args),
            offset: args.offset === undefined ? undefined : positiveInt(args.offset, 1),
            limit: args.limit === undefined ? undefined : positiveInt(args.limit, 1),
          })
          return truncate(text).text
        }
        case 'write': {
          const data = typeof args.data === 'string' ? args.data : ''
          const { bytes } = await backend.write({ path: resolvePath(backend, scope, args), data })
          return `wrote ${bytes} bytes to ${args.path} on ${label}`
        }
        case 'edit': {
          const path = resolvePath(backend, scope, args)
          const oldText = requireString(args, 'old')
          const newText = requireString(args, 'new')
          const content = await backend.read({ path, maxBytes: 4 * 1024 * 1024 })
          const parts = content.split(oldText)
          const count = parts.length - 1
          if (count === 0) throw new Error(`remote: \`old\` does not appear in ${args.path}`)
          if (count > 1 && args.replaceAll !== true) {
            throw new Error(
              `remote: \`old\` appears ${count} times in ${args.path}; pass replaceAll: true or a longer snippet`,
            )
          }
          const next = parts.join(newText)
          await backend.write({ path, data: next })
          return `replaced ${count} occurrence${count === 1 ? '' : 's'} in ${args.path} on ${label}`
        }
        case 'probe': {
          const facts = await backend.probe()
          return `${label}:\n${Object.entries(facts)
            .map(([k, v]) => `${k}: ${String(v)}`)
            .join('\n')}`
        }
        case 'stat': {
          const stat = await backend.stat({ path: resolvePath(backend, scope, args) })
          return `${args.path} on ${label}: ${stat.type} ${stat.size} bytes`
        }
        case 'list': {
          const result = await backend.list({
            path: resolvePath(backend, scope, args),
            limit: positiveInt(args.limit, 500),
          })
          const lines = result.entries.map(
            (e) => `${e.type === 'dir' ? 'd' : e.type === 'file' ? 'f' : '?'} ${String(e.size).padStart(9)}  ${e.name}`,
          )
          const tail = result.truncated ? '\n[truncated]' : ''
          return `${args.path} on ${label} (${result.entries.length} entries):\n${lines.join('\n')}${tail}`
        }
        case 'grep': {
          const result = await backend.grep({
            pattern: requireString(args, 'pattern'),
            path: resolvePath(backend, scope, args),
            glob: args.glob,
            maxResults: positiveInt(args.limit, limitDefault),
            ignoreCase: args.ignoreCase === true,
          })
          return formatHits({ label }, result)
        }
        case 'glob': {
          const rootArg = typeof args.path === 'string' && args.path !== ''
            ? args.path
            : typeof args.root === 'string' && args.root !== '' ? args.root : undefined
          const root = rootArg === undefined
            ? scope.base ?? '.'
            : scope.base === undefined ? rootArg : backend.join(scope.base, rootArg)
          const result = await backend.glob({
            pattern: requireString(args, 'pattern'),
            root,
            maxResults: positiveInt(args.limit, 500),
          })
          if (result.files.length === 0) return `no files match ${args.pattern} on ${label}`
          return `${result.files.join('\n')}${result.truncated ? '\n[stopped at the result limit]' : ''}`
        }
        default:
          throw new Error(`remote: action ${args.action} is not wired yet`)
      }
    },

    /**
     * Every action funnels through here, so a transport hint (a missing
     * distribution, an unreachable Docker engine, a rejected SSH login) reaches
     * the model with a next step regardless of which backend failed.
     */
    async execute(args) {
      try {
        return await tool.run(args)
      } catch (error) {
        throw withHint(error)
      }
    },
  }
  return tool
}
