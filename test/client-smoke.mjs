// Client bundle smoke test.
//
// Loads client.js the way the DSH page does (window.__ModuleLoader__.load),
// mounts the two seats with a stub slots service and renders everything with
// react-dom/server, so a broken component tree fails here instead of in the GUI.
//
// This is a render-level test: effects do not run, so no fetch happens. The
// network contract is covered by test/api-smoke.mjs.
//
//     node test/client-smoke.mjs

import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'

const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const require = createRequire(import.meta.url)
const React = require('react')
const { renderToString } = require('react-dom/server')

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

// Stand-ins for the host UI kit. They render semantics, not looks: the dialog
// must go through Modal/Button/Input/SegmentedControl rather than raw elements,
// and this stub keeps that contract honest without the real stylesheet.
const kit = {
  Modal: (props) =>
    props.open === true
      ? React.createElement('div', { 'data-modal': props.title }, props.children, props.footer)
      : null,
  Button: (props) => React.createElement('button', { disabled: props.disabled, onClick: props.onClick }, props.children),
  Input: (props) =>
    React.createElement('input', { value: props.value, placeholder: props.placeholder, onChange: props.onChange }),
  SegmentedControl: (props) =>
    React.createElement(
      'div',
      { className: 'segmented' },
      props.options.map((option) => React.createElement('span', { key: option.value }, option.label)),
    ),
}

const module = loaded.factory((id) => {
  if (id === 'react') return React
  if (id === 'react-dom') return { createPortal: (node) => node }
  if (id === '@deepseek-ai/dsh-client-ui-primitives') return kit
  throw new Error(`client asked for an unexpected module: ${id}`)
})

assert.equal(typeof module.apply, 'function')
assert.equal(module.inject.join(','), 'slots,workspaces')

