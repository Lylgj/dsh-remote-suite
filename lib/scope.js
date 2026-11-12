// Scope resolution shared by the `remote` tool and the HTTP API.
//
// A "scope" is either a bare target (`target: 'ssh:host'`) or a saved workspace
// (`workspace: 'ws-proj'`), which pins a backend plus a base directory. Keeping
// this in one place is what lets the panel and the model address the same paths
// with the same rules: relative paths resolve against the workspace base, and
// `exec` defaults its working directory to that base.

import { loadState } from './state.js'

export function requireString(args, field) {
  const value = args[field]
  if (typeof value !== 'string' || value === '') {
    throw new Error(`remote: \`${field}\` must be a non-empty string`)
  }
  return value
}

export function positiveInt(value, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.max(1, Math.trunc(value))
}

/**
 * Turn `workspace` or `target` into `{ backend, label, base }`.
 * @param registry backend registry from `createRegistry`
 * @param args tool/api arguments
 */
export async function resolveScope(registry, args) {
  if (args.workspace !== undefined) {
    const state = await loadState()
    const workspace = state.workspaces.find((w) => w.id === args.workspace)
    if (workspace === undefined) {
      throw new Error(
        `remote: unknown workspace ${JSON.stringify(args.workspace)} — call action "workspaces"`,
      )
    }
    return {
      backend: await registry.backend(workspace.targetId),
      label: workspace.name,
      base: workspace.path,
      workspace,
    }
  }
  const targetId = requireString(args, 'target')
  const backend = await registry.backend(targetId)
  return { backend, label: backend.label || targetId, base: undefined, workspace: undefined }
}

/** Resolve `args.path` against the scope base (or return it as-is for a bare target). */
export function resolvePath(backend, scope, args) {
  const raw = requireString(args, 'path')
  if (scope.base === undefined) return raw
  return backend.join(scope.base, raw)
}

/** The directory a command runs in when the caller did not name one. */
export function defaultWorkdir(scope) {
  return scope.base
}
