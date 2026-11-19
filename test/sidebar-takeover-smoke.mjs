// Right-sidebar takeover smoke test.
//
// Two of the Host's panes are replaced: the workspace file tree (`files`) and the
// terminal (`terminal`). Both claims are `extension` band, both are switchable
// from a settings section, and both must survive the registry's one-extension-per
// -kind rule: when another extension already holds a pane, this plugin switches
// that takeover off (and reports who holds it) instead of throwing.
//
//     node test/sidebar-takeover-smoke.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import { renderToStaticMarkup } from 'react-dom/server'

const SOURCE = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const require = createRequire(import.meta.url)
const React = require('react')

// Stand-ins for the host UI kit: the sources of this module only need the parts
// the plugin renders, and none of the assertions look at pixel output.
const kit = {
  Modal: () => null,
  Button: (props) => React.createElement('button', { onClick: props.onClick }, props.children),
  Input: (props) => React.createElement('input', { value: props.value, onChange: props.onChange }),
  SegmentedControl: () => React.createElement('div'),
  FileTypeIcon: () => React.createElement('span'),
}

/**
 * Load a fresh copy of client.js. The takeover state lives in module scope, so
 * every scenario needs its own instance.
 */
function loadClient({ settings } = {}) {
  let loaded
  // `call()` builds its URL with `URL`, which a bare vm context does not carry.
  const sandbox = { console, setTimeout, clearTimeout, URL }
  sandbox.window = sandbox
  sandbox.self = sandbox
  sandbox.document = undefined
  sandbox.__ModuleLoader__ = {
    load(definition) {
      loaded = definition
    },
  }
  if (settings !== undefined) {
    sandbox.fetch = async (url) => {
      const method = String(url).split('/').pop()
      const result = method === 'settings' ? settings : settings
      return { status: 200, async text() { return JSON.stringify({ ok: true, result }) } }
    }
  }
  vm.createContext(sandbox)
  vm.runInContext(SOURCE, sandbox, { filename: 'client.js' })
  assert.ok(loaded, 'client.js must call window.__ModuleLoader__.load')
  return loaded.factory((id) => {
    if (id === 'react') return React
    if (id === 'react-dom') return { createPortal: (node) => node }
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return kit
    throw new Error(`client asked for an unexpected module: ${id}`)
  })
}

/** A stub sidebarRightTabs registry that enforces the one-extension-per-kind rule. */
function makeRegistry() {
  const kinds = new Map()
  const registered = []
  return {
    registered,
    register(definition) {
      const held = kinds.get(definition.kind)
      if (held !== undefined && held.priority === 'extension' && definition.priority === 'extension') {
        throw new Error(`sidebarRight: tab kind "${definition.kind}" is already registered (extension)`)
      }
      registered.push(definition)
      kinds.set(definition.kind, definition)
      return () => {
        if (kinds.get(definition.kind) === definition) kinds.delete(definition.kind)
      }
    },
    get(kind) {
      return kinds.get(kind)
    },
  }
}

/** Mount the client against a stub Host. */
async function mount({
  takenFiles,
  takenFilesPriority = 'extension',
  takenTerminal,
  betterSidebar = false,
  settings = { takeOverFiles: true, takeOverTerminal: true },
} = {}) {
  const module = loadClient({ settings })
  const tabs = makeRegistry()
  const seats = new Map()
  const warnings = []
  const errors = []
  if (takenFiles !== undefined) tabs.register({ id: takenFiles, kind: 'files', priority: takenFilesPriority })
  if (takenTerminal !== undefined) tabs.register({ id: takenTerminal, kind: 'terminal', priority: 'extension' })

  const ctx = {
    get(name) {
      if (name === 'workspaces') return { create: async () => ({ workspaceId: 'w1' }) }
      if (name === 'sidebarRightTabs') return tabs
      if (name === 'betterSidebar') return betterSidebar ? { registerTab() {} } : undefined
      return undefined
    },
    inject(_deps, callback) {
      callback({ slots: ctx.slots, sidebarRightTabs: tabs, effect: (run) => run() })
      return () => {}
    },
    slots: {
      inject(_name, callback) {
        return callback()
      },
      register(descriptor, component) {
        const key = `${descriptor.name}:${descriptor.id ?? descriptor.key ?? ''}`
        seats.set(key, component)
        return () => seats.delete(key)
      },
    },
  }

  const originalWarn = console.warn
  const originalError = console.error
  console.warn = (...args) => warnings.push(args.join(' '))
  console.error = (...args) => errors.push(args.join(' '))
  try {
    module.apply(ctx)
    await new Promise((resolve) => setTimeout(resolve, 200))
  } finally {
    console.warn = originalWarn
    console.error = originalError
  }
  return { module, tabs, seats, warnings, errors }
}

// 1. Nothing holds either pane: both are claimed, at extension level, with their
//    bodies and the settings section.
{
  const { tabs, seats, warnings, errors } = await mount()
  assert.equal(errors.length, 0, 'claiming free panes must not log an error')
  assert.equal(warnings.length, 0, 'claiming free panes must not warn')
  assert.deepEqual(
    tabs.registered.map((tab) => tab.kind).sort(),
    ['files', 'terminal'],
    'both panes are claimed by default',
  )
  for (const tab of tabs.registered) {
    assert.equal(tab.priority, 'extension', `${tab.kind} is claimed at extension level`)
  }
  assert.ok(seats.has('sidebar.right.pane.tab:remote-suite/files'))
  assert.ok(seats.has('sidebar.right.pane.tab:remote-suite/terminal'))
  assert.ok(seats.has('settings.section:remote-suite'), 'the switches mount in settings')
  assert.ok(seats.has('main:remote-suite'), 'the rest of the plugin must still mount')
  assert.ok(seats.has('shell.overlay:remote-suite'), 'the workbench must still mount')
}