const seats = new Map()
const tabTypes = []
const sidebarRightTabs = {
  register(definition) {
    tabTypes.push(definition)
    return () => {}
  },
  candidates: () => [],
}
const ctx = {
  get(name) {
    if (name === 'workspaces') return { create: async () => ({ workspaceId: 'w1' }) }
    return undefined
  },
  inject(names, callback) {
    if (names.includes('sidebarRightTabs')) {
      callback({
        get: ctx.get,
        slots: ctx.slots,
        sidebarRightTabs,
        effect: (run) => run(),
      })
    } else {
      callback({})
    }
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
module.apply(ctx)

// The workbench is the point of the plugin: a Docker/SSH workspace opens onto an
// empty mirror directory, so the only way to browse and edit the container's real
// files is this live workbench (tree/read/write all go through `docker exec` /
// the SSH channel, never the mirror). It mounts in the shell overlay, and the
// left rail holds the entry that opens it — the user asked for the capsule back
// in the sidebar instead of next to the composer, so there must be no composer
// pill and exactly one rail entry.
assert.ok(seats.has('shell.overlay:remote-suite'), 'the plugin must mount its workbench in shell.overlay')
assert.ok(seats.has('sidebar.panellist:remote-suite'), 'the plugin must add its rail entry')
assert.ok(!seats.has('conversation.input.left:remote-suite'), 'the composer pill must be gone')
// A rail click in the host resolves to the `main` panel sharing the id, so the
// launcher seat is what makes the icon react at all — without it the click
// switches to a panel that does not exist and nothing happens.
assert.ok(
  seats.has('main:remote-suite'),
  'the rail entry needs its paired main seat, or a click on the icon does nothing',
)
assert.equal(
  renderToString(React.createElement(seats.get('main:remote-suite'), {})),
  '',
  'the launcher must stay invisible; it only opens the floating workbench',
)

const rail = seats.get('sidebar.panellist:remote-suite')
assert.equal(typeof rail, 'function')
// The rail slot is icon-sized, so the entry has two shapes: an icon-sized
// terminal glyph (no room for text) and the full accent-dot capsule with the
// 远程 label when the host hands over a genuinely wide slot.
const railNarrow = renderToString(React.createElement(rail, { size: 16 }))
assert.match(railNarrow, /rs-rail-btn is-compact/, 'a narrow rail slot gets the compact icon form')
assert.match(railNarrow, /<svg/, 'the compact form draws an icon, not a bare dot')
assert.ok(!/rs-rail-txt/.test(railNarrow), 'the compact form must not try to fit the label')
const railWide = renderToString(React.createElement(rail, { size: 160 }))
assert.match(railWide, /rs-rail-dot/, 'the wide form keeps the capsule dot')
assert.match(railWide, /远程/, 'the wide form shows the 远程 label')

const workbench = seats.get('shell.overlay:remote-suite')
assert.equal(typeof workbench, 'function')
// Closed by default: the overlay renders nothing until it is opened.
assert.equal(renderToString(React.createElement(workbench, {})), '', 'the workbench renders nothing while closed')
// The host's add-workspace dialog is taken over through its flow slots; both
// registrations must be there and must render nothing while closed.
for (const seat of ['conversation.hero.workspace.directoryFlow:', 'sidebar.workspaces.directoryFlow:']) {
  const component = seats.get(seat)
  assert.ok(component, `the flow must register in ${seat}`)
  assert.equal(renderToString(React.createElement(component, { open: false })), '')
  const open = renderToString(React.createElement(component, { open: true, onPicked() {}, onCancel() {} }))
  assert.match(open, /本机/)
  assert.match(open, /WSL/)
  assert.match(open, /Docker/)
  assert.match(open, /远程 SSH/)
}
console.log('ok  add-workspace flow mounts')

// File operations must survive a host that predates the mkdir/rename/remove API:
// each one falls back to the equivalent shell command over `exec`. This is a
// source-level guard (the render path cannot reach those actions), so it stays
// honest about the fallback staying wired to the rights call sites and using
// per-platform quoting that a path with spaces or an apostrophe survives.
assert.match(source, /function fileOp\(method, payload, buildCommand\)/, 'fileOp fallback helper is present')
assert.match(source, /unknown api method: \*\(mkdir\|rename\|remove\)/, 'only the "old host" answer triggers the fallback')
for (const method of ['mkdir', 'rename', 'remove']) {
  assert.ok(
    source.includes(`await fileOp('${method}', {`),
    `${method} goes through fileOp so an older host still works`,
  )
}
assert.match(source, /mkdir -p -- \$\{posixQuote\(path\)\}/, 'posix mkdir fallback')
assert.match(source, /rm -rf -- \$\{posixQuote\(path\)\}/, 'posix remove fallback')
assert.match(source, /move \/Y \$\{cmdQuote\(fromPath\)\}/, 'windows rename fallback')
assert.match(source, /rmdir \/s \/q \$\{cmdQuote\(path\)\}/, 'windows remove fallback')
assert.match(source, /replace\(\/'\/g, "'\\\\''"\)/, 'posix quoting escapes apostrophes')
console.log('ok  file operations fall back to exec on an older host')

// The sidebar's own "workspace files" tab is taken over at the extension band,
// so the panel works for SSH and Docker workspaces, whose local mirror is empty.
assert.equal(tabTypes.length, 1, 'exactly one tab type is registered')
const filesTab = tabTypes[0]
assert.equal(filesTab.id, 'remote-suite/files')
assert.equal(filesTab.kind, 'files', 'the panel takes over the built-in files kind')
assert.equal(filesTab.priority, 'extension', 'an extension outranks the builtin type')
assert.equal(typeof filesTab.canOpen, 'function')
assert.equal(filesTab.canOpen('dsh-resource://file/session/s1/notes.txt'), true)
assert.equal(typeof filesTab.title(), 'string')
assert.ok(Array.isArray(filesTab.guide) && filesTab.guide.length === 1)
const filesBody = seats.get('sidebar.right.pane.tab:remote-suite/files')
assert.ok(filesBody, 'the tab needs a body component')
assert.match(
  renderToString(React.createElement(filesBody, { sessionId: 's1' })),
  /还没有工作区/,
  'without a session cwd the panel explains itself instead of throwing',
)
console.log('ok  sidebar files tab takes over the builtin type')
console.log('client smoke ok')
