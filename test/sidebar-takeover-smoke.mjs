// Right-sidebar takeover conflict smoke test.
//
// The host allows exactly one `extension` claim per tab kind: a second
// `sidebarRightTabs.register()` for `files` throws. better-sidebar claims the
// same kind, so when it is already in force we must bow out (one warning) and
// keep the rest of the plugin working instead of throwing during client load.
//
//     node test/sidebar-takeover-smoke.mjs
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

const tabTypes = []
const warnings = []
const seats = new Map()
const ctx = {
  get(name) {
    if (name === 'workspaces') return { create: async () => ({ workspaceId: 'w1' }) }
    return undefined
  },
  inject(deps, callback) {
    if (!deps.includes('sidebarRightTabs')) return undefined
    callback({
      slots: ctx.slots,
      sidebarRightTabs: {
        get(kind) {
          return kind === 'files' ? { id: 'dsh-better-sidebar:files', kind: 'files' } : undefined
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
console.warn = (...args) => warnings.push(args.join(' '))
try {
  module.apply(ctx)
} finally {
  console.warn = originalWarn
}

assert.equal(tabTypes.length, 0, 'a files kind already held by better-sidebar must stay theirs')
assert.equal(warnings.length, 1, 'bowing out must be reported once')
assert.match(warnings[0], /files .*占用|already/, 'the warning must name the takeover it skipped')
assert.ok(seats.has('main:remote-suite'), 'the rest of the plugin must still mount')
assert.ok(seats.has('shell.overlay:remote-suite'), 'the workbench must still mount')

console.log('sidebar takeover smoke ok')