// 2. Another extension already holds `files`: that claim is refused (the registry
//    would throw), reported once, and the terminal half still mounts.
{
  const { tabs, seats, warnings, errors } = await mount({ takenFiles: 'dsh-better-sidebar:files' })
  assert.equal(errors.length, 0, 'a refused claim is a normal outcome, not an error')
  assert.ok(
    warnings.some((line) => /占用/.test(line) && line.includes('dsh-better-sidebar:files')),
    'the warning must name whoever holds the pane',
  )
  assert.equal(tabs.get('files').id, 'dsh-better-sidebar:files', 'the held pane stays with its owner')
  assert.equal(tabs.get('terminal').id, 'remote-suite/terminal', 'the other pane is still taken over')
  assert.ok(!seats.has('sidebar.right.pane.tab:remote-suite/files'), 'no body for a pane we do not own')
}

// 3. The Host's own pane holds `files` in the builtin band: that is precisely
//    what an extension claim is for, so the claim goes ahead silently.
{
  const { tabs, warnings } = await mount({
    takenFiles: '@deepseek-ai/dsh-client-ui-sidebar-files',
    takenFilesPriority: 'builtin',
  })
  assert.equal(warnings.length, 0, 'the builtin pane is not a takeover to warn about')
  assert.equal(tabs.get('files').id, 'remote-suite/files', 'an extension claim outranks the builtin pane')
}

// 4. The switch is persisted off: the pane that was claimed on the defaults is
//    handed back once the stored settings arrive, and the other one stays.
{
  const { tabs, seats } = await mount({ settings: { takeOverFiles: false, takeOverTerminal: true } })
  assert.equal(tabs.get('files'), undefined, 'a pane switched off is released')
  assert.equal(tabs.get('terminal').id, 'remote-suite/terminal', 'the pane left on stays claimed')
  assert.ok(!seats.has('sidebar.right.pane.tab:remote-suite/files'))
  assert.ok(seats.has('sidebar.right.pane.tab:remote-suite/terminal'))
}

// 5. A released pane must never report this plugin as its holder: the label
//    falls back to the Host's own pane, and the rows keep their glyphs.
{
  const { seats } = await mount({ settings: { takeOverFiles: false, takeOverTerminal: true } })
  const Section = seats.get('settings.section:remote-suite')
  assert.equal(typeof Section, 'function', 'the settings section is mounted')
  const html = renderToStaticMarkup(React.createElement(Section))
  assert.ok(!/remote-suite\/files 接管|Now: remote-suite\/files/.test(html), 'a released pane must not name itself as the holder')
  assert.ok(/DSH 自带/.test(html) || /DSH(&#x27;|')s own pane/.test(html), 'a released pane falls back to the Host pane')
  assert.ok(/当前：本插件接管|handled by this plugin/.test(html), 'the pane left on reports this plugin')
  assert.ok(html.includes('rs-set-glyph'), 'each row carries a glyph')
  assert.ok(html.includes('rs-set-switch'), 'each row carries a switch')
}

// 6. dsh-better-sidebar is installed: it claims the `files` kind, and the Host
//    refuses a second extension-level claim there, so the file pane is left to it
//    (that claim would only make the other plugin throw a red error) while its
//    file pane still gets the remote data from the /sidebar/api routes. The
//    terminal pane is ours either way — its terminal is not a sidebar tab kind.
{
  const info = []
  const originalInfo = console.info
  console.info = (...args) => info.push(args.join(' '))
  let mounted
  try {
    mounted = await mount({ betterSidebar: true })
  } finally {
    console.info = originalInfo
  }
  assert.equal(mounted.errors.length, 0, 'yielding the file pane must not log an error')
  assert.equal(mounted.warnings.length, 0, 'yielding the file pane must not warn')
  assert.deepEqual(mounted.tabs.registered.map((tab) => tab.kind), ['terminal'], 'only the file pane is yielded')
  assert.equal(mounted.tabs.get('files'), undefined, 'the file pane is never claimed while better-sidebar is installed')
  assert.equal(mounted.tabs.get('terminal').id, 'remote-suite/terminal', 'the terminal pane stays ours')
  assert.ok(!mounted.seats.has('sidebar.right.pane.tab:remote-suite/files'))
  assert.ok(mounted.seats.has('sidebar.right.pane.tab:remote-suite/terminal'))
  assert.ok(mounted.seats.has('main:remote-suite'), 'the rest of the plugin still mounts')
  assert.ok(mounted.seats.has('settings.section:remote-suite'), 'the switches still mount')
  assert.equal(info.filter((line) => /better-sidebar/.test(line)).length, 1, 'one note about the file pane')

  const Section = mounted.seats.get('settings.section:remote-suite')
  const html = renderToStaticMarkup(React.createElement(Section))
  assert.ok(/dsh-better-sidebar/.test(html), 'the settings section names the plugin that draws the file pane')
  assert.ok(/数据由本插件提供|data served by this plugin/.test(html), 'and says where the file data comes from')
  assert.ok(/当前：本插件接管|handled by this plugin/.test(html), 'the terminal row still reports this plugin')
}

console.log('sidebar takeover smoke ok')
