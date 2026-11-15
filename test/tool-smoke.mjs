// Smoke test for the `remote` tool surface: the action list the model sees and
// the file tree actions (mkdir / rename / remove) end to end on the local
// backend. No WSL, SSH or Docker needed.
//
//     node test/tool-smoke.mjs

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createLocalBackend } from '../lib/backends/local.js'
import { createRemoteTool } from '../lib/tool-remote.js'

const stateFile = path.join(os.tmpdir(), `remote-suite-tool-${process.pid}.json`)
process.env.DSH_REMOTE_SUITE_STATE = stateFile
await fs.rm(stateFile, { force: true })

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-suite-tool-'))
const backend = createLocalBackend()
const registry = {
  listTargets: async () => [{ id: 'local', kind: 'local', label: '此电脑' }],
  backend: async (id) => {
    if (id === 'local') return backend
    throw new Error(`remote: unknown target ${JSON.stringify(id)}`)
  },
}

try {
  const tool = createRemoteTool({ registry })

  // The model only ever sees this enum, so a missing action is invisible work.
  const actions = tool.parameters.properties.action.enum
  for (const wanted of ['mkdir', 'rename', 'remove']) {
    assert.equal(actions.includes(wanted), true, `action list is missing ${wanted}`)
  }

  const work = path.join(root, 'work')

  const madeDir = await tool.execute({ action: 'mkdir', target: 'local', path: work })
  assert.match(madeDir, /created directory/)
  assert.equal((await fs.stat(work)).isDirectory(), true)

  const wrote = await tool.execute({ action: 'write', target: 'local', path: path.join(work, 'a.txt'), data: 'one\n' })
  assert.match(wrote, /wrote 4 bytes/)

  const renamed = await tool.execute({
    action: 'rename',
    target: 'local',
    from: path.join(work, 'a.txt'),
    to: path.join(work, 'nested', 'b.txt'),
  })
  assert.match(renamed, /renamed/)
  assert.equal(await fs.readFile(path.join(work, 'nested', 'b.txt'), 'utf8'), 'one\n')

  const read = await tool.execute({ action: 'read', target: 'local', path: path.join(work, 'nested', 'b.txt') })
  assert.equal(read.trim(), 'one')

  const removed = await tool.execute({ action: 'remove', target: 'local', path: path.join(work, 'nested'), recursive: true })
  assert.match(removed, /removed/)
  await assert.rejects(fs.stat(path.join(work, 'nested')), /ENOENT/)

  // A non-empty directory must refuse to go without recursive: true.
  await fs.mkdir(path.join(work, 'keep'), { recursive: true })
  await fs.writeFile(path.join(work, 'keep', 'x.txt'), 'x')
  await assert.rejects(
    tool.execute({ action: 'remove', target: 'local', path: path.join(work, 'keep') }),
    /recursive/,
  )

  // Errors keep their transport hint wrapper.
  await assert.rejects(
    tool.execute({ action: 'mkdir', target: 'nope', path: '/tmp/x' }),
    /unknown target/,
  )

  console.log('ok  remote tool file actions')
} finally {
  await fs.rm(root, { recursive: true, force: true })
  await fs.rm(stateFile, { force: true })
}
