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
const tabKinds = new Map()
const sidebarRightTabs = {
  register(definition) {
    tabTypes.push(definition)
    tabKinds.set(definition.kind, definition)
    return () => tabKinds.delete(definition.kind)
  },
  get(kind) {
    return tabKinds.get(kind)
  },
}
// The files pane follows the DSH interface language; tests start in Chinese and
// switch to English at the end to prove both copies render.
const localeState = { active: 'zh-CN' }
const ctx = {
  get(name) {
    if (name === 'workspaces') return { create: async () => ({ workspaceId: 'w1' }) }
    if (name === 'sidebarRightTabs') return sidebarRightTabs
    if (name === 'locale') {
      return { getSnapshot: () => ({ active: localeState.active }), subscribe: () => () => {} }
    }
    return undefined
  },
  inject(deps, callback) {
    if (!deps.includes('sidebarRightTabs')) return undefined
    callback({
      slots: ctx.slots,
      sidebarRightTabs,
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
module.apply(ctx)
// The panes are claimed synchronously: whoever registers an `extension` claim
// first wins the kind, so the HTTP read of the persisted switches only confirms
// or withdraws what was already claimed.
await new Promise((resolve) => setTimeout(resolve, 200))

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

// Two of the Host's panes are replaced, both at `extension` level so they win
// over the builtin ones, and both are switchable from the settings page. The
// file pane body is registered under the tab definition's key.
assert.equal(tabTypes.length, 2, 'the plugin must claim the files and the terminal kinds')
const filesTab = tabTypes.find((tab) => tab.kind === 'files')
const terminalTab = tabTypes.find((tab) => tab.kind === 'terminal')
assert.ok(filesTab !== undefined && terminalTab !== undefined, 'both kinds must be claimed')
assert.equal(filesTab.id, 'remote-suite/files')
assert.equal(filesTab.kind, 'files', 'the tab must replace the host pane, not add a second kind')
assert.equal(filesTab.priority, 'extension', 'an extension-level claim beats the builtin pane')
assert.equal(filesTab.keepMounted, true)
assert.equal(filesTab.title(), '文件')
assert.equal(filesTab.guide[0].description(), '浏览工作区文件树，点开即预览或编辑')
assert.equal(typeof filesTab.guide[0].icon, 'function')
const guideIcon = filesTab.guide[0].icon({ size: 16 })
assert.ok(guideIcon !== null && (typeof guideIcon.type === 'string' || typeof guideIcon.type === 'function'))
assert.equal(filesTab.guide.length, 1)
assert.equal(filesTab.guide[0].id, 'files')
assert.equal(filesTab.guide[0].commandId, undefined)
assert.ok(
  seats.has('sidebar.right.pane.tab:remote-suite/files'),
  'the files pane body must be registered under the tab key',
)
assert.equal(typeof seats.get('sidebar.right.pane.tab:remote-suite/files'), 'function')
const filesPane = renderToString(
  React.createElement(seats.get('sidebar.right.pane.tab:remote-suite/files'), { sessionId: 's1' }),
)
assert.ok(filesPane.includes('rs-sf'), 'the files pane must render its own shell')
assert.ok(filesPane.includes('刷新'), 'the files pane must offer the directory actions')

// The terminal pane replaces the Host's terminal the same way: one instance per
// session, kept mounted, claimed at extension level, with the start card's
// shortcut so the empty pane still offers Ctrl+`.
assert.equal(terminalTab.id, 'remote-suite/terminal')
assert.equal(terminalTab.priority, 'extension', 'the terminal claim must beat the builtin pane')
assert.equal(terminalTab.multiple, false, 'one terminal per session: the PTY is reused by cwd')
assert.equal(terminalTab.keepMounted, true)
assert.equal(terminalTab.title(), '终端')
assert.equal(terminalTab.guide[0].commandId, 'terminal.new', 'the start card keeps the Ctrl+` hint')
assert.ok(
  seats.has('sidebar.right.pane.tab:remote-suite/terminal'),
  'the terminal pane body must be registered under the tab key',
)
assert.equal(typeof seats.get('sidebar.right.pane.tab:remote-suite/terminal'), 'function')

// The switches themselves live in a settings section, so both panes can be
// handed back without uninstalling the plugin.
const settingsSection = seats.get('settings.section:remote-suite')
assert.equal(typeof settingsSection, 'function', 'the takeover switches must mount in settings')
const settingsHtml = renderToString(React.createElement(settingsSection, {}))
assert.ok(settingsHtml.includes('rs-set'), 'the section renders its own rows')
assert.ok(settingsHtml.includes('接管工作区文件') && settingsHtml.includes('接管终端'))
assert.ok(settingsHtml.includes('role="switch"'), 'each row is a real switch')
assert.ok(settingsHtml.includes('当前：本插件接管'), 'the section says who handles each pane')

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

// Navigation must survive the live-refresh machinery: a `{dir, ok:true}` frame is
// the answer to a `watch` request (repainting on it bounces the reader back to the
// root), and the periodic refresh must re-list the level in view, not re-root.
assert.match(source, /if \(frame\.ok !== undefined\) return/, 'watch acks must not repaint the tree')
assert.match(source, /if \(frame\.dir !== dirRef\.current\) return/, 'only the level in view is repainted')
assert.match(
  source,
  /loadRef\.current\(dirRef\.current \|\| undefined, true, true\)/,
  'the periodic refresh keeps the directory in view',
)
assert.match(
  source,
  /if \(quiet === true\) refreshOpenDirs\(\)\s*\n\s*else setKids\(\{\}\)/,
  'a background refresh keeps the open levels expanded',
)
assert.match(source, /loadRef\.current\(frame\.dir, true, true\)/, 'a watch push keeps the open levels expanded')
console.log('ok  live refresh keeps the directory in view')

// The pane is a takeover of the Host's own file pane, so it speaks the Host
// language: Chinese when the interface is Chinese, English otherwise. The copy
// table is keyed by the Chinese literal, so a missing entry degrades to the
// original text instead of a bare key.
localeState.active = 'en-US'
module.apply(ctx)
await new Promise((resolve) => setTimeout(resolve, 200))
assert.equal(filesTab.title(), 'Files', 'the tab title follows the interface language')
assert.equal(
  filesTab.guide[0].description(),
  'Browse the workspace files; open one to preview or edit it.',
  'the guide line follows the interface language',
)
const englishPane = renderToString(
  React.createElement(seats.get('sidebar.right.pane.tab:remote-suite/files'), { sessionId: 's1' }),
)
assert.ok(englishPane.includes('Refresh'), 'the English copy reaches the rendered pane')
assert.ok(!englishPane.includes('刷新'), 'no Chinese action labels leak into the English pane')
console.log('ok  files pane follows the interface language')

// The terminal pane was merged in from dsh-terminal, whose copy was Chinese-only.
// Its labels now go through the same table, so switching the interface language
// must reach the tab title, the guide line and the toolbar of the panel.
const terminalTabEn = tabTypes.find((tab) => tab.kind === 'terminal')
assert.equal(terminalTabEn.title(), 'Terminal', 'the terminal tab title follows the interface language')
assert.equal(terminalTabEn.guide[0].title(), 'New terminal')
assert.equal(terminalTabEn.guide[0].description(), 'Run commands in the session workspace')
console.log('ok  terminal tab follows the interface language')

// Guard against a future edit that drops a label back to a bare literal inside
// the merged terminal block: every one of these visible strings must be wrapped.
const translatedLiterals = [
  '终端',
  '新建终端',
  '连接中…',
  '已连接',
  '连接失败',
  '复制',
  '清屏',
  '重连',
  '关闭',
  '收起',
  '并排',
  '浮层',
  '暗色',
  '浅色',
  '复制/粘贴设置',
  '提示位置',
]
for (const literal of translatedLiterals) {
  // Only the merged terminal block must be bilingual: the workbench is
  // Chinese-only for now. The copy table is keyed by the Chinese literal, so it
  // is dropped before looking for a bare string that would never be translated.
  const blockFrom = source.indexOf('const remoteTerminal = (function')
  const blockTo = source.indexOf('// Takeover switches', blockFrom)
  const block = source.slice(blockFrom, blockTo)
  const tableFrom = block.indexOf('const EN_COPY = {')
  const tableTo = tableFrom < 0 ? -1 : block.indexOf('function tr(', tableFrom)
  const scoped = tableFrom < 0 ? block : block.slice(0, tableFrom) + block.slice(tableTo)
  const bare = new RegExp(`(?<!tr\\()["'\`]${literal}["'\`]`)
  assert.ok(!bare.test(scoped), `terminal copy "${literal}" must go through tr()`)
}
// The two option tables keep the Chinese source text (they are built once, at
// load time) and are translated where they are rendered.
for (const call of ['tr(opt.label)', 'tr(opt.title)', 'tr(pos.label)', 'tr(pos.title)']) {
  assert.ok(source.includes(call), `the terminal menus must translate at render time: ${call}`)
}
console.log('ok  terminal copy is translated')

// The terminal palette follows the Host's theme instead of a manual switch:
// DSH's own terminal is dark in a dark interface, so a stored light/dark
// preference would only make this pane disagree with everything around it.
assert.ok(!source.includes('dsh.terminal.theme'), 'the terminal must not remember a theme of its own')
assert.ok(
  source.includes('return hostIsDark() ? THEME_DARK_NAME : THEME_LIGHT_NAME;'),
  'the terminal theme must be read from the Host on every load',
)
assert.ok(source.includes('watchHostTheme('), 'the terminal must follow the Host when its theme changes')
for (const gone of ['themeButton', 'onTheme', 'toggleTheme']) {
  assert.ok(!source.includes(gone), `the manual theme switch must be removed: ${gone}`)
}
console.log('ok  terminal palette follows the host theme')

// Clearing must also drop the output that is still queued for xterm: a plain
// term.clear() only wipes the painted screen, and the queued bytes then paint
// the old lines back, which reads as "the content came back". It must also keep
// the prompt line, so the erase-sequence variant is not an option.
assert.match(source, /if \(Array\.isArray\(s\.pending\)\) s\.pending\.length = 0/, 'clear drops queued output')
assert.match(source, /term\.write\("", wipe\)/, 'clear waits for the write queue to drain, then wipes again')
assert.match(source, /const wipe = \(\) => \{[\s\S]{0,200}term\.clear\(\);/, 'the wipe keeps the prompt line via term.clear()')
assert.ok(!source.includes('\\x1b[3J'), 'clear must not wipe the prompt line with the erase sequence')

// The copy/paste settings must be a floating popover: an inline band pushes the
// terminal down, which makes React reflow the body on every open and close.
assert.match(source, /className: "dsh-term-menu-anchor"/, 'the copy menu floats above the terminal')
assert.match(source, /className: "dsh-term-chip"/, 'the clipboard switches render as chips')
assert.ok(!source.includes('dsh-term-menu-hint'), 'the explanatory line under the switches is gone')
console.log('client smoke ok')
