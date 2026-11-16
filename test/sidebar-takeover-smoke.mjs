// Right-sidebar `files` kind smoke test.
//
// The host allows exactly one `extension` claim per tab kind. better-sidebar
// claims the same `files` kind, and its own panel already speaks the file API
// this plugin serves on `/sidebar/api/*`, so when it is installed its UI must be
// kept and ours must stay out of the way — without throwing during client load
// and without depending on which bundle happens to load first.
//
//     node test/sidebar-takeover-smoke.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'

const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const require = createRequire(import.meta.url)
const React = require('react')

let loaded
const sandbox = {
  console,
  setTimeout,
  clearTimeout,
}
sandbox.window = sandbox
sandbox.self = sandbox
sandbox.document = undefined
sandbox.__ModuleLoader__ = {
  load(definition) {
    loaded = definition
  },
}
vm.createContext(sandbox)
vm.runInContext(source, sandbox, { filename: 'client.js' })

assert.ok(loaded, 'client.js must call window.__ModuleLoader__.load')
assert.equal(loaded.id, '@lylgj/dsh-remote-suite')

// Stand-ins for the host UI kit: the sources of this module only need the parts
// the plugin renders, and none of the assertions below look at pixel output.
const kit = {
  Modal: () => null,
  Button: (props) => React.createElement('button', { onClick: props.onClick }, props.children),
  Input: (props) => React.createElement('input', { value: props.value, onChange: props.onChange }),
  SegmentedControl: () => React.createElement('div'),
  FileTypeIcon: () => React.createElement('span'),
}

const module = loaded.factory((id) => {
  if (id === 'react') return React
  if (id === 'react-dom') return { createPortal: (node) => node }
  if (id === '@deepseek-ai/dsh-client-ui-primitives') return kit
  throw new Error(`client asked for an unexpected module: ${id}`)
})

/**
 * Mount the client against a stub Host.
 *
 * @param {object} options
 * @param {string | undefined} options.takenId  id already holding the `files` kind
 * @param {string} [options.takenPriority]      that holder's band (`extension` by default)
 * @param {boolean} options.betterSidebar       whether better-sidebar is loaded
 */
async function mount({ takenId, takenPriority = 'extension', betterSidebar }) {
  const tabTypes = []
  const warnings = []
  const infos = []
  const seats = new Map()
  const ctx = {
    get(name) {
      if (name === 'workspaces') return { create: async () => ({ workspaceId: 'w1' }) }
      if (name === 'betterSidebar') return betterSidebar ? { registerTab() {} } : undefined
      return undefined
    },
    inject(deps, callback) {
      if (!deps.includes('sidebarRightTabs')) return undefined
      callback({
        slots: ctx.slots,
        sidebarRightTabs: {
          get(kind) {
            return kind === 'files' && takenId !== undefined
              ? { id: takenId, kind: 'files', priority: takenPriority }
              : undefined
          },
          register(definition) {
            tabTypes.push(definition)
            return () => {}
          },
        },
        effect(run) {
          return run()
        },
      })
      return () => {}
    },
    slots: {
      inject(_name, callback) {
        return callback()
      },
      register(descriptor, component) {
        seats.set(`${descriptor.name}:${descriptor.id ?? descriptor.key ?? ''}`, component)
        return () => seats.delete(`${descriptor.name}:${descriptor.id ?? descriptor.key ?? ''}`)
      },
    },
  }

  const originalWarn = console.warn
  const originalInfo = console.info
  console.warn = (...args) => warnings.push(args.join(' '))
  console.info = (...args) => infos.push(args.join(' '))
  try {
    module.apply(ctx)
    await new Promise((resolve) => setTimeout(resolve, 400))
  } finally {
    console.warn = originalWarn
    console.info = originalInfo
  }
  return { tabTypes, warnings, infos, seats }
}

// 1. better-sidebar already holds the kind: nothing to claim, one warning.
{
  const { tabTypes, warnings, seats } = await mount({ takenId: 'dsh-better-sidebar:files', betterSidebar: true })
  assert.equal(tabTypes.length, 0, 'a files kind already held by better-sidebar must stay theirs')
  assert.equal(warnings.length, 1, 'bowing out must be reported once')
  assert.match(warnings[0], /占用|already/, 'the warning must name the takeover it skipped')
  assert.ok(seats.has('main:remote-suite'), 'the rest of the plugin must still mount')
  assert.ok(seats.has('shell.overlay:remote-suite'), 'the workbench must still mount')
}

// 2. better-sidebar is loaded but has not registered yet: its panel is still
//    preferred, because the host answers its file calls with our remote data.
{
  const { tabTypes, infos, seats } = await mount({ takenId: undefined, betterSidebar: true })
  assert.equal(tabTypes.length, 0, 'better-sidebar must keep its own panel when installed')
  assert.equal(infos.length, 1, 'deferring to better-sidebar must be reported once')
  assert.match(infos[0], /better-sidebar/)
  assert.ok(seats.has('main:remote-suite'), 'the rest of the plugin must still mount')
}

// 3. no better-sidebar: this plugin owns the panel.
{
  const { tabTypes, warnings, seats } = await mount({ takenId: undefined, betterSidebar: false })
  assert.equal(warnings.length, 0, 'claiming the kind must not warn')
  assert.equal(tabTypes.length, 1, 'without better-sidebar the plugin claims the files kind')
  assert.equal(tabTypes[0].id, 'remote-suite/files')
  assert.equal(tabTypes[0].kind, 'files')
  assert.ok(
    seats.has('sidebar.right.pane.tab:remote-suite/files'),
    'the panel body must be registered for the claimed kind',
  )
}

// 4. the Host's own pane holds the kind in the builtin band: that is precisely
//    what an extension-band claim is for, so the claim must go ahead. Deferring
//    here would leave the pane showing the local mirror directory.
{
  const { tabTypes, warnings } = await mount({
    takenId: '@deepseek-ai/dsh-client-ui-sidebar-files',
    takenPriority: 'builtin',
    betterSidebar: false,
  })
  assert.equal(warnings.length, 0, 'the builtin pane is not a takeover to warn about')
  assert.equal(tabTypes.length, 1, 'an extension claim outranks the builtin pane')
  assert.equal(tabTypes[0].id, 'remote-suite/files')
}

console.log('sidebar takeover smoke ok')
