// Persisted plugin state: workspaces and (later) SSH/Docker targets.
//
// One JSON file under $DSH_HOME/remote-suite/state.json. `DSH_REMOTE_SUITE_STATE`
// overrides the path, which is what the smoke test uses to keep its writes out of
// the real profile state.
//
// Credentials never land here: an SSH target stores a reference into the OS
// credential store, and this file only keeps that reference.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const EMPTY = { version: 1, workspaces: [], mirrors: [], profiles: [] }

/**
 * Marker file this plugin drops in every local mirror directory so the sidebar
 * can tell which remote target (and which path inside it) a directory stands
 * for. Shape: `{ targetId: "ssh:prod", path: "/srv/app" }`.
 */
export const REMOTE_MARKER = '.dsh-remote.json'

export function statePath() {
  if (process.env.DSH_REMOTE_SUITE_STATE) return process.env.DSH_REMOTE_SUITE_STATE
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'remote-suite', 'state.json')
}

export async function loadState() {
  try {
    const parsed = JSON.parse(await readFile(statePath(), 'utf8'))
    return {
      version: 1,
      workspaces: Array.isArray(parsed.workspaces) ? parsed.workspaces : [],
      mirrors: Array.isArray(parsed.mirrors) ? parsed.mirrors : [],
      profiles: Array.isArray(parsed.profiles) ? parsed.profiles : [],
    }
  } catch {
    return { ...EMPTY, workspaces: [], mirrors: [], profiles: [] }
  }
}

export async function saveState(state) {
  const path = statePath()
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}

export function dataDir() {
  return dirname(statePath())
}

export function makeWorkspaceId(name, existing) {
  const base = `ws-${String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'workspace'}`
  let id = base
  let n = 2
  while (existing.some((w) => w.id === id)) id = `${base}-${n++}`
  return id
}

/**
 * The mirror's leaf directory name, which is what DSH shows as the workspace
 * title. It is the remote basename as-is (no `ws-` prefix) with only the
 * characters a Windows directory cannot hold replaced. A path with no basename
 * (`~`, `/`) falls back to the caller's word for the target kind.
 */
export function makeMirrorLeaf(name) {
  const cleaned = String(name ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-')
    .replace(/^[.\s]+|[.\s]+$/g, '')
  return cleaned === '' ? 'workspace' : cleaned.slice(0, 64)
}

export function makeMirrorId(name, existing) {
  const base = `mir-${String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'mirror'}`
  let id = base
  let n = 2
  while (existing.some((m) => m.id === id)) id = `${base}-${n++}`
  return id
}
