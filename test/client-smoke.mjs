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
assert.equal(loaded.id, 'dsh-remote-suite')

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
  if (id === '@deepseek-ai/dsh-client-ui-primitives') return kit
  throw new Error(`client asked for an unexpected module: ${id}`)
})

assert.equal(typeof module.apply, 'function')
assert.equal(module.inject.join(','), 'slots,workspaces')

const seats = new Map()
const ctx = {
  get(name) {
    if (name === 'workspaces') return { create: async () => ({ workspaceId: 'w1' }) }
    return undefined
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

assert.ok(!seats.has('sidebar.panellist:remote-suite'), 'the plugin must not add a second rail entry')
assert.ok(!seats.has('main:remote-suite'), 'the plugin must not take over the main seat')
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
console.log('client smoke ok')
