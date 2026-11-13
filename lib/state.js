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

const EMPTY = { version: 1, workspaces: [], mirrors: [], profiles: [], hiddenProfiles: [] }

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
      hiddenProfiles: Array.isArray(parsed.hiddenProfiles) ? parsed.hiddenProfiles : [],
    }
  } catch {
    return { ...EMPTY, workspaces: [], mirrors: [], profiles: [], hiddenProfiles: [] }
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

export function makeMirrorId(name, existing) {
  const base = `mir-${String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'mirror'}`
  let id = base
  let n = 2
  while (existing.some((m) => m.id === id)) id = `${base}-${n++}`
  return id
}
