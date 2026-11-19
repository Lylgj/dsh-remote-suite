// dsh-remote-suite, browser half.
//
// A plain hand-written bundle, exactly like the ones DSH ships: no build step,
// no import/export keywords, no JSX. The page loads it as a script, the module
// loader hands it a `require`, and the only modules it may ask for are React
// and the client UI primitives declared in package.json's `dsh.client.inject`.
//
// What it contributes:
//   - a full-screen remote workbench (`shell.overlay`): target switcher, saved
//     workspaces, a file tree with create/rename/delete, editor tabs with line
//     numbers and highlighting, a real terminal and port forwarding, and
//   - the way into it: a "远程" entry in the left rail (`sidebar.panellist`),
//     drawn as the same accent-dot capsule the composer pill used to be, plus
//     the Ctrl/Cmd+` shortcut. The rail gives each plugin an icon-sized slot, so
//     the capsule is scaled down to a round button rather than a wide pill.
//
// Everything it shows comes from the host half's JSON API (`/remote-suite/api`),
// never from the filesystem directly, so the browser half has no idea whether a
// path lives on Windows, in a WSL distribution or behind SSH.
//
// Layout facts (verified against the plugins installed alongside this one):
//   - `shell.overlay` mounts a root-scoped overlay (dsh-terminal uses it for its
//     terminal panel); the component owns its own open/closed state.
//   - `sidebar.panellist` mounts one rail entry per plugin (dsh-stm32-toolkit and
//     dshmarket both use it); it must be claimed with inject(), never register()
//     directly, or the seat is not there yet.

window.__ModuleLoader__.load({
  id: '@lylgj/dsh-remote-suite',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    // react-dom is optional: it is used to portal the workbench onto <body>, so
    // a fixed overlay can escape the host frame's overflow:hidden. When the host
    // does not expose it (or the bundle is loaded outside a DOM), the overlay
    // simply renders in place — degraded, never broken.
    let ReactDOM = null
    try {
      ReactDOM = require('react-dom')
    } catch {
      ReactDOM = null
    }

    // Native UI kit: the add-workspace flow rides the host's own dialog so it
    // inherits the theme, typography, focus handling and Escape/backdrop close
    // behaviour instead of imitating them.
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const Modal = primitives.Modal
    const KitButton = primitives.Button
    const KitInput = primitives.Input
    const KitTabs = primitives.SegmentedControl

    const PANEL_ID = 'remote-suite'
    const API = 'remote-suite/api'
    const ASSET = 'remote-suite/assets'
    const PTY = 'remote-suite/pty'

    // Under the desktop shell the page is served from a custom scheme
    // (`dsh-app://app/`), so `location.host` is the literal string `app`: a
    // socket built from it can never complete a DNS lookup. HTTP has to ride the
    // page's own base (the shell forwards every non-static path to the Host
    // same-origin and the plugin routes send no CORS headers), while a WebSocket
    // has to use the Host origin the shell publishes in
    // `__DSH_TRANSPORT__.streamBaseUrl`. Both keep any reverse-proxy prefix.
    function pageBase() {
      if (typeof document !== 'undefined' && typeof document.baseURI === 'string' && document.baseURI !== '') {
        return document.baseURI
      }
      return typeof location !== 'undefined' ? location.href : 'http://dsh.invalid/'
    }

    // `http://host:62114` has no path, so slicing at the last `/` leaves a bare
    // `http://` — an invalid base URL that makes every `new URL(path, base)`
    // throw. Parse the value instead and keep the origin when there is no path.
    function directoryOf(value) {
      try {
        const url = new URL(value)
        if (!url.pathname.endsWith('/')) {
          const cut = url.pathname.lastIndexOf('/')
          url.pathname = cut >= 0 ? url.pathname.slice(0, cut + 1) : '/'
        }
        return url.href
      } catch {
        return value
      }
    }

    function hostUrl(path) {
      return new URL(path, directoryOf(pageBase())).href
    }

    function socketUrl(path) {
      const injected = globalThis.__DSH_TRANSPORT__ && globalThis.__DSH_TRANSPORT__.streamBaseUrl
      const base = typeof injected === 'string' && injected !== '' ? injected : pageBase()
      const url = new URL(path, directoryOf(base))
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      return url.href
    }

    // Whether the workbench can be portalled onto <body>. The host frame clips
    // its content (overflow:hidden), so a position:fixed overlay only covers the
    // whole window when it lives outside that frame.
    function canPortal() {
      return (
        ReactDOM !== null &&
        typeof ReactDOM.createPortal === 'function' &&
        typeof document !== 'undefined' &&
        document.body !== undefined &&
        document.body !== null
      )
    }

    // Whether the page the host rendered is dark. Reading it off the body beats
    // `prefers-color-scheme`: the host lets the reader pick a theme (or a custom
    // one) independently of the OS, and this workbench floats right on top of it.
    function hostIsDark() {
      if (typeof document === 'undefined' || document.body === null) return false
      try {
        const background = globalThis.getComputedStyle(document.body).backgroundColor
        const match = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(background)
        if (match === null) {
          return globalThis.matchMedia !== undefined && globalThis.matchMedia('(prefers-color-scheme: dark)').matches === true
        }
        const [r, g, b] = [Number(match[1]), Number(match[2]), Number(match[3])]
        return 0.299 * r + 0.587 * g + 0.114 * b < 128
      } catch {
        return false
      }
    }

    // xterm ships a dark palette by default, which turns the terminal into a
    // black slab inside an otherwise light workbench. Theme it off the host
    // instead: these two palettes are deliberately aligned with the ones the
    // host's own terminal plugin uses, so a light DSH gets a light terminal and
    // a dark DSH gets the same dark one users already recognise.
    const TERM_THEME_LIGHT = {
      background: '#ffffff',
      foreground: '#1f2328',
      cursor: '#1f2328',
      cursorAccent: '#ffffff',
      selectionBackground: '#b6d7ff',
      black: '#24292f',
      red: '#cf222e',
      green: '#116329',
      yellow: '#953800',
      blue: '#0969da',
      magenta: '#8250df',
      cyan: '#1b7c83',
      white: '#6e7781',
      brightBlack: '#57606a',
      brightRed: '#a40e26',
      brightGreen: '#1a7f37',
      brightYellow: '#9a6700',
      brightBlue: '#218bff',
      brightMagenta: '#a475f9',
      brightCyan: '#3192aa',
      brightWhite: '#8c959f',
    }

    const TERM_THEME_DARK = {
      background: '#1b1b25',
      foreground: '#cdd6f4',
      cursor: '#f5e0dc',
      cursorAccent: '#1b1b25',
      selectionBackground: '#585b70',
      black: '#45475a',
      red: '#f38ba8',
      green: '#a6e3a1',
      yellow: '#f9e2af',
      blue: '#89b4fa',
      magenta: '#f5c2e7',
      cyan: '#94e2d5',
      white: '#bac2de',
      brightBlack: '#585b70',
      brightRed: '#f38ba8',
      brightGreen: '#a6e3a1',
      brightYellow: '#f9e2af',
      brightBlue: '#89b4fa',
      brightMagenta: '#f5c2e7',
      brightCyan: '#94e2d5',
      brightWhite: '#a6adc8',
    }

    function terminalPalette(dark) {
      return dark ? TERM_THEME_DARK : TERM_THEME_LIGHT
    }

    // Re-read the host theme whenever it changes. The host flips a class/style on
    // <body> when the reader picks another theme, and `prefers-color-scheme` covers
    // the case where DSH follows the OS instead.
    function watchHostTheme(onChange) {
      if (typeof document === 'undefined' || document.body === null) return () => {}
      const update = () => {
        try {
          onChange(hostIsDark())
        } catch (error) {
          void error
        }
      }
      update()
      let observer = null
      try {
        if (typeof MutationObserver !== 'undefined') {
          observer = new MutationObserver(update)
          observer.observe(document.body, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] })
        }
      } catch (error) {
        observer = null
      }
      let media = null
      try {
        media = globalThis.matchMedia !== undefined ? globalThis.matchMedia('(prefers-color-scheme: dark)') : null
        if (media !== null && typeof media.addEventListener === 'function') media.addEventListener('change', update)
      } catch (error) {
        media = null
      }
      return () => {
        try {
          if (observer !== null) observer.disconnect()
        } catch (error) {
          void error
        }
        try {
          if (media !== null && typeof media.removeEventListener === 'function') media.removeEventListener('change', update)
        } catch (error) {
          void error
        }
      }
    }

    // xterm is a same-origin asset this plugin serves, exactly like the Host's
    // own terminal plugin does it: the bundle may not `require` it, so it is
    // loaded with a <script> tag and read off `window`.
    let assetsPromise = null
    function loadTerminalAssets() {
      if (assetsPromise !== null) return assetsPromise
      const script = (src) =>
        new Promise((resolve, reject) => {
          const el = document.createElement('script')
          el.src = src
          el.async = false
          const settle = () => {
            clearTimeout(timer)
            el.onload = null
            el.onerror = null
          }
          const timer = setTimeout(() => {
            settle()
            reject(new Error(`加载超时 ${src}`))
          }, 10000)
          el.onload = () => {
            settle()
            resolve(true)
          }
          el.onerror = () => {
            settle()
            reject(new Error(`无法加载 ${src}`))
          }
          document.head.appendChild(el)
        })
      assetsPromise = (async () => {
        const link = document.createElement('link')
        link.rel = 'stylesheet'
        link.href = hostUrl(`${ASSET}/xterm.css`)
        document.head.appendChild(link)
        await script(hostUrl(`${ASSET}/xterm.js`))
        await script(hostUrl(`${ASSET}/addon-fit.js`))
        if (window.Terminal === undefined) throw new Error('xterm 未初始化')
        return true
      })().catch((error) => {
        assetsPromise = null
        throw error
      })
      return assetsPromise
    }

    // ---------------------------------------------------------------------
    // Host API client
    // ---------------------------------------------------------------------

    async function call(method, payload) {
      const options = {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-remote-suite': '1' },
        body: JSON.stringify(payload || {}),
      }
      if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
        options.signal = AbortSignal.timeout(20000)
      }
      let response
      try {
        response = await fetch(hostUrl(`${API}/${method}`), options)
      } catch (error) {
        throw new Error(`无法连接宿主（${pageBase()}）：${error.message}`)
      }
      const text = await response.text()
      let body
      try {
        body = JSON.parse(text)
      } catch {
        throw new Error(text || `HTTP ${response.status}`)
      }
      if (body.ok !== true) throw new Error(body.error || 'remote-suite: request failed')
      return body.result
    }

    // ---------------------------------------------------------------------
    // Store: one shared object, because the composer pill, the overlay and the
    // add-workspace flow are separate mounts that must agree on one selection.
    // ---------------------------------------------------------------------

    let state = {
      ready: false,
      busy: false,
      error: null,
      targets: [],
      workspaces: [],
      target: null,
      root: null,
      dirs: {},
      expanded: {},
      tabs: [],
      active: -1,
      term: [],
      termBusy: false,
      open: false,
      pendingClose: null,
      selection: null,
    }

    const listeners = new Set()

    function setState(patch) {
      const next = typeof patch === 'function' ? patch(state) : patch
      state = { ...state, ...next }
      for (const listener of Array.from(listeners)) listener()
    }

    function useStore() {
      const [, tick] = React.useState(0)
      React.useEffect(() => {
        const listener = () => tick((n) => n + 1)
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      }, [])
      return state
    }

    function setError(error) {
      setState({ error: error === null ? null : error instanceof Error ? error.message : String(error) })
    }

    // The whole workbench lives in the shell overlay and owns its open state.
    // (The old `openDialog` wrote `addOpen`, which nothing ever read, so the
    // panel's "＋ 添加工作区" was a dead click. Both now drive real state.)
    function openWorkbench() {
      setState({ open: true })
    }

    function closeWorkbench() {
      setState({ open: false })
    }

    function toggleWorkbench() {
      setState((current) => ({ open: !current.open }))
    }

    // ---------------------------------------------------------------------
    // Actions
    // ---------------------------------------------------------------------

    async function loadDir(path) {
      const target = state.target
      if (target === null || path === null) return
      setState((current) => ({
        dirs: { ...current.dirs, [path]: { ...(current.dirs[path] || {}), loading: true, error: null } },
      }))
      try {
        const result = await call('tree', { target, path })
        setState((current) => ({
          dirs: { ...current.dirs, [path]: { loading: false, error: null, entries: result.entries } },
        }))
      } catch (error) {
        setState((current) => ({
          dirs: { ...current.dirs, [path]: { loading: false, error: String(error.message || error) } },
        }))
      }
    }

    async function refreshWorkspaces() {
      try {
        const workspaces = await call('workspaces')
        setState({ workspaces })
      } catch (error) {
        setError(error)
      }
    }

    async function selectTarget(id) {
      setState({ target: id, root: null, dirs: {}, expanded: {}, error: null })
      try {
        const result = await call('home', { target: id })
        const root = result.home || '/'
        setState({ root })
        await loadDir(root)
      } catch (error) {
        setError(error)
      }
    }

    async function initialize() {
      if (state.busy) return
      setState({ busy: true })
      try {
        const targets = await call('targets')
        setState({ targets })
        if (targets.length > 0 && state.target === null) {
          await selectTarget(targets[0].id)
        }
        await refreshWorkspaces()
        setState({ ready: true })
      } catch (error) {
        setError(error)
      } finally {
        setState({ busy: false })
      }
    }

    async function openWorkspace(workspace) {
      setState({ dirs: {}, expanded: {}, error: null })
      if (state.target !== workspace.targetId) {
        setState({ target: workspace.targetId })
      }
      setState({ root: workspace.path })
      await loadDir(workspace.path)
    }

    function toggleDir(path) {
      const expanded = state.expanded[path] === true
      setState((current) => ({ expanded: { ...current.expanded, [path]: !expanded } }))
      if (!expanded && state.dirs[path] === undefined) loadDir(path)
    }

    async function openForward(port) {
      if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        setError('端口需要是 1–65535 的整数')
        return
      }
      try {
        const result = await call('forward', { target: state.target, port })
        const key = `web|${result.id}`
        setState((current) => {
          const existing = current.tabs.findIndex((tab) => tab.key === key)
          if (existing >= 0) return { active: existing }
          return {
            tabs: [...current.tabs, { key, kind: 'web', url: result.url, forwardId: result.id, title: result.url }],
            active: current.tabs.length,
          }
        })
      } catch (error) {
        setError(error)
      }
    }

    async function openFile(path) {
      const key = `${state.target}|${path}`
      const existing = state.tabs.findIndex((tab) => tab.key === key)
      if (existing >= 0) {
        setState({ active: existing })
        return
      }
      try {
        const file = await call('read', { target: state.target, path })
        setState((current) => ({
          tabs: [...current.tabs, { key, target: state.target, path, text: file.text, saved: file.text }],
          active: current.tabs.length,
        }))
      } catch (error) {
        setError(error)
      }
    }

    function updateTab(index, patch) {
      setState((current) => ({
        tabs: current.tabs.map((tab, i) => (i === index ? { ...tab, ...patch } : tab)),
      }))
    }

    function closeTab(index, force) {
      const closing = state.tabs[index]
      if (closing === undefined) return
      // An unsaved buffer is not lost on a stray click: park the request and let
      // the editor area ask. `force` is the "discard" answer.
      if (force !== true && closing.kind !== 'web' && closing.text !== closing.saved) {
        setState({ pendingClose: index })
        return
      }
      if (closing.kind === 'web' && closing.forwardId !== undefined) {
        // Best effort: the tab is going away either way.
        call('forward-close', { forward: closing.forwardId }).catch(() => {})
      }
      setState((current) => {
        const tabs = current.tabs.filter((_, i) => i !== index)
        let active = current.active
        if (active === index) active = Math.min(index, tabs.length - 1)
        else if (active > index) active -= 1
        return { tabs, active, pendingClose: null }
      })
    }

    /** After save, apply the close that was waiting on the unsaved buffer. */
    async function saveThenClose(index) {
      await saveTab(index)
      if (state.tabs[index] !== undefined && state.tabs[index].text === state.tabs[index].saved) {
        closeTab(index, true)
      }
    }

    async function saveTab(index) {
      const tab = state.tabs[index]
      if (tab === undefined) return
      try {
        await call('write', { target: tab.target, path: tab.path, data: tab.text })
        updateTab(index, { saved: tab.text })
        setError(null)
      } catch (error) {
        setError(error)
      }
    }

    async function addWorkspace() {
      if (state.target === null || state.root === null) return
      try {
        await call('workspace-add', { target: state.target, path: state.root })
        await refreshWorkspaces()
        setError(null)
      } catch (error) {
        setError(error)
      }
    }

    async function removeWorkspace(id) {
      try {
        await call('workspace-remove', { workspace: id })
        await refreshWorkspaces()
      } catch (error) {
        setError(error)
      }
    }

    // ---------------------------------------------------------------------
    // File operations: create / rename / delete / refresh from the tree.
    // They all go through the same host API the tree uses, so they behave the
    // same on every target (the backend decides how to run them).
    // ---------------------------------------------------------------------

    // The file-op API (mkdir / rename / remove) was added to the host half after
    // the transport methods it builds on. A desktop build that is still running
    // an older host answers `unknown api method: mkdir`, so each op falls back
    // to the equivalent shell command over `exec` — every backend already has
    // exec, so create/rename/delete work on any host, connected or not.

    function isWindowsPath(value) {
      return /^[A-Za-z]:[\\/]/.test(value) || value.indexOf('\\') >= 0
    }

    function posixQuote(value) {
      return "'" + String(value).replace(/'/g, "'\\''") + "'"
    }

    function cmdQuote(value) {
      if (String(value).indexOf('"') >= 0) {
        throw new Error('路径里不能包含双引号，请改名后再试')
      }
      return '"' + value + '"'
    }

    async function fileOp(method, payload, buildCommand) {
      try {
        return await call(method, payload)
      } catch (error) {
        const message = String(error && error.message ? error.message : error)
        // Only the "this host is too old for the file-op API" answer is retried;
        // real failures (permission, missing file) must surface unchanged.
        if (!/unknown api method: *(mkdir|rename|remove)\b/.test(message)) throw error
        const command = buildCommand()
        const result = await call('exec', { target: payload.target, command })
        if (result.exitCode !== 0 || result.timedOut) {
          const detail = String(result.stderr || result.stdout || '').trim()
          throw new Error(detail || `命令失败（exit ${result.exitCode}）`)
        }
        return { viaExec: true }
      }
    }

    function parentOfPath(value) {
      if (typeof value !== 'string' || value === '') return value
      const cut = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'))
      if (cut <= 0) return value
      const head = value.slice(0, cut)
      return head === '' ? value.slice(0, 1) : head
    }

    /** Join a directory and a name with the separator the directory already uses. */
    function joinRemote(dir, name) {
      const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/'
      const trimmed = dir.replace(/[\\/]+$/, '')
      return trimmed === '' ? sep + name : trimmed + sep + name
    }

    async function refreshDir(dirPath) {
      if (dirPath === null || dirPath === undefined) return
      await loadDir(dirPath)
    }

    async function newFile(dirPath, name) {
      const path = joinRemote(dirPath, name)
      try {
        await call('write', { target: state.target, path, data: '' })
        await loadDir(dirPath)
        await openFile(path)
        setError(null)
      } catch (error) {
        setError(error)
        throw error
      }
    }

    async function newFolder(dirPath, name) {
      const path = joinRemote(dirPath, name)
      try {
        await fileOp('mkdir', { target: state.target, path }, () =>
          isWindowsPath(path) ? `mkdir ${cmdQuote(path)}` : `mkdir -p -- ${posixQuote(path)}`,
        )
        await loadDir(dirPath)
        setState((current) => ({ expanded: { ...current.expanded, [dirPath]: true } }))
        setError(null)
      } catch (error) {
        setError(error)
        throw error
      }
    }

    async function renameEntry(fromPath, nextName) {
      const toPath = joinRemote(parentOfPath(fromPath), nextName)
      if (toPath === fromPath) return
      try {
        await fileOp('rename', { target: state.target, from: fromPath, to: toPath }, () =>
          isWindowsPath(toPath)
            ? `if not exist ${cmdQuote(parentOfPath(toPath))} mkdir ${cmdQuote(parentOfPath(toPath))} & move /Y ${cmdQuote(fromPath)} ${cmdQuote(toPath)}`
            : `mkdir -p -- ${posixQuote(parentOfPath(toPath))} && mv -- ${posixQuote(fromPath)} ${posixQuote(toPath)}`,
        )
        setState((current) => ({
          tabs: current.tabs.map((tab) =>
            tab.path === fromPath ? { ...tab, path: toPath, key: `${state.target}|${toPath}` } : tab,
          ),
        }))
        await loadDir(parentOfPath(fromPath))
        setError(null)
      } catch (error) {
        setError(error)
        throw error
      }
    }

    async function deleteEntry(path) {
      try {
        await fileOp('remove', { target: state.target, path, recursive: true }, () =>
          isWindowsPath(path)
            ? `rmdir /s /q ${cmdQuote(path)} 2>nul || del /f /q ${cmdQuote(path)}`
            : `rm -rf -- ${posixQuote(path)}`,
        )
        setState((current) => ({
          tabs: current.tabs.filter((tab) => {
            const p = typeof tab.path === 'string' ? tab.path : ''
            return !(p === path || p.startsWith(path + '/') || p.startsWith(path + '\\'))
          }),
        }))
        await loadDir(parentOfPath(path))
        setError(null)
      } catch (error) {
        setError(error)
        throw error
      }
    }

    async function runCommand(command) {
      if (command.trim() === '' || state.termBusy) return
      const target = state.target
      const workdir = state.root || undefined
      setState((current) => ({
        term: [...current.term, { kind: 'cmd', text: command }],
        termBusy: true,
      }))
      try {
        const result = await call('exec', { target, command, workdir })
        const lines = []
        if (result.stdout) lines.push({ kind: 'out', text: result.stdout })
        if (result.stderr) lines.push({ kind: 'err', text: result.stderr })
        if (result.exitCode !== 0 || result.timedOut) {
          lines.push({ kind: 'err', text: `[exit ${result.exitCode}${result.timedOut ? ', timed out' : ''}]` })
        }
        setState((current) => ({ term: [...current.term, ...lines], termBusy: false }))
      } catch (error) {
        setState((current) => ({
          term: [...current.term, { kind: 'err', text: error.message || String(error) }],
          termBusy: false,
        }))
      }
    }

    // ---------------------------------------------------------------------
    // Styles (one <style> element, class based; the app's CSS variables keep it
    // in step with the active theme).
    // ---------------------------------------------------------------------

    const CSS = `
      .rs-root { display: flex; flex-direction: column; height: 100%; min-height: 0; font-size: 13px; }
      .rs-workspace { display: flex; flex: 1 1 auto; width: 100%; min-width: 0; height: 100%; min-height: 0; }
      .rs-side { width: 280px; min-width: 200px; max-width: 46%; border-right: 1px solid var(--dsh-border, rgba(127,127,127,0.25));
                 display: flex; flex-direction: column; min-height: 0; }
      .rs-row { display: flex; align-items: center; gap: 6px; padding: 0 10px; }
      .rs-title { font-weight: 600; padding: 10px 10px 4px; display: flex; align-items: center; justify-content: space-between; }
      .rs-btn { border: 1px solid var(--dsh-border, rgba(127,127,127,0.35)); background: transparent; color: inherit;
                border-radius: 5px; padding: 2px 8px; font-size: 12px; cursor: pointer; }
      .rs-btn:hover { background: var(--dsh-hover, rgba(127,127,127,0.12)); }
      .rs-btn:disabled { opacity: 0.45; cursor: default; }
      .rs-select, .rs-input { background: var(--dsh-input-bg, transparent); color: inherit; border: 1px solid var(--dsh-border, rgba(127,127,127,0.35));
                border-radius: 5px; padding: 3px 6px; font-size: 12px; min-width: 0; }
      .rs-input { flex: 1; font-family: var(--dsh-mono, ui-monospace, SFMono-Regular, Menlo, monospace); }
      .rs-tree { flex: 1; overflow: auto; padding: 4px 0 12px; min-height: 0; }
      .rs-node { display: flex; align-items: center; gap: 4px; padding: 1px 8px; cursor: pointer; white-space: nowrap;
                 user-select: none; border-radius: 4px; }
      .rs-node:hover { background: var(--dsh-hover, rgba(127,127,127,0.12)); }
      .rs-dim { opacity: 0.55; }
      .rs-err { color: var(--dsh-danger, #e5534b); padding: 2px 10px; font-size: 12px; word-break: break-word; }
      .rs-chips { display: flex; flex-wrap: wrap; gap: 4px; padding: 0 10px 6px; }
      .rs-chip { display: inline-flex; align-items: center; gap: 4px; border: 1px solid var(--dsh-border, rgba(127,127,127,0.35));
                 border-radius: 999px; padding: 1px 8px; font-size: 12px; cursor: pointer; }
      .rs-chip:hover { background: var(--dsh-hover, rgba(127,127,127,0.12)); }
      .rs-x { opacity: 0.5; }
      .rs-x:hover { opacity: 1; }
      /* flex: 1 1 auto matters: as a row child of .rs-app-body a non-growing
         .rs-main is sized by its content, so an editor with long lines looked
         fine while a lone terminal collapsed to its intrinsic ~220px width. */
      .rs-main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; height: 100%; min-height: 0; }
      .rs-tabs { display: flex; align-items: stretch; gap: 2px; border-bottom: 1px solid var(--dsh-border, rgba(127,127,127,0.25));
                 padding: 0 6px; overflow-x: auto; }
      .rs-tab { display: flex; align-items: center; gap: 6px; padding: 5px 10px; font-size: 12px; cursor: pointer;
                border-bottom: 2px solid transparent; white-space: nowrap; }
      .rs-tab.active { border-bottom-color: var(--dsh-accent, #4b8bf5); }
      .rs-tab .rs-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--dsh-accent, #4b8bf5); }
      .rs-body { flex: 1; min-height: 0; min-width: 0; display: flex; }
      .rs-web { flex: 1; min-height: 0; display: flex; flex-direction: column; }
      .rs-frame { flex: 1; min-height: 0; width: 100%; border: 0; background: #fff; }
      .rs-editor { flex: 1; display: flex; flex-direction: column; min-width: 0; }
      .rs-editor-bar { display: flex; align-items: center; gap: 8px; padding: 4px 10px; font-size: 12px; }
      .rs-editor textarea { flex: 1; resize: none; border: none; outline: none; padding: 8px 12px; background: transparent;
                color: inherit; font-family: var(--dsh-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 12.5px;
                line-height: 1.55; tab-size: 2; }
      .rs-term { flex: 1; display: flex; flex-direction: column; min-height: 0; }
      .rs-term-out { flex: 1; overflow: auto; padding: 8px 12px; font-family: var(--dsh-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
                font-size: 12.5px; line-height: 1.45; white-space: pre-wrap; word-break: break-word; }
      .rs-term-cmd { color: var(--dsh-accent, #4b8bf5); }
      .rs-term-err { color: var(--dsh-danger, #e5534b); }
      .rs-term-in { display: flex; gap: 6px; padding: 6px 10px; border-top: 1px solid var(--dsh-border, rgba(127,127,127,0.25)); }
      .rs-term-wrap { flex: 1 1 auto; display: flex; flex-direction: column; min-height: 0; min-width: 0; width: 100%; }
      .rs-term-bar { display: flex; align-items: center; gap: 8px; padding: 4px 10px; font-size: 12px;
                border-bottom: 1px solid var(--dsh-border, rgba(127,127,127,0.25)); }
      .rs-xterm { flex: 1 1 auto; min-height: 0; min-width: 0; width: 100%; padding: 4px 6px; box-sizing: border-box;
                background: var(--rs-term-bg, transparent); color: var(--rs-term-fg, inherit); }
      .rs-xterm .xterm { height: 100%; }
      .rs-xterm .xterm-viewport { background: var(--rs-term-bg, transparent) !important; }
      .rs-theme-light { --rs-term-bg: #ffffff; --rs-term-fg: #1f2328; }
      .rs-theme-dark { --rs-term-bg: #1b1b25; --rs-term-fg: #cdd6f4; }
      .rs-empty { padding: 24px; opacity: 0.6; font-size: 13px; }
      .rs-primary { border-color: var(--dsh-accent, #4b8bf5); color: var(--dsh-accent, #4b8bf5); }
      .rs-header-add { font-size: 14px; line-height: 1; }

      /* Add-workspace flow. The card, header, footer, buttons, inputs and the
         segmented control all come from the host UI kit, so only the layout and
         the directory list need rules here. Every neutral colour is derived from
         currentColor, which keeps the dialog correct in both themes. */
      .rs-flow { display: flex; flex-direction: column; gap: 10px; min-height: 0;
        height: min(430px, 58vh); }
      .rs-flow > * { flex: 0 0 auto; }
      .rs-flow > .rs-flow-list { flex: 1 1 auto; min-height: 0; }
      .rs-form-card { width: min(560px, 92vw); height: auto; }
      .rs-form-body { display: flex; flex-direction: column; gap: 10px; padding: 4px 14px 12px; overflow: auto; }
      .rs-form-body .rs-flow-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
      .rs-flow-row { --rs-btn: 88px; display: flex; align-items: center; gap: 8px; min-width: 0; }
      /* The target row (select + 新增 + 删除) and the path row (input + 上级 +
         主目录) line up only when the button columns are fixed, so both are
         grids of "1fr 88px 88px"; a row with no buttons spans all of it. */
      .rs-flow-row.is-grid { display: grid; grid-template-columns: minmax(0, 1fr) var(--rs-btn) var(--rs-btn); }
      .rs-flow-row.is-grid.is-solo { grid-template-columns: minmax(0, 1fr); }
      .rs-flow-row > input, .rs-flow-row > button, .rs-flow-row > .rs-select-wrap,
      .rs-flow input, .rs-flow select { height: 34px; box-sizing: border-box; font: inherit; }
      .rs-flow input, .rs-flow select { padding: 0 10px; }
      .rs-flow-row > input { padding: 0 14px; }
      /* Pill fields: the path input and the target select read as one family, and
         both borders are declared here instead of inherited, because a control
         that inherits its border loses it to the host's focus ring when clicked. */
      .rs-flow-row > input { border: 1px solid color-mix(in srgb, currentColor 18%, transparent);
        border-radius: 999px; background: transparent; color: inherit; }
      .rs-flow-row > input:focus-visible {
        outline: 2px solid color-mix(in srgb, currentColor 30%, transparent); outline-offset: 0; }
      /* A native select draws its arrow a few pixels from the edge and will not
         move it, so the box is a wrapper and the chevron is ours: it can sit
         further in, and the pill keeps its border while the dropdown is open. */
      .rs-flow-row > .rs-select-wrap { position: relative; display: flex; align-items: center;
        min-width: 0; border: 1px solid color-mix(in srgb, currentColor 18%, transparent);
        border-radius: 999px; background: transparent; color: inherit; }
      .rs-flow-row > .rs-select-wrap > select { appearance: none; -webkit-appearance: none;
        flex: 1; min-width: 0; height: 100%; padding: 0 36px 0 14px; border: 0; border-radius: inherit;
        background: transparent; color: inherit; font: inherit; line-height: normal; cursor: pointer; }
      .rs-flow-row > .rs-select-wrap > select:focus { outline: none; }
      .rs-flow-row > .rs-select-wrap:focus-within {
        outline: 2px solid color-mix(in srgb, currentColor 30%, transparent); outline-offset: 0; }
      .rs-select-caret { position: absolute; right: 16px; top: 50%; transform: translateY(-50%);
        display: flex; align-items: center; pointer-events: none; opacity: 0.6; }
      .rs-flow-row > button { padding: 0 12px; min-width: var(--rs-btn); }
      .rs-flow-row > :first-child { min-width: 0; }
      .rs-flow-row:not(.is-grid) > :first-child { flex: 1; }
      /* The local category has no target to choose, so it shows its drives in that
         same slot: same 34px height, same pill, so the dialog does not jump. */
      .rs-drives { display: flex; flex-wrap: wrap; gap: 8px; min-width: 0; }
      .rs-drive { height: 34px; min-width: 64px; padding: 0 16px; box-sizing: border-box;
        border: 1px solid color-mix(in srgb, currentColor 18%, transparent); border-radius: 999px;
        background: transparent; color: inherit; font: inherit; cursor: pointer; }
      .rs-drive:hover { background: color-mix(in srgb, currentColor 8%, transparent); }
      .rs-drive.is-active { background: color-mix(in srgb, currentColor 14%, transparent);
        border-color: color-mix(in srgb, currentColor 36%, transparent); }
      .rs-flow-form { display: flex; flex-direction: column; gap: 8px; padding: 10px;
                border: 1px solid color-mix(in srgb, currentColor 16%, transparent); border-radius: 8px;
                background: color-mix(in srgb, currentColor 3%, transparent); }
      .rs-flow-field { display: flex; flex-direction: column; gap: 4px; }
      .rs-flow-label { font-size: 12px; color: color-mix(in srgb, currentColor 78%, transparent); }
      .rs-flow input { color: inherit; }
      .rs-flow input::placeholder { color: color-mix(in srgb, currentColor 42%, transparent); }
      .rs-flow-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
      .rs-flow-form-actions { display: flex; justify-content: flex-end; gap: 6px; }
      .rs-flow-actions { display: flex; justify-content: center; gap: 10px; padding: 6px 0 2px; margin-top: auto; }
      .rs-picker-backdrop { position: fixed; inset: 0; z-index: 1000; display: flex; align-items: center;
        justify-content: center; padding: 24px; background: rgba(0, 0, 0, 0.38); }
      .rs-picker-card { width: min(560px, 92vw); height: min(560px, 84vh); max-height: min(560px, 84vh);
        display: flex; flex-direction: column; overflow: hidden; border-radius: 12px;
        border: 1px solid color-mix(in srgb, currentColor 14%, transparent);
        background: var(--dsh-surface, #ffffff); color: inherit; box-shadow: 0 18px 48px rgba(0, 0, 0, 0.28); }
      /* Dialogs that size to their content (forms, the host list) opt out, so a
         long name never gets a scrollbar in a box that had room for it. */
      .rs-picker-card.rs-form-card { height: auto; }
      .rs-picker-drives { display: flex; flex-wrap: wrap; gap: 4px; padding: 2px 0; }
      .rs-picker-drive { border: 1px solid color-mix(in srgb, currentColor 18%, transparent);
        background: transparent; color: inherit; font: inherit; font-size: 12px; padding: 2px 8px;
        border-radius: 6px; cursor: pointer; }
      .rs-picker-drive:hover { background: color-mix(in srgb, currentColor 10%, transparent); }
      .rs-picker-drive.is-active { background: color-mix(in srgb, currentColor 16%, transparent); }
      .rs-picker-head { display: flex; flex-direction: column; gap: 6px; padding: 12px 14px;
        border-bottom: 1px solid color-mix(in srgb, currentColor 10%, transparent); }
      .rs-picker-title { font-size: 13px; font-weight: 600; }
      .rs-picker-dir { font-size: 11px; opacity: 0.62; overflow: hidden;
        text-overflow: ellipsis; white-space: nowrap; }
      .rs-picker-list { flex: 1; min-height: 260px; max-height: 380px; overflow: auto; padding: 4px; }
      /* Inside a fixed-height card the list takes the leftover space instead of
         stopping at 380px, so the file picker keeps one size from the first
         listing to the next (a short ~/.ssh used to make it grow when a drive
         with many folders was opened). */
      .rs-picker-card > .rs-picker-list { flex: 1 1 auto; min-height: 0; max-height: none; }
      .rs-picker-foot { display: flex; justify-content: flex-end; gap: 8px; padding: 8px 12px;
        border-top: 1px solid color-mix(in srgb, currentColor 10%, transparent); }
      .rs-picker-foot.is-center { justify-content: center; }
      .rs-picker-foot > button, .rs-picker-head input { height: 34px; box-sizing: border-box; font: inherit; }
      .rs-flow-hint { padding: 2px 8px 6px; font-size: 12px; opacity: 0.66;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .rs-flow-list { overflow: auto; padding: 4px;
                border: 1px solid color-mix(in srgb, currentColor 12%, transparent); border-radius: 8px; }
      .rs-flow-item { display: flex; align-items: center; gap: 8px; width: 100%; padding: 5px 8px; border: 0;
                background: transparent; color: inherit; border-radius: 6px; cursor: pointer; font-size: 13px;
                text-align: left; }
      .rs-flow-item:hover, .rs-flow-item:focus-visible {
                background: color-mix(in srgb, currentColor 8%, transparent); outline: none; }
      .rs-flow-item-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .rs-flow-item-chevron { opacity: 0.4; }
      .rs-flow-empty { padding: 18px 8px; text-align: center; font-size: 12px;
                color: color-mix(in srgb, currentColor 55%, transparent); }
      .rs-flow-error { font-size: 12px; color: var(--dsh-danger, #e5534b); word-break: break-word; }
      .rs-profile-list { display: flex; flex-direction: column; gap: 6px; max-height: 46vh; overflow: auto; }
      .rs-profile-row { display: flex; align-items: center; gap: 8px; padding: 6px 8px;
                border: 1px solid color-mix(in srgb, currentColor 14%, transparent); border-radius: 8px; }
      .rs-profile-main { flex: 1; min-width: 0; display: flex; align-items: baseline; gap: 8px; }
      .rs-profile-alias { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .rs-profile-addr { font-size: 12px; opacity: 0.65; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .rs-profile-tag { font-size: 11px; padding: 1px 6px; border-radius: 999px;
                background: color-mix(in srgb, currentColor 10%, transparent); white-space: nowrap; }
      .rs-profile-note { font-size: 12px; opacity: 0.55; white-space: nowrap; }
      .rs-modal-workspace { width: min(720px, 94vw) !important; max-width: min(720px, 94vw) !important; }

      /* =================================================================
         Workbench v2 — full-screen overlay + a cleaner three-pane shell.
         Everything below refines the older rules above (equal specificity,
         later wins) and adds the classes the v2 components render.
         ================================================================= */

      /* The overlay: a dimmed backdrop with one large card, the way a
         command-palette surface sits on top of the app without replacing it. */
      .rs-overlay-backdrop {
        position: fixed; inset: 0; z-index: 900;
        display: flex; align-items: center; justify-content: center;
        padding: 26px 30px;
        background: color-mix(in srgb, #06080f 40%, transparent);
        backdrop-filter: blur(6px) saturate(115%);
        animation: rs-fade 120ms ease-out;
      }
      @keyframes rs-fade { from { opacity: 0 } to { opacity: 1 } }
      .rs-overlay-card {
        flex: 0 1 auto; width: 100%; max-width: 1320px;
        height: 100%; max-height: 100%;
        min-width: 0; min-height: 0;
        display: flex; flex-direction: column; overflow: hidden;
        border-radius: 16px;
        border: 1px solid var(--dsh-border, rgba(127,127,127,0.26));
        background: var(--dsh-surface, #fff);
        color: inherit;
        box-shadow: 0 32px 80px rgba(0, 0, 0, 0.34), 0 2px 8px rgba(0, 0, 0, 0.12);
        animation: rs-rise 150ms cubic-bezier(0.2, 0.9, 0.3, 1);
      }
      @keyframes rs-rise { from { opacity: 0; transform: translateY(8px) scale(0.995) } to { opacity: 1; transform: none } }
      .rs-app-head {
        display: flex; align-items: center; gap: 10px;
        height: 46px; padding: 0 14px;
        border-bottom: 1px solid var(--dsh-border, rgba(127,127,127,0.18));
        background:
          linear-gradient(to bottom,
            color-mix(in srgb, var(--dsh-accent, #4b8bf5) 7%, transparent),
            transparent);
      }
      .rs-app-brand { display: flex; align-items: center; gap: 9px; font-weight: 650; font-size: 13.5px; letter-spacing: 0.01em; }
      .rs-app-brand .rs-logo {
        display: inline-flex; align-items: center; justify-content: center;
        width: 24px; height: 24px; border-radius: 7px;
        background: linear-gradient(145deg,
          color-mix(in srgb, var(--dsh-accent, #4b8bf5) 26%, transparent),
          color-mix(in srgb, var(--dsh-accent, #4b8bf5) 12%, transparent));
        color: var(--dsh-accent, #4b8bf5);
        box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--dsh-accent, #4b8bf5) 22%, transparent);
      }
      .rs-app-spacer { flex: 1 1 auto; }
      .rs-kbd {
        font-family: var(--dsh-mono, ui-monospace, monospace); font-size: 11px;
        padding: 2px 7px; border-radius: 6px;
        border: 1px solid var(--dsh-border, rgba(127,127,127,0.3));
        background: color-mix(in srgb, currentColor 4%, transparent);
        opacity: 0.75;
      }
      .rs-icon-btn {
        display: inline-flex; align-items: center; justify-content: center;
        width: 28px; height: 28px; border: 0; border-radius: 7px;
        background: transparent; color: inherit; cursor: pointer; font-size: 15px; line-height: 1;
        transition: background 100ms ease;
      }
      .rs-icon-btn:hover { background: var(--dsh-hover, rgba(127,127,127,0.14)); }
      .rs-icon-btn:active { background: color-mix(in srgb, currentColor 16%, transparent); }
      .rs-app-body { flex: 1 1 auto; min-height: 0; display: flex; overflow: hidden; }

      /* Left rail: grouped sections instead of one long pile of inputs. */
      .rs-side {
        width: 300px; min-width: 220px; max-width: 42%;
        border-right: 1px solid var(--dsh-border, rgba(127,127,127,0.16));
        display: flex; flex-direction: column; min-height: 0;
        background: color-mix(in srgb, currentColor 2.5%, transparent);
      }
      .rs-side-sec { padding: 12px 14px 8px; display: flex; flex-direction: column; gap: 8px; }
      .rs-side-sec + .rs-side-sec { border-top: 1px solid var(--dsh-border, rgba(127,127,127,0.13)); }
      .rs-sec-head { display: flex; align-items: center; gap: 6px; }
      .rs-sec-label {
        flex: 1 1 auto; font-size: 10.5px; font-weight: 650; letter-spacing: 0.06em;
        text-transform: uppercase; opacity: 0.55;
      }
      .rs-field {
        display: flex; align-items: center; gap: 6px;
        border: 1px solid var(--dsh-border, rgba(127,127,127,0.26));
        border-radius: 9px; padding: 0 9px; height: 32px;
        background: color-mix(in srgb, currentColor 3.5%, transparent);
        transition: border-color 110ms ease, box-shadow 110ms ease;
      }
      .rs-field:hover { border-color: color-mix(in srgb, currentColor 30%, transparent); }
      .rs-field:focus-within {
        border-color: var(--dsh-accent, #4b8bf5);
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsh-accent, #4b8bf5) 16%, transparent);
      }
      .rs-field input, .rs-field select {
        flex: 1 1 auto; min-width: 0; border: 0; outline: 0; background: transparent;
        color: inherit; font: inherit; font-size: 12px; height: 100%;
      }
      .rs-field select { cursor: pointer; }
      .rs-field .rs-field-icon { opacity: 0.55; display: flex; }
      .rs-chip-x { opacity: 0.5; cursor: pointer; }
      .rs-chip-x:hover { opacity: 1; }
      .rs-sec-scroll { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
      .rs-tree-head {
        display: flex; align-items: center; gap: 4px; padding: 8px 8px 4px 12px;
      }
      .rs-tree-head .rs-sec-label { padding-left: 0; }

      /* File tree: real icon glyphs, hover/selected states, indent guides. */
      .rs-tree { flex: 1 1 auto; overflow: auto; padding: 2px 6px 14px; min-height: 0; }
      .rs-node {
        display: flex; align-items: center; gap: 6px;
        padding: 3px 8px; margin: 1px 0; cursor: pointer; white-space: nowrap;
        user-select: none; border-radius: 6px; font-size: 12.5px;
      }
      .rs-node:hover { background: var(--dsh-hover, rgba(127,127,127,0.12)); }
      .rs-node.is-active { background: color-mix(in srgb, var(--dsh-accent, #4b8bf5) 16%, transparent); }
      .rs-node .rs-node-ico { display: inline-flex; width: 15px; justify-content: center; opacity: 0.85; }
      .rs-node .rs-node-nm { overflow: hidden; text-overflow: ellipsis; }
      .rs-node .rs-node-caret { width: 12px; opacity: 0.6; text-align: center; }
      .rs-node-menu {
        margin-left: auto; opacity: 0; border: 0; background: transparent; color: inherit;
        cursor: pointer; font-size: 13px; padding: 0 2px; border-radius: 4px;
      }
      .rs-node:hover .rs-node-menu { opacity: 0.55; }
      .rs-node-menu:hover { opacity: 1 !important; background: var(--dsh-hover, rgba(127,127,127,0.16)); }

      /* Right-click / actions menu */
      .rs-menu-anchor { position: fixed; z-index: 1100; min-width: 168px;
        border: 1px solid var(--dsh-border, rgba(127,127,127,0.3)); border-radius: 10px;
        background: var(--dsh-surface, #fff); color: inherit;
        box-shadow: 0 12px 32px rgba(0,0,0,0.28); padding: 4px; }
      .rs-menu-item { display: flex; align-items: center; gap: 8px; width: 100%;
        padding: 6px 10px; border: 0; background: transparent; color: inherit;
        font: inherit; font-size: 12.5px; text-align: left; border-radius: 6px; cursor: pointer; }
      .rs-menu-item:hover { background: var(--dsh-hover, rgba(127,127,127,0.14)); }
      .rs-menu-item.is-danger { color: var(--dsh-danger, #e5534b); }
      .rs-menu-sep { height: 1px; margin: 4px 6px; background: var(--dsh-border, rgba(127,127,127,0.2)); }

      /* Tabs: a little more air, a files icon and a close target that appears
         on hover/active instead of always-on. */
      .rs-tabs {
        display: flex; align-items: stretch; gap: 3px;
        border-bottom: 1px solid var(--dsh-border, rgba(127,127,127,0.18));
        background: color-mix(in srgb, currentColor 2%, transparent);
        padding: 6px 8px 0; overflow-x: auto;
      }
      .rs-tab {
        display: flex; align-items: center; gap: 6px; padding: 7px 12px;
        font-size: 12px; cursor: pointer; white-space: nowrap;
        border: 1px solid transparent; border-bottom: 0;
        border-radius: 9px 9px 0 0; color: inherit;
        transition: background 100ms ease;
      }
      .rs-tab:hover { background: var(--dsh-hover, rgba(127,127,127,0.1)); }
      .rs-tab.active {
        background: var(--dsh-surface, #fff);
        border-color: var(--dsh-border, rgba(127,127,127,0.2));
        box-shadow: inset 0 2px 0 var(--dsh-accent, #4b8bf5);
      }
      .rs-tab .rs-tab-x {
        opacity: 0; font-size: 14px; line-height: 1; border-radius: 4px; padding: 0 3px;
      }
      .rs-tab:hover .rs-tab-x, .rs-tab.active .rs-tab-x { opacity: 0.6; }
      .rs-tab .rs-tab-x:hover { opacity: 1; background: var(--dsh-hover, rgba(127,127,127,0.18)); }

      /* Editor v2: gutter + highlighted overlay behind a transparent textarea.
         All four layers share the exact same font metrics and padding so the
         caret in the textarea lines up with the painted glyphs behind it. */
      .rs-editor { flex: 1 1 auto; display: flex; flex-direction: column; min-width: 0; min-height: 0; background: var(--dsh-surface, #fff); }
      .rs-editor-bar {
        display: flex; align-items: center; gap: 8px; padding: 5px 12px; font-size: 12px;
        border-bottom: 1px solid var(--dsh-border, rgba(127,127,127,0.16));
      }
      .rs-editor-bar .rs-ed-path { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; font-family: var(--dsh-mono, monospace); opacity: 0.9; }
      .rs-editor-status { display: flex; align-items: center; gap: 10px; padding: 3px 12px; font-size: 11px;
        border-top: 1px solid var(--dsh-border, rgba(127,127,127,0.16)); opacity: 0.72;
        font-family: var(--dsh-mono, monospace); }
      .rs-code-wrap { position: relative; flex: 1 1 auto; min-height: 0; display: flex; overflow: hidden; }
      .rs-gutter {
        flex: 0 0 auto; overflow: hidden; padding: 10px 8px 10px 12px; text-align: right;
        font-family: var(--dsh-mono, monospace); font-size: 12.5px; line-height: 1.55;
        color: color-mix(in srgb, currentColor 42%, transparent);
        background: color-mix(in srgb, currentColor 2.5%, transparent);
        border-right: 1px solid var(--dsh-border, rgba(127,127,127,0.14));
        user-select: none; white-space: pre;
      }
      .rs-code-scroll { position: relative; flex: 1 1 auto; min-width: 0; overflow: hidden; }
      .rs-code-hl, .rs-code-ta {
        position: absolute; inset: 0; margin: 0; border: 0; box-sizing: border-box;
        font-family: var(--dsh-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
        font-size: 12.5px; line-height: 1.55; tab-size: 2; white-space: pre;
        padding: 10px 14px; overflow: auto;
      }
      .rs-code-hl { pointer-events: none; color: inherit; z-index: 1; overflow: hidden; }
      /* Two classes deep on purpose: the older .rs-editor textarea rule sets
         color: inherit, and at one class this layer would be overridden — the
         real characters would then paint on top of the coloured ones. */
      .rs-editor .rs-code-ta {
        z-index: 2; background: transparent; color: transparent; caret-color: var(--dsh-fg, currentColor);
        resize: none; outline: none;
      }
      .rs-code-ta::selection { background: color-mix(in srgb, var(--dsh-accent, #4b8bf5) 32%, transparent); }
      /* Token colours. Two palettes: the dark page needs the Dark+ hues, the
         light page needs darker ones or half the code turns into a highlighter. */
      .rs-theme-light {
        --rs-tok-com: #3f7f3f; --rs-tok-str: #a31515; --rs-tok-num: #098658;
        --rs-tok-kw: #0000c0; --rs-tok-fn: #795e26;
      }
      .rs-theme-dark {
        --rs-tok-com: #6a9955; --rs-tok-str: #ce9178; --rs-tok-num: #b5cea8;
        --rs-tok-kw: #569cd6; --rs-tok-fn: #dcdcaa;
      }
      .tok-com { color: var(--rs-tok-com, #3f7f3f); font-style: italic; }
      .tok-str { color: var(--rs-tok-str, #a31515); }
      .tok-num { color: var(--rs-tok-num, #098658); }
      .tok-kw  { color: var(--rs-tok-kw, #0000c0); }
      .tok-fn  { color: var(--rs-tok-fn, #795e26); }
      .tok-punc{ color: color-mix(in srgb, currentColor 62%, transparent); }

      /* Rail entry (sidebar.panellist). The rail hands each plugin an
         icon-sized slot (dsh-im and dsh-stm32-toolkit both draw a 16px svg),
         so the capsule has two shapes: compact = accent-tinted icon square
         that matches the other rail icons, wide = the original accent-dot
         capsule with the 远程 label. */
      .rs-rail-btn {
        display: inline-flex; align-items: center; justify-content: center; gap: 5px;
        height: 26px; padding: 0 8px; border-radius: 999px; cursor: pointer;
        border: 1px solid var(--dsh-border, rgba(127,127,127,0.34));
        background: transparent; color: inherit; max-width: 100%; overflow: hidden;
        transition: background 110ms ease, border-color 110ms ease;
      }
      .rs-rail-btn.is-compact {
        padding: 0; border-radius: 7px; flex: 0 0 auto;
        color: var(--dsh-accent, #4b8bf5);
        border-color: color-mix(in srgb, var(--dsh-accent, #4b8bf5) 32%, transparent);
        background: color-mix(in srgb, var(--dsh-accent, #4b8bf5) 10%, transparent);
      }
      .rs-rail-btn:hover {
        background: var(--dsh-hover, rgba(127,127,127,0.13));
        border-color: color-mix(in srgb, var(--dsh-accent, #4b8bf5) 55%, transparent);
      }
      .rs-rail-btn .rs-rail-dot {
        flex: 0 0 auto;
        width: 9px; height: 9px; border-radius: 50%;
        background: var(--dsh-accent, #4b8bf5);
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsh-accent, #4b8bf5) 18%, transparent);
      }
      .rs-rail-txt { font-size: 11px; font-weight: 600; white-space: nowrap; }

      /* The right sidebar's files tab. It replaces the host's own "工作区文件"
         pane for every workspace, so it has to feel like a native list: a bar
         with breadcrumbs and the few actions, then rows or an editor. */
      .rs-sf { display: flex; flex-direction: column; width: 100%; height: 100%; min-height: 0; font-size: 12px; }
      .rs-sf-bar {
        display: flex; align-items: center; gap: 6px; flex: 0 0 auto;
        padding: 7px 10px; border-bottom: 1px solid color-mix(in srgb, currentColor 12%, transparent);
      }
      .rs-sf-crumbs {
        flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        font-size: 11px; opacity: 0.72;
      }
      .rs-sf-btn {
        flex: 0 0 auto; height: 24px; padding: 0 9px; border-radius: 6px; cursor: pointer;
        border: 1px solid color-mix(in srgb, currentColor 20%, transparent);
        background: transparent; color: inherit; font-size: 11px; white-space: nowrap;
      }
      .rs-sf-btn:hover { background: var(--dsh-hover, rgba(127,127,127,0.13)); }
      .rs-sf-btn:disabled { opacity: 0.45; cursor: default; }
      .rs-sf-list { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 4px 6px 10px; }
      .rs-sf-row {
        display: flex; align-items: center; gap: 8px; height: 28px; padding: 0 8px;
        border-radius: 6px; cursor: pointer; user-select: none;
      }
      .rs-sf-row:hover { background: var(--dsh-hover, rgba(127,127,127,0.12)); }
      .rs-sf-row.is-on { background: color-mix(in srgb, var(--dsh-accent, #4b8bf5) 16%, transparent); }
      .rs-sf-icon { flex: 0 0 auto; width: 15px; height: 15px; display: flex; align-items: center; justify-content: center; }
      .rs-sf-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .rs-sf-name.is-hidden { opacity: 0.62; }
      .rs-sf-caret {
        flex: 0 0 auto; width: 22px; height: 22px; margin-left: -5px; margin-right: -3px;
        display: flex; align-items: center; justify-content: center;
        border-radius: 6px; cursor: pointer; opacity: 0.72;
      }
      .rs-sf-caret svg { transition: transform 0.14s ease; }
      .rs-sf-caret.is-open svg { transform: rotate(90deg); }
      .rs-sf-caret:hover { opacity: 1; background: color-mix(in srgb, currentColor 12%, transparent); }
      .rs-sf-caret.is-leaf { visibility: hidden; cursor: default; }
      .rs-sf-at {
        flex: 0 0 auto; border: 0; background: transparent; color: inherit; font: inherit; font-size: 11px;
        line-height: 1; padding: 3px 6px; border-radius: 6px; cursor: pointer; opacity: 0;
        transition: opacity 0.12s ease;
      }
      .rs-sf-row:hover .rs-sf-at { opacity: 0.75; }
      .rs-sf-at:hover { opacity: 1; background: color-mix(in srgb, currentColor 12%, transparent); }
      .rs-sf-notice { flex: 0 0 auto; padding: 6px 12px; font-size: 11px; opacity: 0.72; }
      .rs-sf-codewrap .rs-code-ta {
        z-index: 2; background: transparent; color: transparent;
        caret-color: var(--dsh-fg, currentColor); resize: none;
      }
      .rs-sf-meta { flex: 0 0 auto; font-size: 11px; opacity: 0.5; }
      .rs-sf-editor { flex: 1 1 auto; display: flex; flex-direction: column; min-height: 0; }
      .rs-sf-text {
        flex: 1 1 auto; min-height: 0; width: 100%; resize: none; border: 0; outline: none;
        padding: 10px 12px; background: transparent; color: inherit;
        font: 12px/1.55 ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
        tab-size: 2;
      }
      .rs-sf-image { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 10px; text-align: center; }
      .rs-sf-image img { max-width: 100%; border-radius: 8px; }
      .rs-sf-err { flex: 0 0 auto; padding: 7px 12px; color: #e11d48; font-size: 11px; }
      .rs-sf-empty { padding: 26px 14px; text-align: center; opacity: 0.6; line-height: 1.7; }
      .rs-sf-input {
        flex: 1 1 auto; min-width: 0; height: 24px; padding: 0 8px; border-radius: 6px;
        border: 1px solid color-mix(in srgb, currentColor 20%, transparent);
        background: transparent; color: inherit; font-size: 12px; outline: none;
      }
      .rs-sf-input:focus { border-color: color-mix(in srgb, var(--dsh-accent, #4b8bf5) 62%, transparent); }
.rs-sf-row.is-sel { background: color-mix(in srgb, var(--dsh-accent, #4b8bf5) 20%, transparent); }
.rs-sf-status { padding: 4px 10px; border-top: 1px solid color-mix(in srgb, currentColor 10%, transparent); }
.rs-sf-find {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-bottom: 1px solid color-mix(in srgb, currentColor 10%, transparent);
}
.rs-sf-find .rs-sf-input { flex: 1 1 auto; }
.rs-sf-codewrap { flex: 1 1 auto; min-height: 0; }
.rs-sf-codewrap .rs-code-ta, .rs-sf-codewrap .rs-code-hl { font-size: 12px; line-height: 1.55; }
.rs-sf-drop {
  position: absolute;
  inset: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 2px dashed color-mix(in srgb, var(--dsh-accent, #4b8bf5) 55%, transparent);
  border-radius: 12px;
  background: color-mix(in srgb, var(--dsh-accent, #4b8bf5) 10%, transparent);
  font-size: 12px;
  pointer-events: none;
}
.rs-sf { position: relative; }
.rs-sf-menu {
  position: fixed;
  z-index: 1300;
  min-width: 156px;
  padding: 5px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  background: var(--dsh-surface, #ffffff);
  color: var(--dsh-text, #1f2328);
  border: 1px solid color-mix(in srgb, currentColor 16%, transparent);
  border-radius: 10px;
  box-shadow: 0 12px 32px rgba(15, 23, 42, 0.18);
}
.rs-sf-menuitem {
  text-align: left;
  padding: 6px 10px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.rs-sf-menuitem:hover { background: var(--dsh-hover, rgba(127,127,127,0.13)); }
.rs-sf-menuitem.is-danger { color: #e11d48; }

/* Settings section: takeover switches. */
.rs-set { display: flex; flex-direction: column; gap: 12px; padding: 4px 2px 10px; max-width: 720px; }
.rs-set-row { display: flex; align-items: center; gap: 14px; padding: 14px 16px; border-radius: 14px;
  border: 1px solid color-mix(in srgb, currentColor 9%, transparent);
  background: linear-gradient(180deg, color-mix(in srgb, currentColor 3.5%, transparent),
    color-mix(in srgb, currentColor 1.5%, transparent));
  transition: border-color 0.16s ease, box-shadow 0.16s ease; }
.rs-set-row:hover { border-color: color-mix(in srgb, currentColor 18%, transparent);
  box-shadow: 0 2px 10px rgba(2, 6, 23, 0.06); }
.rs-set-glyph { flex: 0 0 auto; width: 34px; height: 34px; border-radius: 10px;
  display: flex; align-items: center; justify-content: center; color: var(--dsh-accent, #6366f1);
  background: color-mix(in srgb, var(--dsh-accent, #6366f1) 12%, transparent); }
.rs-set-main { display: flex; flex-direction: column; gap: 4px; min-width: 0; flex: 1 1 auto; }
.rs-set-title { font-size: 13.5px; font-weight: 600; letter-spacing: 0.1px; }
.rs-set-hint { font-size: 12px; line-height: 1.5; opacity: 0.6; }
.rs-set-state { display: inline-flex; align-items: center; gap: 6px; margin-top: 2px; width: fit-content;
  font-size: 11.5px; padding: 2px 9px 2px 7px; border-radius: 999px; opacity: 0.85;
  background: color-mix(in srgb, currentColor 6%, transparent); }
.rs-set-state::before { content: ''; width: 6px; height: 6px; border-radius: 50%;
  background: currentColor; opacity: 0.5; }
.rs-set-state.is-on { color: var(--dsh-success, #2fb344); opacity: 1;
  background: color-mix(in srgb, #2fb344 13%, transparent); }
.rs-set-state.is-on::before { opacity: 1;
  box-shadow: 0 0 0 3px color-mix(in srgb, #2fb344 18%, transparent); }
.rs-set-switch { flex: 0 0 auto; width: 44px; height: 24px; padding: 0; border: 0; border-radius: 999px;
  background: color-mix(in srgb, currentColor 20%, transparent); position: relative; cursor: pointer;
  transition: background 0.18s ease; }
.rs-set-switch.is-on { background: var(--dsh-accent, #6366f1); }
.rs-set-switch:focus-visible { outline: 2px solid color-mix(in srgb, var(--dsh-accent, #6366f1) 55%, transparent);
  outline-offset: 2px; }
.rs-set-knob { position: absolute; top: 3px; left: 3px; width: 18px; height: 18px; border-radius: 50%;
  background: #fff; box-shadow: 0 1px 3px rgba(2, 6, 23, 0.28); transition: transform 0.18s ease; }
.rs-set-switch.is-on .rs-set-knob { transform: translateX(20px); }
.rs-set-foot { margin: 0; font-size: 11.5px; opacity: 0.55; }
    `

    /**
     * The stylesheet must exist before the first surface renders. The flow slots
     * render even when the (optional) panel is not registered, so the styles are
     * installed from apply() as well as from the panel's mount effect.
     */
    function ensureStyle() {
      if (typeof document === 'undefined') return
      if (document.getElementById('rs-style') !== null) return
      const style = document.createElement('style')
      style.id = 'rs-style'
      style.textContent = CSS
      document.head.appendChild(style)
    }

    function useStyle() {
      React.useEffect(() => {
        ensureStyle()
      }, [])
    }

    // ---------------------------------------------------------------------
    // Sidebar panel: target switcher, workspaces, file tree
    // ---------------------------------------------------------------------

    // ---------------------------------------------------------------------
    // Icons: a handful of tiny inline SVGs so the tree, tabs and toolbar read
    // as one icon family instead of a row of text glyphs.
    // ---------------------------------------------------------------------

    function Glyph({ name, size }) {
      const s = size === undefined ? 14 : size
      const common = { width: s, height: s, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }
      const d = {
        folder: 'M1.5 3.2h4l1.3 1.6h7.7v8H1.5z',
        file: 'M3.5 1.8h5.2l3.3 3.3v9.1h-8.5zM8.7 1.9v3.3h3.3',
        chevron: 'M6 3.5 10.5 8 6 12.5',
        refresh: 'M13.2 8a5.2 5.2 0 1 1-1.6-3.7M13.4 2.2v3.2h-3.2',
        plus: 'M8 2.6v10.8M2.6 8h10.8',
        close: 'M4 4l8 8M12 4l-8 8',
        more: 'M3.2 8h.01M8 8h.01M12.8 8h.01',
        search: 'M10.8 10.8 14 14M11.6 6.9a4.7 4.7 0 1 1-9.4 0 4.7 4.7 0 0 1 9.4 0z',
        trash: 'M3.2 4.4h9.6M6.4 4.4V3h3.2v1.4M4.4 4.4l.7 9.1h5.8l.7-9.1',
        edit: 'M10.9 2.6 13.4 5.1 5.6 12.9l-3.2.7.7-3.2z',
        terminal: 'M3 4.2 6 8l-3 3.8M8.2 12h4.4',
        plug: 'M5.6 2v3.2M10.4 2v3.2M3.8 5.2h8.4v2.4a4.2 4.2 0 0 1-8.4 0zM8 11.8V14',
        server: 'M2.4 3h11.2v4H2.4zM2.4 9h11.2v4H2.4zM4.4 5h.01M4.4 11h.01',
      }[name]
      return h('svg', common, h('path', { d, strokeWidth: name === 'more' ? 2.4 : undefined }))
    }

    // ---------------------------------------------------------------------
    // File tree node: a caret, an icon, the name, and a "⋯" that opens the
    // same actions menu as a right click.
    // ---------------------------------------------------------------------

    function TreeNode({ entry, depth, onMenu }) {
      const store = useStore()
      const expanded = store.expanded[entry.path] === true
      const node = store.dirs[entry.path]
      const isDir = entry.type === 'dir'
      const active = store.selection !== null && store.selection === entry.path

      const onActivate = () => {
        setState({ selection: entry.path })
        if (isDir) toggleDir(entry.path)
        else openFile(entry.path)
      }

      const openMenu = (event) => {
        if (typeof onMenu !== 'function') return
        event.preventDefault()
        event.stopPropagation()
        setState({ selection: entry.path })
        onMenu({ x: event.clientX, y: event.clientY, path: entry.path, type: entry.type, name: entry.name })
      }

      const children = []
      children.push(
        h(
          'div',
          {
            key: 'row',
            className: active ? 'rs-node is-active' : 'rs-node',
            style: { paddingLeft: `${6 + depth * 12}px` },
            onClick: onActivate,
            onContextMenu: openMenu,
            title: entry.path,
          },
          h(
            'span',
            { className: 'rs-node-caret' },
            isDir ? h('span', { style: { display: 'inline-flex', transform: expanded ? 'rotate(90deg)' : 'none' } }, h(Glyph, { name: 'chevron', size: 11 })) : null,
          ),
          h('span', { className: 'rs-node-ico' }, h(Glyph, { name: isDir ? 'folder' : 'file', size: 13 })),
          h('span', { className: 'rs-node-nm' }, entry.name),
          h('button', { className: 'rs-node-menu', title: '更多操作', onClick: openMenu }, h(Glyph, { name: 'more', size: 13 })),
        ),
      )
      if (isDir && expanded) {
        if (node === undefined || node.loading === true) {
          children.push(h('div', { key: 'loading', className: 'rs-dim', style: { paddingLeft: `${28 + depth * 12}px` } }, '加载中…'))
        } else if (node.error) {
          children.push(h('div', { key: 'error', className: 'rs-err', style: { paddingLeft: `${28 + depth * 12}px` } }, node.error))
        } else {
          for (const child of node.entries) {
            children.push(h(TreeNode, { key: child.path, entry: child, depth: depth + 1, onMenu }))
          }
          if (node.entries.length === 0) {
            children.push(h('div', { key: 'empty', className: 'rs-dim', style: { paddingLeft: `${28 + depth * 12}px` } }, '（空目录）'))
          }
        }
      }
      return h(React.Fragment, null, children)
    }

    // A tiny promise-shaped text prompt used for "new file / new folder /
    // rename". It replaces the browser prompt(), which the desktop shell blocks.
    function PromptDialog({ title, label, initial, confirmLabel, onCancel, onSubmit }) {
      const [text, setText] = React.useState(initial === undefined ? '' : initial)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)
      const inputRef = React.useRef(null)

      React.useEffect(() => {
        const node = inputRef.current
        if (node !== null && node !== undefined) {
          node.focus()
          node.select()
        }
      }, [])

      const submit = async () => {
        const value = text.trim()
        if (value === '') {
          setError('名字不能为空')
          return
        }
        setBusy(true)
        setError(null)
        try {
          await onSubmit(value)
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause))
          setBusy(false)
        }
      }

      return h(
        'div',
        { className: 'rs-overlay-backdrop', style: { zIndex: 1200, alignItems: 'center', justifyContent: 'center' } },
        h(
          'div',
          {
            className: 'rs-menu-anchor',
            style: { position: 'static', minWidth: '320px', padding: '14px', display: 'flex', flexDirection: 'column', gap: '10px' },
            onClick: (event) => event.stopPropagation(),
          },
          h('div', { style: { fontSize: '13px', fontWeight: 600 } }, title),
          h('div', { className: 'rs-field' }, h('input', {
            ref: inputRef,
            value: text,
            spellCheck: false,
            placeholder: label,
            onChange: (event) => setText(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') submit()
              if (event.key === 'Escape') onCancel()
            },
          })),
          error !== null ? h('div', { className: 'rs-err' }, error) : null,
          h(
            'div',
            { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px' } },
            h('button', { className: 'rs-btn', onClick: onCancel, disabled: busy }, '取消'),
            h('button', { className: 'rs-btn rs-primary', onClick: submit, disabled: busy }, confirmLabel || '确定'),
          ),
        ),
      )
    }

    function MenuList({ x, y, items, onClose }) {
      React.useEffect(() => {
        const close = () => onClose()
        const onKey = (event) => {
          if (event.key === 'Escape') onClose()
        }
        const timer = setTimeout(() => {
          globalThis.addEventListener('click', close, true)
          globalThis.addEventListener('keydown', onKey, true)
        }, 0)
        return () => {
          clearTimeout(timer)
          globalThis.removeEventListener('click', close, true)
          globalThis.removeEventListener('keydown', onKey, true)
        }
      }, [])

      const rows = []
      items.forEach((item, index) => {
        if (item === null) {
          rows.push(h('div', { key: `sep-${index}`, className: 'rs-menu-sep' }))
          return
        }
        rows.push(
          h(
            'button',
            {
              key: `${item.label}-${index}`,
              className: item.danger === true ? 'rs-menu-item is-danger' : 'rs-menu-item',
              onClick: (event) => {
                event.stopPropagation()
                onClose()
                item.onSelect()
              },
            },
            item.icon === undefined ? null : h(Glyph, { name: item.icon, size: 13 }),
            item.label,
          ),
        )
      })

      return h(
        'div',
        {
          className: 'rs-menu-anchor',
          style: { left: `${x}px`, top: `${y}px` },
          onClick: (event) => event.stopPropagation(),
        },
        rows,
      )
    }

    function Panel() {
      useStyle()
      const store = useStore()
      const [rootText, setRootText] = React.useState('')
      const [portText, setPortText] = React.useState('')
      const [menu, setMenu] = React.useState(null)
      const [prompt, setPrompt] = React.useState(null)
      const booted = React.useRef(false)

      React.useEffect(() => {
        if (booted.current) return
        booted.current = true
        if (!store.ready) initialize()
      }, [])

      React.useEffect(() => {
        if (typeof store.root === 'string') setRootText(store.root)
      }, [store.root])

      const rootNode = store.root === null ? undefined : store.dirs[store.root]
      const tree = []
      if (store.root !== null) {
        if (rootNode === undefined || rootNode.loading === true) {
          tree.push(h('div', { key: 'loading', className: 'rs-dim', style: { padding: '4px 10px' } }, '加载中…'))
        } else if (rootNode.error) {
          tree.push(h('div', { key: 'error', className: 'rs-err', style: { paddingLeft: '12px' } }, rootNode.error))
        } else {
          for (const entry of rootNode.entries) {
            tree.push(h(TreeNode, { key: entry.path, entry, depth: 0, onMenu: setMenu }))
          }
          if (rootNode.entries.length === 0) {
            tree.push(h('div', { key: 'empty', className: 'rs-dim', style: { padding: '4px 12px' } }, '这个目录是空的'))
          }
        }
      }

      const changeTarget = async (id) => {
        await selectTarget(id)
      }

      const goTo = async () => {
        const next = rootText.trim()
        if (next === '') return
        setState({ root: next, expanded: {}, selection: null })
        await loadDir(next)
      }

      // Port forwarding only exists for SSH / daemon targets; the other kinds
      // report it at the API level, so the control is hidden rather than left
      // to fail on click.
      const canForward = store.target !== null && (store.target.startsWith('ssh:') || store.target.startsWith('daemon:'))

      const askNewFile = (dirPath) => {
        setPrompt({
          title: '新建文件',
          label: '文件名，如 index.js',
          initial: '',
          confirmLabel: '创建',
          onSubmit: async (name) => {
            await newFile(dirPath, name)
            setPrompt(null)
          },
        })
      }
      const askNewFolder = (dirPath) => {
        setPrompt({
          title: '新建文件夹',
          label: '文件夹名',
          initial: '',
          confirmLabel: '创建',
          onSubmit: async (name) => {
            await newFolder(dirPath, name)
            setPrompt(null)
          },
        })
      }
      const askRename = (path, current) => {
        setPrompt({
          title: '重命名',
          label: '新名字',
          initial: current,
          confirmLabel: '重命名',
          onSubmit: async (name) => {
            await renameEntry(path, name)
            setPrompt(null)
          },
        })
      }
      const askDelete = (path) => {
        setPrompt({
          title: '确认删除',
          label: `输入 DELETE 以删除 ${path}`,
          initial: '',
          confirmLabel: '删除',
          onSubmit: async (value) => {
            if (value !== 'DELETE') throw new Error('请输入 DELETE 以确认删除')
            await deleteEntry(path)
            setPrompt(null)
          },
        })
      }

      const menuItems = menu === null ? [] : (() => {
        const targetDir = menu.type === 'dir' ? menu.path : parentOfPath(menu.path)
        const items = [
          { label: '新建文件', icon: 'file', onSelect: () => askNewFile(targetDir) },
          { label: '新建文件夹', icon: 'folder', onSelect: () => askNewFolder(targetDir) },
          null,
          { label: '刷新', icon: 'refresh', onSelect: () => loadDir(targetDir) },
        ]
        if (menu.path !== store.root) {
          items.push(null, { label: '重命名', icon: 'edit', onSelect: () => askRename(menu.path, menu.name) })
          items.push({ label: '删除', icon: 'trash', danger: true, onSelect: () => askDelete(menu.path) })
        }
        return items
      })()

      const sections = []

      // Target + workspaces
      sections.push(
        h(
          'div',
          { key: 'target', className: 'rs-side-sec' },
          h('div', { className: 'rs-sec-head' },
            h('span', { className: 'rs-sec-label' }, '目标'),
            h('button', { className: 'rs-icon-btn', title: '刷新目标与目录', onClick: () => initialize() }, h(Glyph, { name: 'refresh', size: 13 })),
          ),
          h('div', { className: 'rs-field' },
            h('span', { className: 'rs-field-icon' }, h(Glyph, { name: 'server', size: 13 })),
            h(
              'select',
              { value: store.target === null ? '' : store.target, onChange: (event) => changeTarget(event.target.value) },
              store.targets.map((target) => h('option', { key: target.id, value: target.id }, target.label || target.id)),
            ),
          ),
          store.workspaces.length > 0
            ? h('div', { className: 'rs-chips', style: { marginTop: '2px' } },
                store.workspaces.map((workspace) =>
                  h('span', { key: workspace.id, className: 'rs-chip', onClick: () => openWorkspace(workspace), title: `${workspace.targetId}:${workspace.path}` },
                    workspace.name,
                    h('span', { className: 'rs-chip-x', onClick: (event) => { event.stopPropagation(); removeWorkspace(workspace.id) } }, '×'),
                  ),
                ),
              )
            : null,
        ),
      )

      // Path
      sections.push(
        h(
          'div',
          { key: 'path', className: 'rs-side-sec' },
          h('div', { className: 'rs-sec-head' }, h('span', { className: 'rs-sec-label' }, '路径')),
          h('div', { className: 'rs-field' },
            h('span', { className: 'rs-field-icon' }, h(Glyph, { name: 'folder', size: 13 })),
            h('input', {
              value: rootText,
              spellCheck: false,
              placeholder: '远端目录，如 /root/i',
              onChange: (event) => setRootText(event.target.value),
              onKeyDown: (event) => { if (event.key === 'Enter') goTo() },
            }),
          ),
        ),
      )

      // File tree (grows)
      sections.push(
        h(
          'div',
          { key: 'tree', className: 'rs-sec-scroll' },
          h('div', { className: 'rs-tree-head' },
            h('span', { className: 'rs-sec-label' }, '文件'),
            h('button', { className: 'rs-icon-btn', title: '新建文件', disabled: store.root === null, onClick: () => askNewFile(store.root) }, h(Glyph, { name: 'file', size: 13 })),
            h('button', { className: 'rs-icon-btn', title: '新建文件夹', disabled: store.root === null, onClick: () => askNewFolder(store.root) }, h(Glyph, { name: 'folder', size: 13 })),
            h('button', { className: 'rs-icon-btn', title: '刷新', disabled: store.root === null, onClick: () => loadDir(store.root) }, h(Glyph, { name: 'refresh', size: 13 })),
          ),
          h('div', { className: 'rs-tree' }, tree),
          store.error !== null ? h('div', { className: 'rs-err', style: { padding: '4px 12px' } }, store.error) : null,
        ),
      )

      // Port forwarding (SSH / daemon only)
      if (canForward) {
        sections.push(
          h(
            'div',
            { key: 'forward', className: 'rs-side-sec' },
            h('div', { className: 'rs-sec-head' }, h('span', { className: 'rs-sec-label' }, '端口转发')),
            h('div', { className: 'rs-field' },
              h('span', { className: 'rs-field-icon' }, h(Glyph, { name: 'plug', size: 13 })),
              h('input', {
                value: portText,
                spellCheck: false,
                placeholder: '远端端口，如 3000',
                onChange: (event) => setPortText(event.target.value),
                onKeyDown: (event) => { if (event.key === 'Enter') openForward(Number.parseInt(portText.trim(), 10)) },
              }),
              h('button', { className: 'rs-btn', onClick: () => openForward(Number.parseInt(portText.trim(), 10)) }, '转发'),
            ),
          ),
        )
      }

      // Footer: save the current target+directory as a workspace chip, or
      // re-scan targets. Host-native "add workspace" is still available from
      // the shipped sidebar button (this plugin overrides its flow).
      sections.push(
        h(
          'div',
          { key: 'footer', className: 'rs-side-sec', style: { flexDirection: 'row', gap: '6px', paddingBottom: '10px' } },
          h('button', { className: 'rs-btn rs-primary', style: { flex: 1 }, onClick: addWorkspace, disabled: store.root === null }, '存为工作区'),
          h('button', { className: 'rs-btn', onClick: () => initialize() }, '刷新'),
        ),
      )

      return h(
        'div',
        { className: 'rs-root', style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 } },
        sections,
        menu === null ? null : h(MenuList, { x: menu.x, y: menu.y, items: menuItems, onClose: () => setMenu(null) }),
        prompt === null ? null : h(PromptDialog, {
          title: prompt.title,
          label: prompt.label,
          initial: prompt.initial,
          confirmLabel: prompt.confirmLabel,
          onCancel: () => setPrompt(null),
          onSubmit: prompt.onSubmit,
        }),
      )
    }

    // ---------------------------------------------------------------------
    // "Add workspace": local / WSL / Docker / SSH, each landing on a real DSH
    // workspace. WSL directories are reachable through their 9p UNC path;
    // SSH and Docker directories are not, so those workspaces open on a local
    // mirror directory and the remote path stays in this plugin's state.
    // ---------------------------------------------------------------------

    const workspaceServices = { workspaces: null, uiWorkspace: null, sessions: null }

    // The host layout service is only needed by the rail launcher, which has to
    // hand the main area back after it opens the floating workbench.
    const layoutServices = { layout: null }

    async function startSessionFor(workspaceId) {
      const ui = workspaceServices.uiWorkspace
      if (ui !== null && typeof ui.startSession === 'function') return ui.startSession(workspaceId)
      const service = workspaceServices.workspaces
      if (service !== null && typeof service.startSession === 'function') return service.startSession(workspaceId)
      return undefined
    }

    const ADD_TABS = [
      { id: 'local', label: '本机' },
      { id: 'wsl', label: 'WSL' },
      { id: 'docker', label: 'Docker' },
      { id: 'ssh', label: '远程 SSH' },
    ]

    function formatHost(profile) {
      const user = profile.user === undefined || profile.user === '' ? '' : `${profile.user}@`
      const port = profile.port === undefined || profile.port === null ? '' : `:${profile.port}`
      return `${user}${profile.hostname}${port}`
    }

    /**
     * The "＋ 添加工作区" dialog, mounted in the shell overlay so it also works
     * while the remote panel is closed. It also owns the injected header
     * button next to the shipped "add workspace" control.
     */
    function AddWorkspaceFlow(input) {
      const props = input === undefined || input === null ? {} : input
      const store = useStore()
      const open = props.open === true
      const [tab, setTab] = React.useState('local')
      const [choice, setChoice] = React.useState('')
      const [path, setPath] = React.useState('')
      const [entries, setEntries] = React.useState(null)
      const [browseError, setBrowseError] = React.useState(null)
      const [profiles, setProfiles] = React.useState([])
      const [targets, setTargets] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)
      const [form, setForm] = React.useState(null)
      // Problems with the new-host form itself are reported next to the field
      // they belong to; `error` stays for the whole dialog (target, path, API).
      const [formError, setFormError] = React.useState(null)
      const [filePick, setFilePick] = React.useState(null)
      const [pickInput, setPickInput] = React.useState('')
      // The manage dialog lists every known host so the delete target is chosen
      // by name rather than by whatever the select happens to be showing.
      const [manage, setManage] = React.useState(false)
      const [roots, setRoots] = React.useState([])
      // This component is the plugin's only visible surface now, so it pulls the
      // target list itself instead of relying on the (unmounted) panel.
      React.useEffect(() => {
        if (!open) return undefined
        let alive = true
        call('targets')
          .then((list) => {
            if (alive) setTargets(Array.isArray(list) ? list : [])
          })
          .catch((e) => {
            if (alive) setError(String(e.message || e))
          })
        // The local category chooses a drive where the others choose a target.
        call('roots')
          .then((list) => {
            if (alive) setRoots(Array.isArray(list) ? list : [])
          })
          .catch(() => {})
        call('ssh-profiles')
          .then((list) => {
            if (alive) setProfiles(Array.isArray(list) ? list : [])
          })
          .catch(() => {})
        return () => {
          alive = false
        }
      }, [open])

      const loadedTargets = targets ?? []
      const targetsOf = (kind) => loadedTargets.filter((target) => target.kind === kind)

      // Nothing is preselected. Opening the dialog or switching category shows
      // the placeholder, so creating a workspace is always an explicit act:
      // pick a distribution/host first, then a directory.
      const candidates =
        tab === 'wsl'
          ? targetsOf('wsl').map((target) => ({ value: target.id, label: target.label || target.id }))
          : tab === 'docker'
            ? targetsOf('docker').map((target) => ({ value: target.id, label: target.label || target.id }))
            : tab === 'ssh'
              ? profiles.map((profile) => ({
                  value: profile.alias,
                  label: `${profile.alias} · ${formatHost(profile)}`,
                }))
              : []

      const choiceValue = candidates.some((item) => item.value === choice) ? choice : ''

      // An empty list means something different per category; say what.
      const emptyLabel =
        tab === 'ssh'
          ? '（还没有 SSH 主机，点右侧「＋ 新增」）'
          : tab === 'docker'
            ? '（本机没有运行中的容器）'
            : '（没有可用的 WSL 发行版）'

      const resolveTarget = () => {
        if (tab === 'local') return 'local'
        if (tab === 'ssh') return choiceValue === '' ? '' : `ssh:${choiceValue}`
        return choiceValue
      }

      const browse = async (dir) => {
        const target = resolveTarget()
        if (target === '') return
        try {
          setBrowseError(null)
          const result = await call('tree', { target, path: dir })
          setPath(dir)
          setEntries(result.entries.filter((entry) => entry.type === 'dir'))
        } catch (e) {
          setBrowseError(String(e.message || e))
        }
      }

      const goHome = async () => {
        const target = resolveTarget()
        if (target === '') return
        try {
          setBrowseError(null)
          const result = await call('home', { target })
          await browse(result.home || '/')
        } catch (e) {
          setBrowseError(String(e.message || e))
        }
      }

      const pickTab = (next) => {
        setTab(next)
        setChoice('')
        setForm(null)
        setEntries(null)
        setPath('')
        setError(null)
      }

      const pickChoice = (value) => {
        setChoice(value)
        setEntries(null)
        setPath('')
      }

      // A target from another category (or one that disappeared) is not a
      // choice: clear it so the picker shows the placeholder and the list stays
      // empty until the user picks something.
      React.useEffect(() => {
        if (!open) return
        if (choice !== '' && !candidates.some((item) => item.value === choice)) setChoice('')
      }, [open, tab, choiceValue])

      // Any tab or target change starts at that target's home directory.
      React.useEffect(() => {
        if (!open) return
        if (resolveTarget() === '') {
          setEntries(null)
          setPath('')
          return
        }
        void goHome()
      }, [open, tab, choiceValue])

      // `C:\` and `C:/` and `C:` are the same drive; compare them that way so the
      // active chip stays lit whichever form the API handed back.
      const sameRoot = (a, b) => {
        const normal = (value) => String(value || '').replace(/[\\/]+$/, '').toLowerCase()
        return normal(a) !== '' && normal(a) === normal(b)
      }

      const parentOf = (value) => {
        if (value === '' || value === '/' || /^[A-Za-z]:[\\/]$/.test(value)) return value
        const cut = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'))
        if (cut <= 0) return value
        return value.slice(0, cut) || '/'
      }

      // Same rule as `profileAlias` in lib/api.js, checked before the round trip
      // so the message lands under the field the user has to fix. Chinese names
      // are fine; spaces, colons and slashes are not, because the alias becomes
      // part of the target id (`ssh:<alias>`).
      const ALIAS_RE = /^[\p{L}\p{N}._-]{1,64}$/u
      const aliasProblem = (value) => {
        const alias = value.trim()
        if (alias === '') return '请填写别名'
        if (!ALIAS_RE.test(alias)) return '别名只能用字母（中文也可以）、数字、点、横线、下划线，1-64 个字，不能有空格'
        return null
      }

      const submit = async () => {
        const target = resolveTarget()
        if (target === '') {
          setError('先选择一个目标')
          return
        }
        setBusy(true)
        setError(null)
        try {
          // An empty path means "whatever this target calls home": the picker
          // may still be loading, and a category with a default target should
          // not fail just because the listing has not arrived yet.
          let dir = path.trim()
          if (dir === '') {
            const home = await call('home', { target })
            dir = String(home.home || '')
            if (dir === '') throw new Error('目标没有可用的默认目录，请手动选择一个目录')
            setPath(dir)
          }
          // The host owns workspace creation for this flow; hand it a path it
          // can resolve (a real local path, a WSL UNC path, or a mirror dir).
          const prepared = await call('prepare-path', { target, path: dir })
          if (typeof props.onPicked !== 'function') throw new Error('宿主没有提供完成回调')
          await props.onPicked(prepared.dshPath)
        } catch (e) {
          const message = String(e.message || e)
          setError(message)
          if (typeof props.onError === 'function') props.onError(message)
        } finally {
          setBusy(false)
        }
      }

      const cancel = () => {
        if (typeof props.onCancel === 'function') props.onCancel()
      }

      const addProfile = async () => {
        if (form === null) return
        const problem = aliasProblem(form.alias)
        if (problem !== null) {
          setFormError(problem)
          return
        }
        try {
          setFormError(null)
          setError(null)
          const saved = await call('ssh-profile-add', {
            alias: form.alias.trim(),
            hostname: form.hostname.trim(),
            user: form.user.trim(),
            port: form.port.trim() === '' ? undefined : Number(form.port),
            identityFile: form.identityFile.trim(),
            password: form.password,
          })
          const list = await call('ssh-profiles')
          setProfiles(Array.isArray(list) ? list : [])
          setForm(null)
          setChoice(saved.alias)
          setTab('ssh')
        } catch (e) {
          // A rejection about the alias belongs under that field, not in the
          // dialog-wide error line at the very bottom.
          const message = String(e.message || e)
          if (/alias/i.test(message)) setFormError(message)
          else setError(message)
        }
      }

      // Hosts read from `~/.ssh/config` stay: that file is the user's own and
      // the plugin never rewrites it. The manage dialog therefore offers delete
      // only for hosts saved from this dialog, and says why for the others.
      const refreshProfiles = async () => {
        const list = await call('ssh-profiles')
        setProfiles(Array.isArray(list) ? list : [])
        return Array.isArray(list) ? list : []
      }

      const removeProfile = async (alias) => {
        try {
          setError(null)
          await call('ssh-profile-remove', { alias })
          await refreshProfiles()
          setChoice((current) => (current === alias ? '' : current))
        } catch (e) {
          setError(String(e.message || e))
        }
      }

      const listFiles = async (dir) => {
        setPickInput(dir)
        try {
          const result = await call('tree', { target: 'local', path: dir })
          setFilePick((prev) => ({
            dir,
            entries: result.entries,
            error: null,
            roots: prev === null ? [] : prev.roots,
          }))
          return true
        } catch (e) {
          setFilePick((prev) => ({
            dir,
            entries: [],
            error: String(e.message || e),
            roots: prev === null ? [] : prev.roots,
          }))
          return false
        }
      }

      const pickIdentityFile = async () => {
        try {
          setError(null)
          setFormError(null)
          const result = await call('home', { target: 'local' })
          const home = result.home || 'C:\\'
          const roots = await call('roots').catch(() => [])
          setFilePick({ dir: home, entries: [], error: null, roots: Array.isArray(roots) ? roots : [] })
          // Start where the field already points: a key outside ~/.ssh (D:\keys
          // on this machine, say) is then one click away instead of five.
          const typed = form === null ? '' : form.identityFile.trim()
          const typedDir = typed === '' ? '' : parentOf(typed)
          if (typedDir !== '' && typedDir !== typed && (await listFiles(typedDir))) return
          const separator = home.endsWith('\\') || home.endsWith('/') ? '' : '\\'
          const sshDir = `${home}${separator}.ssh`
          if (await listFiles(sshDir)) return
          await listFiles(home)
        } catch (e) {
          setError(String(e.message || e))
        }
      }

      const usePickedPath = () => {
        const value = pickInput.trim()
        if (value === '') return
        setForm({ ...form, identityFile: value })
        setFilePick(null)
      }
      const chooseFile = (entry) => {
        if (entry.type === 'dir') {
          void listFiles(entry.path)
          return
        }
        setForm({ ...form, identityFile: entry.path })
        setFilePick(null)
      }

      if (!open) return null

      const rows = []

      // The four categories are a segmented control: one glance tells the user
      // where the workspace will live, and the store's kinds fill the pickers.
      rows.push(
        h(KitTabs, {
          key: 'tabs',
          id: 'rs-add-tabs',
          value: tab,
          options: ADD_TABS.map((item) => ({ value: item.id, label: item.label })),
          onChange: (next) => pickTab(next),
        }),
      )

      if (tab !== 'local') {
        rows.push(
          h(
            'div',
            {
              key: 'target',
              // `is-solo` when the category offers no buttons: the select then
              // spans the full width instead of stopping short of a gap.
              className: tab === 'ssh' ? 'rs-flow-row is-grid' : 'rs-flow-row is-grid is-solo',
            },
            h(
              'div',
              { className: 'rs-select-wrap' },
              h(
                'select',
                { value: choiceValue, onChange: (event) => pickChoice(event.target.value) },
                h(
                  'option',
                  { value: '' },
                  targets === null ? '加载中…' : candidates.length === 0 ? emptyLabel : '选择目标…',
                ),
                candidates.map((option) => h('option', { key: option.value, value: option.value }, option.label)),
              ),
              h(
                'span',
                { className: 'rs-select-caret', 'aria-hidden': 'true' },
                h(
                  'svg',
                  { width: 11, height: 11, viewBox: '0 0 11 11', fill: 'none' },
                  h('path', {
                    d: 'M2.2 3.9 5.5 7.2 8.8 3.9',
                    stroke: 'currentColor',
                    strokeWidth: 1.4,
                    strokeLinecap: 'round',
                    strokeLinejoin: 'round',
                  }),
                ),
              ),
            ),
            tab === 'ssh'
              ? h(
                  KitButton,
                  {
                    variant: 'outline',
                    onClick: () => {
                      setForm({ alias: '', hostname: '', user: '', port: '', identityFile: '', password: '' })
                      setFormError(null)
                    },
                  },
                  '＋ 新增',
                )
              : null,
            // Delete opens a small list instead of acting on the selection: the
            // select may be empty or on a host from ~/.ssh/config, and guessing
            // which host to remove is how the wrong one disappears.
            tab === 'ssh'
              ? h(
                  KitButton,
                  {
                    variant: 'outline',
                    disabled: profiles.length === 0,
                    title: profiles.length === 0 ? '还没有可管理的主机' : '管理 / 删除 SSH 主机',
                    onClick: () => {
                      setError(null)
                      setManage(true)
                    },
                  },
                  '删除',
                )
              : null,
          ),
        )
      } else {
        // Local has nothing to pick a target from, so the drives take that slot.
        // Same height and shape as the select above it, so switching tabs does
        // not move the path row.
        rows.push(
          h(
            'div',
            { key: 'drives', className: 'rs-flow-row is-grid is-solo' },
            h(
              'div',
              { className: 'rs-drives' },
              roots.map((root) =>
                h(
                  'button',
                  {
                    key: root.path,
                    type: 'button',
                    className: `rs-drive${sameRoot(root.path, path) ? ' is-active' : ''}`,
                    title: root.path,
                    onClick: () => void browse(root.path),
                  },
                  root.label,
                ),
              ),
            ),
          ),
        )
      }

      // A new host is a dialog of its own: the workspace dialog keeps its size
      // no matter which category is open, and adding a host never pushes the
      // directory list around.
      if (tab === 'ssh' && form !== null) {
        const field = (key, label, placeholder, type) =>
          h(
            'label',
            { key, className: 'rs-flow-field' },
            h('span', { className: 'rs-flow-label' }, label),
            h(KitInput, {
              type: type || 'text',
              placeholder,
              spellCheck: false,
              value: form[key],
              onChange: (event) => setForm({ ...form, [key]: event.target.value }),
            }),
          )
        rows.push(
          h(
            'div',
            { key: 'form', className: 'rs-picker-backdrop' },
            h(
              'div',
              { className: 'rs-picker-card rs-form-card', role: 'dialog', 'aria-label': '新增 SSH 主机' },
              h(
                'div',
                { className: 'rs-picker-head' },
                h('strong', { className: 'rs-picker-title' }, '新增 SSH 主机'),
              ),
              h(
                'div',
                { className: 'rs-form-body' },
                h(
                  'div',
                  { className: 'rs-flow-grid' },
                  field('alias', '别名', '如 云服务器'),
                  field('hostname', '主机', '主机名或 IP'),
                  field('user', '用户', '可空'),
                  field('port', '端口', '默认 22'),
                ),
                h(
                  'label',
                  { className: 'rs-flow-field' },
                  h('span', { className: 'rs-flow-label' }, '私钥'),
                  h(
                    'div',
                    { className: 'rs-flow-row' },
                    h(KitInput, {
                      placeholder: '私钥路径，可空',
                      spellCheck: false,
                      value: form.identityFile,
                      onChange: (event) => setForm({ ...form, identityFile: event.target.value }),
                    }),
                    h(KitButton, { variant: 'outline', onClick: () => void pickIdentityFile() }, '选择'),
                  ),
                ),
                field('password', '密码', '可空', 'password'),
                formError === null
                  ? null
                  : h('div', { className: 'rs-flow-error' }, formError),
              ),
              h(
                'div',
                { className: 'rs-picker-foot is-center' },
                h(KitButton, { variant: 'outline', onClick: () => setForm(null) }, '取消'),
                h(KitButton, { variant: 'primary', onClick: () => void addProfile() }, '保存并选用'),
              ),
            ),
          ),
        )
      }

      // Deleting a host is its own dialog: the list is the target picker, and
      // `~/.ssh/config` rows appear with a note instead of a button so the
      // reason they stay is visible where they are.
      if (tab === 'ssh' && manage) {
        rows.push(
          h(
            'div',
            { key: 'manage', className: 'rs-picker-backdrop', style: { zIndex: 1050 } },
            h(
              'div',
              { className: 'rs-picker-card rs-form-card', role: 'dialog', 'aria-label': '管理 SSH 主机' },
              h(
                'div',
                { className: 'rs-picker-head' },
                h('strong', { className: 'rs-picker-title' }, '管理 SSH 主机'),
              ),
              h(
                'div',
                { className: 'rs-form-body' },
                profiles.length === 0
                  ? h('div', { className: 'rs-flow-empty' }, '还没有主机')
                  : h(
                      'div',
                      { className: 'rs-profile-list' },
                      profiles.map((profile) =>
                        h(
                          'div',
                          { key: profile.alias, className: 'rs-profile-row' },
                          h(
                            'div',
                            { className: 'rs-profile-main' },
                            h('span', { className: 'rs-profile-alias' }, profile.alias),
                            h('span', { className: 'rs-profile-addr' }, formatHost(profile)),
                            profile.source === 'saved'
                              ? null
                              : h('span', { className: 'rs-profile-tag' }, '~/.ssh/config'),
                          ),
                          profile.source === 'saved'
                            ? h(
                                KitButton,
                                { variant: 'outline', onClick: () => void removeProfile(profile.alias) },
                                '删除',
                              )
                            : h('span', { className: 'rs-profile-note' }, '在那个文件里编辑'),
                        ),
                      ),
                    ),
                error === null ? null : h('div', { className: 'rs-flow-error' }, error),
              ),
              h(
                'div',
                { className: 'rs-picker-foot is-center' },
                h(KitButton, { variant: 'primary', onClick: () => setManage(false) }, '关闭'),
              ),
            ),
          ),
        )
      }

      rows.push(
        h(
          'div',
          { key: 'path', className: 'rs-flow-row is-grid' },
          h(KitInput, {
            value: path,
            spellCheck: false,
            placeholder: tab === 'local' ? 'C:\\path\\to\\project' : '/home/you/project',
            onChange: (event) => setPath(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') void browse(path.trim())
            },
          }),
          h(KitButton, { variant: 'outline', onClick: () => void browse(parentOf(path.trim())) }, '上级'),
          h(KitButton, { variant: 'outline', onClick: () => void goHome() }, '主目录'),
        ),
      )

      if (tab === 'docker') {
        rows.push(
          h(
            'div',
            { key: 'docker-hint', className: 'rs-flow-hint' },
            '运行中的容器会直接打开容器里的真实文件（和 WSL 一样）；容器停止时才退回本地镜像目录。',
          ),
        )
      }

      if (filePick !== null) {
        rows.push(
          h(
            'div',
            { key: 'file-pick', className: 'rs-picker-backdrop', style: { zIndex: 1100 } },
            h(
              'div',
              { className: 'rs-picker-card', role: 'dialog', 'aria-label': '选择私钥文件' },
              h(
                'div',
                { className: 'rs-picker-head' },
                h('strong', { className: 'rs-picker-title' }, '选择私钥文件'),
                h(
                  'div',
                  { className: 'rs-picker-drives' },
                  filePick.roots.map((root) =>
                    h(
                      'button',
                      {
                        key: root.path,
                        type: 'button',
                        className: `rs-picker-drive${root.path === filePick.dir ? ' is-active' : ''}`,
                        onClick: () => void listFiles(root.path),
                      },
                      root.label,
                    ),
                  ),
                ),
                h(KitInput, {
                  value: pickInput,
                  spellCheck: false,
                  placeholder: '输入路径后回车',
                  onChange: (event) => setPickInput(event.target.value),
                  onKeyDown: (event) => {
                    if (event.key === 'Enter') void listFiles(pickInput.trim())
                  },
                }),
              ),
              h(
                'div',
                { className: 'rs-picker-list' },
                filePick.error !== null
                  ? h('div', { className: 'rs-flow-empty' }, filePick.error)
                  : filePick.entries.length === 0
                    ? h('div', { className: 'rs-flow-empty' }, '（空目录）')
                    : filePick.entries.map((entry) =>
                        h(
                          'button',
                          {
                            key: entry.path,
                            type: 'button',
                            className: 'rs-flow-item',
                            onClick: () => chooseFile(entry),
                          },
                          h(
                            'span',
                            { className: 'rs-flow-item-name' },
                            entry.type === 'dir' ? `${entry.name}/` : entry.name,
                          ),
                          h('span', { className: 'rs-flow-item-chevron' }, entry.type === 'dir' ? '›' : ''),
                        ),
                      ),
              ),
              h(
                'div',
                { className: 'rs-picker-foot' },
                h(KitButton, { variant: 'outline', onClick: () => void listFiles(parentOf(filePick.dir)) }, '上级'),
                h(KitButton, { variant: 'outline', onClick: () => void pickIdentityFile() }, '主目录'),
                h('span', { style: { flex: 1 } }),
                h(KitButton, { variant: 'outline', onClick: () => setFilePick(null) }, '取消'),
                // The input above doubles as the answer: a path typed by hand
                // (or a file the list cannot show) is accepted as-is.
                h(
                  KitButton,
                  {
                    variant: 'primary',
                    disabled: pickInput.trim() === '',
                    onClick: usePickedPath,
                  },
                  '使用此路径',
                ),
              ),
            ),
          ),
        )
      } else {
        rows.push(
          h(
            'div',
            { key: 'browse', className: 'rs-flow-list' },
            entries === null
              ? h('div', { className: 'rs-flow-empty' }, browseError === null ? '选择目标后浏览目录' : browseError)
              : entries.length === 0
                ? h('div', { className: 'rs-flow-empty' }, browseError === null ? '（没有子目录）' : browseError)
                : entries.map((entry) =>
                    h(
                      'button',
                      { key: entry.path, className: 'rs-flow-item', onClick: () => void browse(entry.path) },
                      h('span', { className: 'rs-flow-item-name' }, entry.name),
                      h('span', { className: 'rs-flow-item-chevron' }, '›'),
                    ),
                  ),
          ),
        )
      }

      if (error !== null) rows.push(h('div', { key: 'error', className: 'rs-flow-error' }, error))

      rows.push(
        h(
          'div',
          { key: 'actions', className: 'rs-flow-actions' },
          h(KitButton, { variant: 'outline', disabled: busy, onClick: cancel }, '取消'),
          h(KitButton, { variant: 'primary', disabled: busy, onClick: () => void submit() }, busy ? '创建中…' : '创建并打开'),
        ),
      )

      return h(
        Modal,
        {
          open: true,
          className: 'rs-modal-workspace',
          onClose: () => {
            if (!busy) cancel()
          },
          title: '添加工作区',
          closeLabel: '关闭',
        },
        h(
          'div',
          { className: 'rs-flow' },
          rows.map((node, index) => h(React.Fragment, { key: `block-${index}` }, node)),
        ),
      )
    }

    // ---------------------------------------------------------------------
    // Main seat: editor tabs + command console
    // ---------------------------------------------------------------------

    // A forwarded remote port rendered in place: this is how a remote web UI
    // (a `dsh web`, a dev server, a notebook) is embedded in the workspace view.
    function WebTab({ tab, hidden }) {
      return h(
        'div',
        { className: 'rs-web', style: hidden ? { display: 'none' } : null },
        h('iframe', {
          className: 'rs-frame',
          src: tab.url,
          title: tab.title || tab.url,
          referrerPolicy: 'no-referrer',
        }),
      )
    }

    // ---------------------------------------------------------------------
    // A very small syntax highlighter. It paints one flat run of spans behind
    // a transparent textarea, so the caret and selection still behave exactly
    // like a normal textarea while the text underneath carries colour. No
    // library is required (the DSH profile ships no editor package).
    // ---------------------------------------------------------------------

    const KEYWORDS = new Set([
      'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue', 'return',
      'function', 'const', 'let', 'var', 'class', 'extends', 'new', 'this', 'super', 'import',
      'from', 'export', 'default', 'async', 'await', 'try', 'catch', 'finally', 'throw', 'typeof',
      'instanceof', 'in', 'of', 'delete', 'void', 'yield', 'static', 'get', 'set', 'null',
      'undefined', 'true', 'false', 'def', 'elif', 'pass', 'lambda', 'None', 'True', 'False',
      'and', 'or', 'not', 'is', 'with', 'as', 'raise', 'except', 'global', 'nonlocal', 'assert',
      'package', 'struct', 'interface', 'enum', 'public', 'private', 'protected', 'final', 'func',
      'fn', 'impl', 'pub', 'mut', 'use', 'mod', 'match', 'type', 'let', 'echo', 'then', 'fi',
      'esac', 'done', 'elif', 'local', 'export', 'source', 'select',
    ])

    function escapeHtml(text) {
      return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    }

    function highlight(text) {
      const pattern = new RegExp(
        [
          '(/\\*[\\s\\S]*?\\*/|//[^\\n]*|#[^\\n]*)', // 1 comment
          '("(?:[^"\\\\]|\\\\.)*"|\'(?:[^\'\\\\]|\\\\.)*\'|`(?:[^`\\\\]|\\\\.)*`)', // 2 string
          '\\b(0[xX][0-9a-fA-F]+|\\d+(?:\\.\\d+)?)\\b', // 3 number
          '\\b([A-Za-z_$][\\w$]*)\\b', // 4 word
        ].join('|'),
        'g',
      )
      let out = ''
      let last = 0
      let match
      while ((match = pattern.exec(text)) !== null) {
        if (match.index > last) out += escapeHtml(text.slice(last, match.index))
        if (match[1] !== undefined) {
          out += `<span class="tok-com">${escapeHtml(match[1])}</span>`
        } else if (match[2] !== undefined) {
          out += `<span class="tok-str">${escapeHtml(match[2])}</span>`
        } else if (match[3] !== undefined) {
          out += `<span class="tok-num">${escapeHtml(match[3])}</span>`
        } else {
          const word = match[4]
          if (KEYWORDS.has(word)) {
            out += `<span class="tok-kw">${escapeHtml(word)}</span>`
          } else if (/^\s*\(/.test(text.slice(pattern.lastIndex))) {
            out += `<span class="tok-fn">${escapeHtml(word)}</span>`
          } else {
            out += escapeHtml(word)
          }
        }
        last = pattern.lastIndex
      }
      if (last < text.length) out += escapeHtml(text.slice(last))
      return out
    }

    function EditorTab({ tab, index, hidden }) {
      const store = useStore()
      const dirty = tab.text !== tab.saved
      const hlRef = React.useRef(null)
      const gutterRef = React.useRef(null)
      const taRef = React.useRef(null)
      const lineCount = React.useMemo(() => tab.text.split('\n').length, [tab.text])
      const html = React.useMemo(() => highlight(tab.text), [tab.text])

      const onChange = (event) => updateTab(index, { text: event.target.value })

      const syncScroll = () => {
        const ta = taRef.current
        if (ta === null) return
        if (hlRef.current !== null) {
          hlRef.current.scrollTop = ta.scrollTop
          hlRef.current.scrollLeft = ta.scrollLeft
        }
        if (gutterRef.current !== null) gutterRef.current.scrollTop = ta.scrollTop
      }

      // Keep the overlay and gutter aligned when the tab sizes change.
      React.useEffect(() => {
        syncScroll()
      }, [])

      const gutter = []
      for (let n = 1; n <= lineCount; n += 1) gutter.push(n)

      return h(
        'div',
        { className: 'rs-editor', style: hidden ? { display: 'none' } : null },
        h(
          'div',
          { className: 'rs-editor-bar' },
          h('span', { className: 'rs-ed-path', title: tab.path }, tab.path),
          dirty ? h('span', { className: 'rs-dim' }, '未保存') : null,
          h('button', { className: 'rs-btn', onClick: () => saveTab(index), disabled: !dirty }, '保存'),
        ),
        h(
          'div',
          { className: 'rs-code-wrap' },
          h('div', { className: 'rs-gutter', ref: gutterRef }, gutter.join('\n')),
          h(
            'div',
            { className: 'rs-code-scroll' },
            h('pre', { className: 'rs-code-hl', ref: hlRef, 'aria-hidden': true, dangerouslySetInnerHTML: { __html: html + '\n' } }),
            h('textarea', {
              className: 'rs-code-ta',
              ref: taRef,
              value: tab.text,
              spellCheck: false,
              wrap: 'off',
              onChange,
              onScroll: syncScroll,
              onKeyDown: (event) => {
                if ((event.ctrlKey || event.metaKey) && event.key === 's') {
                  event.preventDefault()
                  if (dirty) saveTab(index)
                }
                if (event.key === 'Tab') {
                  event.preventDefault()
                  const ta = event.target
                  const start = ta.selectionStart
                  const end = ta.selectionEnd
                  const next = tab.text.slice(0, start) + '  ' + tab.text.slice(end)
                  updateTab(index, { text: next })
                  requestAnimationFrame(() => {
                    if (taRef.current !== null) {
                      taRef.current.selectionStart = start + 2
                      taRef.current.selectionEnd = start + 2
                    }
                  })
                }
              },
            }),
          ),
        ),
        h(
          'div',
          { className: 'rs-editor-status' },
          h('span', null, `${lineCount} 行`),
          h('span', null, `${tab.text.length} 字符`),
          h('span', { className: 'rs-app-spacer' }),
          h('span', null, dirty ? '● 未保存' : '已保存'),
          h('span', { title: store.target === null ? '' : store.target }, store.target === null ? '' : store.target),
        ),
      )
    }

    // A real terminal: xterm.js over a WebSocket to this plugin's PTY bridge.
    // One socket per tab; switching tabs only hides the element, so the shell
    // (and its scrollback) survives until the tab or the plugin goes away.
    const STATUS_TEXT = { connecting: '连接中…', open: '已连接', closed: '已退出', error: '出错' }

    function TerminalTab({ hidden }) {
      const store = useStore()
      const hostRef = React.useRef(null)
      const live = React.useRef(null)
      const session = React.useRef({ target: null, cwd: null })
      const [status, setStatus] = React.useState('connecting')
      const [detail, setDetail] = React.useState('')
      const [fallback, setFallback] = React.useState(null)
      // The terminal must follow the host theme, so keep the current answer in a
      // ref: `connect()` runs outside render and needs it synchronously.
      const darkRef = React.useRef(hostIsDark())

      const disconnect = () => {
        const current = live.current
        if (current === null) return
        live.current = null
        try {
          if (current.observer !== undefined) current.observer.disconnect()
        } catch (error) {
          void error
        }
        try {
          current.ws.close()
        } catch (error) {
          void error
        }
        try {
          current.term.dispose()
        } catch (error) {
          void error
        }
      }

      const connect = (target, cwd) => {
        const node = hostRef.current
        if (node === null) return
        disconnect()
        node.textContent = ''
        const term = new window.Terminal({
          cursorBlink: true,
          fontSize: 12,
          fontFamily: 'ui-monospace, SFMono-Regular, Consolas, "Courier New", monospace',
          scrollback: 4000,
          theme: terminalPalette(darkRef.current),
        })
        const fit = new window.FitAddon.FitAddon()
        term.loadAddon(fit)
        term.open(node)
        try {
          fit.fit()
        } catch (error) {
          void error
        }
        const ws = new WebSocket(socketUrl(PTY))
        live.current = { term, fit, ws, observer: null }
        session.current = { target, cwd }
        setStatus('connecting')
        setDetail('')
        ws.onopen = () => {
          ws.send(JSON.stringify({ t: 'open', target, cwd: cwd || undefined, cols: term.cols, rows: term.rows }))
        }
        ws.onmessage = (event) => {
          let message
          try {
            message = JSON.parse(event.data)
          } catch {
            return
          }
          if (message.t === 'ready') {
            setStatus('open')
            try {
              fit.fit()
            } catch (error) {
              void error
            }
            term.focus()
          } else if (message.t === 'data') {
            term.write(message.d)
          } else if (message.t === 'exit') {
            setStatus('closed')
            term.write(`\r\n[进程已退出${message.code === null ? '' : `：${message.code}`}]\r\n`)
          } else if (message.t === 'error') {
            setStatus('error')
            setDetail(message.message)
            term.write(`\r\n[错误] ${message.message}\r\n`)
          }
        }
        ws.onerror = () => setStatus('error')
        ws.onclose = () => setStatus((current) => (current === 'open' ? 'closed' : current))
        term.onData((data) => {
          if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'data', d: data }))
        })
        const observer = new ResizeObserver(() => {
          try {
            fit.fit()
          } catch {
            return
          }
          if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'resize', cols: term.cols, rows: term.rows }))
        })
        observer.observe(node)
        live.current.observer = observer
      }

      React.useEffect(() => {
        // The terminal mounts before the target list arrives; connecting with an
        // empty target would only produce an error frame. Wait for one, and also
        // wait for a real starting directory: a bare target has no scope base,
        // and the Host needs an actual path to chdir into.
        if (store.target === null) return undefined
        let alive = true
        let timer = null
        const start = () => {
          if (!alive) return
          const root = state.root
          if (typeof root !== 'string' || root === '') {
            timer = setTimeout(start, 120)
            return
          }
          loadTerminalAssets()
            .then(() => {
              if (alive) connect(store.target, root)
            })
            .catch((error) => {
              if (alive) {
                setFallback(error.message || String(error))
                setStatus('error')
              }
            })
        }
        start()
        return () => {
          alive = false
          if (timer !== null) clearTimeout(timer)
          disconnect()
        }
        // Reconnect whenever the target changes. A shell that was spawned in the
        // old target would otherwise keep writing into the machine the user has
        // already left, so the tab re-attaches instead of showing a stale
        // session under a new target's name.
      }, [store.target])

      // A live terminal keeps the palette it was created with, so repaint it when
      // the reader switches the host theme while the shell is still running.
      React.useEffect(() => {
        return watchHostTheme((dark) => {
          darkRef.current = dark
          const liveNow = live.current
          if (liveNow === null) return
          try {
            liveNow.term.options.theme = terminalPalette(dark)
          } catch (error) {
            void error
          }
        })
      }, [])

      // A tab that was hidden mounts at zero width; refit the moment it is shown.
      React.useEffect(() => {
        if (hidden) return
        const frame = requestAnimationFrame(() => {
          const liveNow = live.current
          if (liveNow === null) return
          try {
            liveNow.fit.fit()
            if (liveNow.ws.readyState === 1) {
              liveNow.ws.send(JSON.stringify({ t: 'resize', cols: liveNow.term.cols, rows: liveNow.term.rows }))
            }
          } catch (error) {
            void error
          }
        })
        return () => cancelAnimationFrame(frame)
      }, [hidden])

      if (fallback !== null) {
        return h(ConsoleTab, { note: `xterm 加载失败（${fallback}），已退回命令控制台` })
      }

      const label = session.current.target === null ? '终端' : `${session.current.target}${session.current.cwd ? ` · ${session.current.cwd}` : ''}`
      const stale = session.current.target !== null && session.current.target !== store.target
      return h(
        'div',
        { className: 'rs-term-wrap', style: hidden ? { display: 'none' } : null },
        h(
          'div',
          { className: 'rs-term-bar' },
          h('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' } }, label),
          stale ? h('span', { className: 'rs-term-err' }, '目标已切换') : null,
          h('span', { className: 'rs-dim' }, STATUS_TEXT[status] || status),
          h('button', { className: 'rs-btn', onClick: () => connect(store.target, store.root) }, '重连'),
        ),
        detail === '' ? null : h('div', { className: 'rs-term-err', style: { padding: '2px 10px' } }, detail),
        h('div', { className: 'rs-xterm', ref: hostRef }),
      )
    }

    // Fallback: one command at a time through the JSON API (no PTY needed).
    function ConsoleTab({ note }) {
      const store = useStore()
      const [command, setCommand] = React.useState('')
      const outputRef = React.useRef(null)

      React.useEffect(() => {
        const node = outputRef.current
        if (node !== null) node.scrollTop = node.scrollHeight
      }, [store.term.length])

      const submit = () => {
        const next = command
        setCommand('')
        runCommand(next)
      }

      const lines = store.term.map((line, index) =>
        h(
          'div',
          { key: index, className: line.kind === 'cmd' ? 'rs-term-cmd' : line.kind === 'err' ? 'rs-term-err' : null },
          line.kind === 'cmd' ? `$ ${line.text}` : line.text,
        ),
      )

      return h(
        'div',
        { className: 'rs-term' },
        note === undefined ? null : h('div', { className: 'rs-term-err', style: { padding: '4px 10px' } }, note),
        h('div', { className: 'rs-term-out', ref: outputRef }, lines),
        h(
          'div',
          { className: 'rs-term-in' },
          h('span', { style: { opacity: 0.6 } }, '$'),
          h('input', {
            className: 'rs-input',
            value: command,
            spellCheck: false,
            disabled: store.termBusy,
            placeholder: store.root === null ? '先选择一个目标' : store.root,
            onChange: (event) => setCommand(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') submit()
            },
          }),
          h('button', { className: 'rs-btn', onClick: submit, disabled: store.termBusy || command.trim() === '' }, '运行'),
        ),
      )
    }

    function EditorArea() {
      const store = useStore()
      const tabs = store.tabs
      const termIndex = tabs.length
      const active = store.active >= 0 && store.active <= termIndex ? store.active : termIndex
      const pending = store.pendingClose

      const tabBar = []
      tabs.forEach((tab, index) => {
        const dirty = tab.kind !== 'web' && tab.text !== tab.saved
        const label = tab.kind === 'web' ? tab.title || '网页' : tab.path.split(/[\\/]/).pop()
        tabBar.push(
          h(
            'div',
            {
              key: tab.key,
              className: active === index ? 'rs-tab active' : 'rs-tab',
              onClick: () => setState({ active: index }),
              title: tab.kind === 'web' ? tab.url : tab.path,
            },
            h('span', { style: { maxWidth: '220px', overflow: 'hidden', textOverflow: 'ellipsis' } }, label),
            dirty ? h('span', { className: 'rs-dot' }) : null,
            h(
              'span',
              {
                className: 'rs-tab-x',
                onClick: (event) => {
                  event.stopPropagation()
                  closeTab(index)
                },
              },
              '×',
            ),
          ),
        )
      })
      tabBar.push(
        h(
          'div',
          {
            key: 'terminal',
            className: active === termIndex || active === -1 ? 'rs-tab active' : 'rs-tab',
            onClick: () => setState({ active: termIndex }),
          },
          h('span', { style: { display: 'inline-flex', marginRight: '4px' } }, h(Glyph, { name: 'terminal', size: 12 })),
          '终端',
        ),
      )

      const bodies = tabs.map((tab, index) =>
        tab.kind === 'web'
          ? h(WebTab, { tab, key: tab.key, hidden: active !== index })
          : h(EditorTab, { tab, index, key: tab.key, hidden: active !== index }),
      )
      bodies.push(h(TerminalTab, { key: 'terminal', hidden: active !== termIndex }))

      const confirmBar =
        pending === null || tabs[pending] === undefined
          ? null
          : h(
              'div',
              {
                style: {
                  display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 12px',
                  borderTop: '1px solid var(--dsh-border, rgba(127,127,127,0.24))',
                  background: 'color-mix(in srgb, var(--dsh-danger, #e5534b) 10%, transparent)',
                  fontSize: '12px',
                },
              },
              h('span', { style: { flex: 1 } }, `“${tabs[pending].path.split(/[\\/]/).pop()}” 有未保存的修改，关闭前要保存吗？`),
              h('button', { className: 'rs-btn rs-primary', onClick: () => saveThenClose(pending) }, '保存并关闭'),
              h('button', { className: 'rs-btn', onClick: () => closeTab(pending, true) }, '不保存'),
              h('button', { className: 'rs-btn', onClick: () => setState({ pendingClose: null }) }, '取消'),
            )

      return h(
        'div',
        { className: 'rs-main' },
        h('div', { className: 'rs-tabs' }, tabBar),
        h('div', { className: 'rs-body' }, bodies),
        confirmBar,
      )
    }

    // The one view the entry points open: a header bar, targets + tree on the
    // left, editor and terminal on the right.
    function Workspace() {
      useStyle()
      return h(
        'div',
        { className: 'rs-workspace' },
        h('div', { className: 'rs-side' }, h(Panel)),
        h(EditorArea),
      )
    }

    // ---------------------------------------------------------------------
    // Entry points
    //
    // The workbench is a full-screen overlay mounted in `shell.overlay`. Its
    // entry lives in the left rail (`sidebar.panellist`), styled as the same
    // accent-dot capsule the composer pill used to be, or it opens with
    // Ctrl/Cmd+`. The rail only hands a plugin a small icon-sized slot, so the
    // capsule is scaled down to fit rather than being a letter box.
    // ---------------------------------------------------------------------

    // Opens the workbench from anywhere: the rail entry and the keyboard
    // shortcut both call this through the module-level helper below.
    function openFromAnywhere() {
      openWorkbench()
      const api = globalThis.__DSH_REMOTE__
      if (api !== undefined && typeof api.focus === 'function') api.focus()
    }

    // The rail entry. The rail gives each plugin an icon-sized slot (dsh-im
    // passes `size` to a 16px svg), so the compact form is an accent-tinted
    // terminal glyph — same family as the other rail icons — and the full
    // accent-dot capsule only appears when the host proves it has real room.
    function RailEntry(owner) {
      useStyle()
      const store = useStore()
      const size = owner && typeof owner.size === 'number' && owner.size > 0 ? owner.size : 16
      const compact = size < 40
      const target = store.target === null ? '' : store.target.replace(/^[a-z]+:/, '')
      const title = '远程工作台' + (target === '' ? '' : ' · ' + target) + '（Ctrl/⌘+`）'
      const box = compact ? { width: size + 'px', height: size + 'px' } : null
      return h(
        'button',
        { className: compact ? 'rs-rail-btn is-compact' : 'rs-rail-btn', style: box, title, onClick: openFromAnywhere },
        compact ? h(Glyph, { name: 'terminal', size: Math.max(12, size - 4) }) : h('span', { className: 'rs-rail-dot' }),
        compact ? null : h('span', { className: 'rs-rail-txt' }, '远程'),
      )
    }

    // The rail icon is not a free-floating button as far as the host is
    // concerned: clicking it means "activate the main panel with this id".
    // Both reference implementations (dsh-im, dshmarket) therefore register a
    // `main` seat whose key equals the rail id. Without it the click is a
    // no-op — the host switches to a panel that does not exist. So the `main`
    // seat exists solely as a launcher: it opens the overlay and immediately
    // gives the main area back, keeping the workbench a floating window.
    function MainLaunch(props) {
      React.useEffect(() => {
        // Toggle, not just open: the rail icon behaves like a light switch, so
        // clicking it again while the workbench is up puts it away.
        if (state.open === true) closeWorkbench()
        else openWorkbench()
        const layout = (props && props.layout) || null
        if (layout !== null && typeof layout.selectPanel === 'function') {
          // Let the overlay paint first, then return the main area to whatever
          // the user was looking at instead of leaving an empty panel behind.
          const timer = setTimeout(() => {
            try {
              layout.selectPanel(null)
            } catch (error) {
              void error
            }
          }, 90)
          return () => clearTimeout(timer)
        }
        return undefined
      }, [])
      return null
    }

    // The overlay itself. It owns the keyboard shortcut and keeps the rest of
    // the app usable underneath: clicking the backdrop closes it, Escape too.
    function WorkbenchOverlay() {
      useStyle()
      const store = useStore()
      const open = store.open === true
      const [addOpen, setAddOpen] = React.useState(false)
      // The host lets the reader switch theme at any time, so the overlay can't
      // sample the theme once at render: track it, or a light workbench would
      // stay light (white terminal and all) after the reader picks dark.
      const [dark, setDark] = React.useState(() => hostIsDark())

      React.useEffect(() => {
        return watchHostTheme(setDark)
      }, [])

      React.useEffect(() => {
        const onKey = (event) => {
          if (
            (event.ctrlKey || event.metaKey) &&
            !event.altKey &&
            (event.key === '`' || event.key === '~' || event.code === 'Backquote')
          ) {
            event.preventDefault()
            event.stopPropagation()
            toggleWorkbench()
          }
          if (event.key === 'Escape' && state.open === true) {
            event.preventDefault()
            event.stopPropagation()
            closeWorkbench()
          }
        }
        globalThis.addEventListener('keydown', onKey, true)
        // A small test hook, mirroring dsh-terminal's __DSH_TERMINAL__.
        globalThis.__DSH_REMOTE__ = {
          open: () => setState({ open: true }),
          close: () => setState({ open: false }),
          toggle: () => setState((current) => ({ open: !current.open })),
          state: () => state,
          focus: () => undefined,
          // Driving the selection from outside is what lets a smoke test (or a
          // support engineer in the devtools console) reach a deep view without
          // clicking through the tree.
          initialize: () => initialize(),
          selectTarget: (id) => selectTarget(id),
          go: (path) => { setState({ root: path, expanded: {} }); return loadDir(path) },
          openFile: (path) => openFile(path),
          refresh: () => refreshWorkspaces(),
          // The terminal is not a tab object; it always sits one past the last
          // editor tab, so "activate terminal" is just that index.
          activateTerminal: () => setState({ active: state.tabs.length }),
        }
        return () => {
          globalThis.removeEventListener('keydown', onKey, true)
          delete globalThis.__DSH_REMOTE__
        }
      }, [])

      // Boot the target list the first time the overlay is opened, so the app
      // does not pay for it until the user actually asks for the workbench.
      React.useEffect(() => {
        if (open && !store.ready) initialize()
      }, [open, store.ready])

      if (!open) return null

      const tree = h(
        'div',
        {
          className: 'rs-overlay-backdrop ' + (dark ? 'rs-theme-dark' : 'rs-theme-light'),
          onClick: () => {
            if (state.pendingClose === null) closeWorkbench()
          },
        },
        h(
          'div',
          { className: 'rs-overlay-card', onClick: (event) => event.stopPropagation() },
          h(
            'div',
            { className: 'rs-app-head' },
            h('div', { className: 'rs-app-brand' },
              h('span', { className: 'rs-logo' }, h(Glyph, { name: 'terminal', size: 14 })),
              h('span', null, '远程工作台'),
            ),
            h('span', { className: 'rs-app-spacer' }),
            h('span', { className: 'rs-kbd' }, 'Ctrl/⌘ + `'),
            h('button', { className: 'rs-icon-btn', title: '添加工作区', onClick: () => setAddOpen(true) }, h(Glyph, { name: 'plus', size: 14 })),
            h('button', { className: 'rs-icon-btn', title: '关闭（Esc）', onClick: closeWorkbench }, h(Glyph, { name: 'close', size: 14 })),
          ),
          h('div', { className: 'rs-app-body' }, h(Workspace)),
        ),
        h(AddWorkspaceFlow, {
          open: addOpen,
          onPicked: async () => {
            setAddOpen(false)
            await refreshWorkspaces()
          },
          onCancel: () => setAddOpen(false),
          onError: () => undefined,
        }),
      )

      // Onto <body> when possible: the host frame clips overflow, so only a
      // bodied fixed overlay is guaranteed to cover the whole window.
      return canPortal() ? ReactDOM.createPortal(tree, document.body) : tree
    }

    var inject = ['slots', 'workspaces']

    // The host renders its own add-workspace dialog through these two slots.
    // Registering at a low priority takes the flow over, exactly the way the
    // remote-ssh plugin did, so the official "＋ 添加工作区" opens our tabs.
    var FLOW_SLOTS = ['conversation.hero.workspace.directoryFlow', 'sidebar.workspaces.directoryFlow']

    // Seats are only materialized once their slot service exists, so each one
    // is claimed with inject() first — registering directly is a no-op/throw.
    // ------------------------------------------------------------ files tab
    //
    // The right sidebar's "工作区文件" pane. The host half serves it through our
    // own routes (`/remote-suite/sidebar/...`), but the wire contract is the one
    // dsh-better-sidebar documents — see docs/better-sidebar-file-api.md: a POST
    // per method with a JSON body and a `{ ok, value }` / `{ ok, error }`
    // envelope, raw text through /write, raw bytes through /file. Keeping our own
    // path means better-sidebar can stay installed: it owns `/sidebar/*`, we own
    // `/remote-suite/sidebar/*`, and each tab kind is claimed once.
    const SIDEBAR_BASE = '/remote-suite/sidebar'
    const SIDEBAR_HEADERS = { 'content-type': 'application/json', 'x-remote-suite': '1' }

    function sidebarCall(method, payload) {
      const body = payload === undefined ? {} : payload
      return fetch(SIDEBAR_BASE + '/api/' + method, {
        method: 'POST',
        headers: SIDEBAR_HEADERS,
        body: JSON.stringify(body),
      }).then(
        (res) =>
          res
            .json()
            .catch(() => null)
            .then((parsed) => {
              if (parsed !== null && parsed.ok === true) return parsed.value
              const error = (parsed !== null && parsed.ok === false && parsed.error) || {}
              const failure = new Error(error.message || 'HTTP ' + res.status)
              failure.code = error.code || 'internal'
              throw failure
            }),
        (error) => {
          const failure = new Error(error && error.message ? error.message : 'network error')
          failure.code = 'network'
          throw failure
        },
      )
    }

    function sessionCwdOf(sessionId) {
      const service = workspaceServices.sessions
      if (!service || typeof sessionId !== 'string' || sessionId === '') return undefined
      try {
        const snapshot = service.list.getSnapshot()
        const entry = snapshot !== undefined && snapshot.byId !== undefined ? snapshot.byId[sessionId] : undefined
        return entry !== undefined && typeof entry.cwd === 'string' ? entry.cwd : undefined
      } catch (error) {
        return undefined
      }
    }

    function filesJoin(dir, name) {
      if (dir === '') return name
      const last = dir.charAt(dir.length - 1)
      if (last === '/' || last === '\\') return dir + name
      return dir + (dir.indexOf('\\') >= 0 && dir.indexOf('/') < 0 ? '\\' : '/') + name
    }

    function filesParent(dir) {
      const cut = Math.max(dir.lastIndexOf('/'), dir.lastIndexOf('\\'))
      if (cut < 0) return dir
      const head = dir.slice(0, cut)
      if (head === '') return dir.slice(0, 1)
      if (/^[A-Za-z]:$/.test(head)) return head + dir.charAt(cut)
      return head
    }

    function filesBaseName(path) {
      const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
      return cut < 0 ? path : path.slice(cut + 1)
    }

    function filesBytes(size) {
      if (typeof size !== 'number' || !isFinite(size)) return ''
      if (size < 1024) return size + ' B'
      if (size < 1024 * 1024) return (size / 1024).toFixed(1) + ' KB'
      return (size / (1024 * 1024)).toFixed(1) + ' MB'
    }

    // Empty query values would reach the host as `cwd=` and be mistaken for a
    // path, so anything missing is dropped instead of serialized.
    function sidebarQuery(params) {
      const query = new URLSearchParams()
      for (const key of Object.keys(params)) {
        const value = params[key]
        if (value === undefined || value === null || value === '') continue
        query.set(key, String(value))
      }
      return query.toString()
    }

    function filesErrorText(error) {
      if (error === null || error === undefined) return ''
      return typeof error.message === 'string' && error.message !== '' ? error.message : String(error)
    }

    // ---------------------------------------------------------------------
    // Right sidebar: the workspace files panel.
    //
    // The wire format is better-sidebar's `/sidebar/api/*` one, served by this
    // plugin under `/remote-suite/sidebar/*`. This side only ever talks to that
    // own route, so the panel works for local, WSL, Docker and SSH workspaces
    // with the same code, and it does not require better-sidebar to be installed.
    // ---------------------------------------------------------------------

    const SIDEBAR_WATCH = '/remote-suite/sidebar/ws/fs-watch'
    const SF_IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp|svg|ico|avif)$/i
    const SF_AUDIO_RE = /\.(mp3|wav|ogg|m4a|flac)$/i
    const SF_ARCHIVE_RE = /\.(zip|gz|tgz|tar|7z|rar|bz2|xz)$/i
    const SF_CODE_RE = /\.(js|mjs|cjs|jsx|ts|tsx|json|css|scss|html|vue|py|rs|go|c|h|cc|cpp|hpp|java|kt|swift|rb|php|sh|ps1|bat|yml|yaml|toml|ini|cfg|sql|md|lua|dart|zig)$/i
    const SF_ZIP_MAX_FILES = 200
    const SF_ZIP_MAX_BYTES = 50 * 1024 * 1024

    /** Hue per file family, so a long listing is scanned by colour, not glyphs. */
    function sfIconTint(name, isDir) {
      if (isDir === true) return '#f0b429'
      if (SF_IMAGE_RE.test(name)) return '#e255a1'
      if (SF_AUDIO_RE.test(name)) return '#f0913a'
      if (SF_ARCHIVE_RE.test(name)) return '#a06bff'
      if (/\.(sh|bash|zsh|ps1|bat|cmd)$/i.test(name)) return '#2fb344'
      if (/\.(pdf|docx?|xlsx?|pptx?)$/i.test(name)) return '#e0574f'
      if (/\.(md|markdown|rst|txt)$/i.test(name)) return '#4a90e2'
      if (/\.(jsonc?|ya?ml|toml|ini|cfg|conf|env)$/i.test(name)) return '#b07cf0'
      if (SF_CODE_RE.test(name)) return '#4b8bf5'
      return '#9aa4b2'
    }

    /** A coloured glyph per entry: folders amber, pages tinted by file family. */
    function filesIcon(entry) {
      const tint = sfIconTint(entry.name, entry.isDir)
      const base = { width: 15, height: 15, viewBox: '0 0 16 16', 'aria-hidden': 'true' }
      if (entry.isDir === true) {
        return h(
          'svg',
          base,
          h('path', {
            d: 'M1.6 4.1c0-.7.6-1.2 1.2-1.2h3.1l1.4 1.7h6.1c.7 0 1.2.6 1.2 1.2v6.6c0 .7-.6 1.2-1.2 1.2H2.8c-.7 0-1.2-.5-1.2-1.2V4.1Z',
            fill: tint,
          }),
          h('path', { d: 'M1.6 6.2h12.8', stroke: 'rgba(0,0,0,0.16)', strokeWidth: 1 }),
        )
      }
      return h(
        'svg',
        base,
        h('path', {
          d: 'M3.3 1.7h5.9l3.5 3.4v9.2c0 .6-.5 1.1-1.1 1.1H3.3c-.6 0-1.1-.5-1.1-1.1V2.8c0-.6.5-1.1 1.1-1.1Z',
          fill: tint,
          fillOpacity: 0.18,
        }),
        h('path', {
          d: 'M3.3 1.7h5.9l3.5 3.4v9.2c0 .6-.5 1.1-1.1 1.1H3.3c-.6 0-1.1-.5-1.1-1.1V2.8c0-.6.5-1.1 1.1-1.1Z',
          stroke: tint,
          strokeWidth: 1,
        }),
        h('path', { d: 'M9.2 1.7v3.4h3.5', stroke: tint, strokeWidth: 1 }),
      )
    }

    let sfCrcTable = null

    /** CRC-32, needed by the (uncompressed) zip we build for folder downloads. */
    function sfCrc32(bytes) {
      if (sfCrcTable === null) {
        sfCrcTable = new Uint32Array(256)
        for (let n = 0; n < 256; n += 1) {
          let c = n
          for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
          sfCrcTable[n] = c >>> 0
        }
      }
      let crc = 0xffffffff
      for (let index = 0; index < bytes.length; index += 1) {
        crc = sfCrcTable[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8)
      }
      return (crc ^ 0xffffffff) >>> 0
    }

    /** Build a store-only zip in the browser; no library, no server round trip. */
    function sfZip(entries) {
      const encoder = new TextEncoder()
      const chunks = []
      const central = []
      let offset = 0
      const now = new Date()
      const time = ((now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2)) & 0xffff
      const date = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff
      for (const entry of entries) {
        const name = encoder.encode(entry.name)
        const data = entry.data instanceof Uint8Array ? entry.data : new Uint8Array(entry.data)
        const crc = sfCrc32(data)
        const local = new Uint8Array(30 + name.length)
        const view = new DataView(local.buffer)
        view.setUint32(0, 0x04034b50, true)
        view.setUint16(4, 20, true)
        view.setUint16(6, 0x0800, true)
        view.setUint16(8, 0, true)
        view.setUint16(10, time, true)
        view.setUint16(12, date, true)
        view.setUint32(14, crc, true)
        view.setUint32(18, data.length, true)
        view.setUint32(22, data.length, true)
        view.setUint16(26, name.length, true)
        view.setUint16(28, 0, true)
        local.set(name, 30)
        chunks.push(local, data)
        const header = new Uint8Array(46 + name.length)
        const hview = new DataView(header.buffer)
        hview.setUint32(0, 0x02014b50, true)
        hview.setUint16(4, 20, true)
        hview.setUint16(6, 20, true)
        hview.setUint16(8, 0x0800, true)
        hview.setUint16(10, 0, true)
        hview.setUint16(12, time, true)
        hview.setUint16(14, date, true)
        hview.setUint32(16, crc, true)
        hview.setUint32(20, data.length, true)
        hview.setUint32(24, data.length, true)
        hview.setUint16(28, name.length, true)
        hview.setUint32(42, offset, true)
        header.set(name, 46)
        central.push(header)
        offset += local.length + data.length
      }
      const centralSize = central.reduce((total, part) => total + part.length, 0)
      const end = new Uint8Array(22)
      const eview = new DataView(end.buffer)
      eview.setUint32(0, 0x06054b50, true)
      eview.setUint16(8, entries.length, true)
      eview.setUint16(10, entries.length, true)
      eview.setUint32(12, centralSize, true)
      eview.setUint32(16, offset, true)
      return new Blob([...chunks, ...central, end], { type: 'application/zip' })
    }

    function sfDownload(blob, name) {
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = name
      anchor.rel = 'noopener'
      document.body.appendChild(anchor)
      anchor.click()
      document.body.removeChild(anchor)
      setTimeout(() => URL.revokeObjectURL(url), 8000)
    }

    function FilesPanel(props) {
      useLocale()
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
      const cwd = sessionCwdOf(sessionId)
      const scope = React.useMemo(() => ({ sessionId, cwd }), [sessionId, cwd])
      const [root, setRoot] = React.useState('')
      const [dir, setDir] = React.useState('')
      const [rows, setRows] = React.useState([])
      const [truncated, setTruncated] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)
      const [doc, setDoc] = React.useState(null)
      const [text, setText] = React.useState('')
      const [dirty, setDirty] = React.useState(false)
      const [page, setPage] = React.useState(null)
      const [naming, setNaming] = React.useState(null)
      const [name, setName] = React.useState('')
      const [query, setQuery] = React.useState('')
      const [hits, setHits] = React.useState(null)
      const [selected, setSelected] = React.useState([])
      const [kids, setKids] = React.useState({})
      const [notice, setNotice] = React.useState(null)
      const [menu, setMenu] = React.useState(null)
      const [dropping, setDropping] = React.useState(false)
      const [findOpen, setFindOpen] = React.useState(false)
      const [findTerm, setFindTerm] = React.useState('')
      const [findHit, setFindHit] = React.useState(0)
      const dirRef = React.useRef('')
      const busyRef = React.useRef(false)
      const loadRef = React.useRef(null)
      const taRef = React.useRef(null)
      const hlRef = React.useRef(null)
      const gutterRef = React.useRef(null)
      const fileRef = React.useRef(null)

      dirRef.current = dir
      busyRef.current = busy

      /**
       * One level of the tree. `force` skips the host's 1.5 s listing cache so a
       * watch push can never be answered with the stale listing it invalidated.
       */
      /** A path as the prompt should see it: relative to the workspace root. */
      function referenceOf(path) {
        const base = root === '' ? '' : root.replace(/\/+$/, '')
        if (base !== '' && path.startsWith(base + '/')) return path.slice(base.length + 1)
        return path
      }

      async function insertAtReference(entry) {
        if (composerInsert(sessionId, '@' + referenceOf(entry.path))) {
          setNotice(tr('已把路径加入输入框'))
          return
        }
        try {
          await navigator.clipboard.writeText(entry.path)
          setNotice(tr('已复制路径'))
        } catch {
          setNotice(tr('无法写入输入框'))
        }
      }

      /** One inline level: the caret expands a directory without leaving this one. */
      async function toggleDir(entry) {
        if (kids[entry.path] !== undefined) {
          setKids((previous) => {
            const next = { ...previous }
            delete next[entry.path]
            return next
          })
          return
        }
        try {
          const value = await sidebarCall('fs.tree', Object.assign({}, scope, { path: entry.path }))
          const children = value.entries || []
          setKids((previous) => ({ ...previous, [entry.path]: children }))
        } catch (failure) {
          setError(filesErrorText(failure))
        }
      }

      React.useEffect(() => {
        if (notice === null) return undefined
        const id = setTimeout(() => setNotice(null), 2200)
        return () => clearTimeout(id)
      }, [notice])

      const load = React.useCallback(
        (path, force) =>
          sidebarCall(
            'fs.tree',
            Object.assign({}, scope, path === undefined ? {} : { path }, force === true ? { fresh: true } : {}),
          ).then(
            (value) => {
              setRoot((previous) => (previous === '' ? value.path : previous))
              if (path === undefined || path === value.path) setDir(value.path)
              setRows(value.entries || [])
              setKids({})
              setTruncated(value.truncated === true)
              setError(null)
              return value
            },
            (failure) => {
              setError(filesErrorText(failure))
              return null
            },
          ),
        [scope],
      )
      loadRef.current = load

      React.useEffect(() => {
        if (sessionId === '' && cwd === undefined) return undefined
        setDoc(null)
        setHits(null)
        setDirty(false)
        setSelected([])
        load(undefined)
        // Follow a session whose cwd changes (a new workspace opens, a session
        // switches target): re-root the tree instead of showing the old one.
        // The refresh below keeps the level in view: re-rooting every few
        // seconds would drag the reader back out of whatever directory they
        // opened.
        const timer = setInterval(() => {
          if (busyRef.current) return
          loadRef.current(dirRef.current || undefined, true)
        }, 5000)
        const onFocus = () => {
          if (busyRef.current) return
          loadRef.current(dirRef.current || undefined, true)
        }
        window.addEventListener('focus', onFocus)
        return () => {
          clearInterval(timer)
          window.removeEventListener('focus', onFocus)
        }
      }, [sessionId, cwd, load])

      // Live refresh: one socket, watching the level in view plus the workspace
      // root, so creating a file in a sibling directory still repaints the tree.
      React.useEffect(() => {
        if (sessionId === '' || typeof window.WebSocket !== 'function') return undefined
        let closed = false
        let socket = null
        let timer = null
        let tries = 0
        const watched = [dir, root].filter((value, index, all) => value !== '' && all.indexOf(value) === index)
        const connect = () => {
          socket = new WebSocket(socketUrl(SIDEBAR_WATCH) + '?sessionId=' + encodeURIComponent(sessionId))
          socket.onopen = () => {
            tries = 0
            for (const path of watched) socket.send(JSON.stringify({ op: 'watch', path }))
          }
          socket.onmessage = (event) => {
            let frame
            try {
              frame = JSON.parse(event.data)
            } catch {
              return
            }
            if (frame === null || typeof frame !== 'object' || frame.ok === false) return
            // `{dir, ok:true}` is the answer to a `watch` request, not a change
            // notification; repainting on it would bounce the reader back to the
            // directory the ack was for.
            if (frame.ok !== undefined) return
            if (typeof frame.dir !== 'string') return
            // Only the level in view is repainted: a change reported for the
            // workspace root (we watch it for sibling edits) must not navigate.
            if (frame.dir !== dirRef.current) return
            loadRef.current(frame.dir, true)
          }
          socket.onclose = () => {
            if (closed) return
            tries += 1
            timer = setTimeout(connect, Math.min(1000 * Math.pow(2, tries - 1), 15000))
          }
          socket.onerror = () => {
            try {
              socket.close()
            } catch {
              // Already closed.
            }
          }
        }
        connect()
        return () => {
          closed = true
          if (timer !== null) clearTimeout(timer)
          if (socket !== null) {
            try {
              socket.close()
            } catch {
              // Already closed.
            }
          }
        }
      }, [sessionId, dir, root])

      function guarded(promise) {
        setBusy(true)
        return promise.then(
          (value) => {
            setBusy(false)
            return value
          },
          (failure) => {
            setBusy(false)
            setError(filesErrorText(failure))
            return null
          },
        )
      }

      function enter(entry) {
        if (entry.isDir === true) {
          setHits(null)
          setDoc(null)
          setMenu(null)
          guarded(load(entry.path))
          return
        }
        open(entry.path)
      }

      function open(path) {
        setMenu(null)
        setDoc({ path, kind: 'text', size: 0, mtimeMs: 0 })
        setText('')
        setDirty(false)
        setPage(null)
        setFindOpen(false)
        setFindTerm('')
        guarded(
          sidebarCall('fs.read', Object.assign({ path }, scope)).then(
            (value) => {
              setDoc(Object.assign({ path }, value))
              setText(value.kind === 'text' ? value.content || '' : '')
              return value
            },
            (failure) => {
              setDoc(null)
              setError(filesErrorText(failure))
              return null
            },
          ),
        )
      }

      /** Append one 128 KiB page of a file that is too large for a full read. */
      function loadPage() {
        if (doc === null) return
        const offset = page === null ? 0 : page.nextOffset
        guarded(
          sidebarCall('fs.readPage', Object.assign({ path: doc.path, offset }, scope)).then((value) => {
            setText((previous) => (offset === 0 ? value.text : previous + value.text))
            setPage({ nextOffset: value.nextOffset, eof: value.eof === true })
            setDoc(Object.assign({}, doc, { kind: 'text', mtimeMs: value.mtimeMs, size: value.size }))
            return value
          }),
        )
      }

      function save() {
        if (doc === null || doc.kind !== 'text') return
        const url =
          SIDEBAR_BASE +
          '/write?' +
          sidebarQuery({
            sessionId,
            path: doc.path,
            expectedMtimeMs: doc.mtimeMs || 0,
            cwd,
          })
        guarded(
          fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'text/plain; charset=utf-8', 'x-remote-suite': '1' },
            body: text,
          })
            .then((res) =>
              res.json().then((parsed) => {
                if (parsed !== null && parsed.ok === true) return parsed.value
                const failure = new Error((parsed && parsed.error && parsed.error.message) || 'HTTP ' + res.status)
                failure.code = (parsed && parsed.error && parsed.error.code) || 'internal'
                throw failure
              }),
            )
            .then((value) => {
              setDirty(false)
              setDoc(Object.assign({}, doc, { mtimeMs: value && value.mtimeMs ? value.mtimeMs : doc.mtimeMs }))
              return value
            }),
        )
      }

      function change(method, payload) {
        return guarded(
          sidebarCall(method, Object.assign({}, payload, scope)).then((value) => {
            if (payload && payload.path !== undefined && payload.path === (doc && doc.path)) setDoc(null)
            return load(dirRef.current, true).then(() => value)
          }),
        )
      }

      function submitName() {
        const wanted = name.trim()
        if (naming === null || wanted === '') return
        const done = () => {
          setNaming(null)
          setName('')
        }
        if (naming.kind === 'file') change('fs.createFile', { path: dir, name: wanted }).then(done, done)
        else if (naming.kind === 'dir') change('fs.mkdir', { path: dir, name: wanted }).then(done, done)
        else if (naming.kind === 'rename' && naming.entry !== undefined)
          change('fs.rename', { path: naming.entry.path, name: wanted }).then(done, done)
        else if (naming.kind === 'rename' && doc !== null)
          change('fs.rename', { path: doc.path, name: wanted }).then(done, done)
      }

      function removePaths(paths) {
        let chain = Promise.resolve()
        for (const path of paths) chain = chain.then(() => guarded(sidebarCall('fs.remove', Object.assign({ path }, scope))))
        return chain.then(() => {
          setSelected([])
          setDoc(null)
          setText('')
          setDirty(false)
          return load(dirRef.current, true)
        })
      }

      function search() {
        const wanted = query.trim()
        if (wanted === '') {
          setHits(null)
          return
        }
        guarded(
          sidebarCall('fs.search', Object.assign({ query: wanted }, scope)).then((value) => {
            setHits(value)
            return value
          }),
        )
      }

      function openHit(relative) {
        const absolute = relative.charAt(0) === '/' || /^[A-Za-z]:/.test(relative) ? relative : filesJoin(root, relative)
        open(absolute)
      }

      function fileUrl(path) {
        return SIDEBAR_BASE + '/file?' + sidebarQuery({ sessionId, path, cwd })
      }

      function downloadFile(path, suggested) {
        const anchor = document.createElement('a')
        anchor.href = fileUrl(path)
        anchor.download = suggested || filesBaseName(path)
        anchor.rel = 'noopener'
        document.body.appendChild(anchor)
        anchor.click()
        document.body.removeChild(anchor)
      }

      /** Walk a directory over the same API, then hand the browser a .zip. */
      function downloadFolder(entry) {
        const queue = [{ path: entry.path, base: entry.name }]
        const files = []
        const walk = () => {
          if (queue.length === 0 || files.length >= SF_ZIP_MAX_FILES) return Promise.resolve()
          const item = queue.shift()
          return sidebarCall('fs.tree', Object.assign({ path: item.path, fresh: true }, scope)).then((level) => {
            for (const row of level.entries || []) {
              if (row.isDir === true) queue.push({ path: row.path, base: item.base + '/' + row.name })
              else files.push({ path: row.path, name: item.base + '/' + row.name })
            }
            return walk()
          })
        }
        return guarded(
          walk()
            .then(async () => {
              const parts = []
              let total = 0
              for (const file of files) {
                if (total >= SF_ZIP_MAX_BYTES) break
                const res = await fetch(fileUrl(file.path), { headers: { 'x-remote-suite': '1' }, credentials: 'same-origin' })
                if (!res.ok) continue
                const bytes = new Uint8Array(await res.arrayBuffer())
                total += bytes.length
                parts.push({ name: file.name, data: bytes })
              }
              if (parts.length === 0) throw new Error(tr('这个目录里没有可以下载的文件'))
              sfDownload(sfZip(parts), entry.name + '.zip')
              return parts.length
            })
            .catch((failure) => {
              setError(filesErrorText(failure))
              return null
            }),
        )
      }

      function uploadFiles(fileList) {
        const files = Array.from(fileList || [])
        if (files.length === 0) return
        const target = dirRef.current
        let chain = Promise.resolve()
        for (const file of files) {
          chain = chain.then(() =>
            guarded(
              fetch(
                SIDEBAR_BASE +
                  '/upload?' +
                  sidebarQuery({ sessionId, cwd, dir: target, relativePath: file.name }),
                { method: 'POST', headers: { 'x-remote-suite': '1' }, body: file },
              ).then((res) =>
                res.json().then((parsed) => {
                  if (parsed !== null && parsed.ok === true) return parsed.value
                  const failure = new Error((parsed && parsed.error && parsed.error.message) || 'HTTP ' + res.status)
                  failure.code = (parsed && parsed.error && parsed.error.code) || 'internal'
                  throw failure
                }),
              ),
            ),
          )
        }
        chain.then(() => load(target, true))
      }

      function selectRow(entry, event) {
        const additive = event && (event.ctrlKey || event.metaKey)
        const range = event && event.shiftKey
        if (range && selected.length > 0) {
          const from = rows.findIndex((row) => row.path === selected[selected.length - 1])
          const to = rows.findIndex((row) => row.path === entry.path)
          if (from !== -1 && to !== -1) {
            const span = rows.slice(Math.min(from, to), Math.max(from, to) + 1).map((row) => row.path)
            setSelected(span)
            return
          }
        }
        if (additive) {
          setSelected((previous) =>
            previous.indexOf(entry.path) === -1 ? previous.concat(entry.path) : previous.filter((path) => path !== entry.path),
          )
          return
        }
        setSelected([entry.path])
      }

      function openMenu(event, entry) {
        event.preventDefault()
        if (entry !== undefined && selected.indexOf(entry.path) === -1) setSelected([entry.path])
        setMenu({ x: event.clientX, y: event.clientY, entry })
      }

      // --- editor plumbing -------------------------------------------------
      const lineCount = React.useMemo(() => text.split('\n').length, [text])
      const html = React.useMemo(() => highlight(text), [text])
      const findMatches = React.useMemo(() => {
        const term = findTerm.trim()
        if (term === '' || text === '') return []
        const found = []
        const haystack = text.toLowerCase()
        const needle = term.toLowerCase()
        let at = haystack.indexOf(needle)
        while (at !== -1 && found.length < 500) {
          found.push(at)
          at = haystack.indexOf(needle, at + Math.max(1, needle.length))
        }
        return found
      }, [text, findTerm])

      const syncScroll = () => {
        const ta = taRef.current
        if (ta === null) return
        if (hlRef.current !== null) {
          hlRef.current.scrollTop = ta.scrollTop
          hlRef.current.scrollLeft = ta.scrollLeft
        }
        if (gutterRef.current !== null) gutterRef.current.scrollTop = ta.scrollTop
      }

      function jumpToFind(step) {
        if (findMatches.length === 0 || taRef.current === null) return
        const next = (findHit + step + findMatches.length) % findMatches.length
        setFindHit(next)
        const at = findMatches[next]
        taRef.current.focus()
        taRef.current.setSelectionRange(at, at + findTerm.trim().length)
      }

      // --- pieces ------------------------------------------------------------
      const toolbar = h(
        'div',
        { className: 'rs-sf-bar' },
        h(
          'button',
          {
            className: 'rs-sf-btn',
            title: tr('上一级'),
            disabled: dir === '' || dir === root,
            onClick: () => {
              if (dir === '' || dir === root) return
              setHits(null)
              guarded(load(filesParent(dir)))
            },
          },
          '↑',
        ),
        h('span', { className: 'rs-sf-crumbs', title: dir }, dir === '' ? '…' : dir),
        h('button', { className: 'rs-sf-btn', title: tr('刷新'), onClick: () => guarded(load(dir, true)) }, tr('刷新')),
        h('button', { className: 'rs-sf-btn', title: tr('上传文件'), onClick: () => fileRef.current && fileRef.current.click() }, tr('上传')),
        h('button', { className: 'rs-sf-btn', onClick: () => { setNaming({ kind: 'file' }); setName('') } }, tr('新建文件')),
        h('button', { className: 'rs-sf-btn', onClick: () => { setNaming({ kind: 'dir' }); setName('') } }, tr('新建目录')),
        selected.length > 0
          ? h(
              'button',
              { className: 'rs-sf-btn', onClick: () => removePaths(selected), disabled: busy },
              tr('删除选中') + ' ' + selected.length,
            )
          : null,
        h('input', {
          ref: fileRef,
          type: 'file',
          multiple: true,
          style: { display: 'none' },
          onChange: (event) => {
            uploadFiles(event.target.files)
            event.target.value = ''
          },
        }),
      )

      const searchBar = h(
        'div',
        { className: 'rs-sf-bar' },
        h('input', {
          className: 'rs-sf-input',
          placeholder: tr('搜索文件名与内容，回车开始'),
          value: query,
          onChange: (event) => setQuery(event.target.value),
          onKeyDown: (event) => {
            if (event.key === 'Enter') search()
            if (event.key === 'Escape') {
              setQuery('')
              setHits(null)
            }
          },
        }),
        h('button', { className: 'rs-sf-btn', onClick: search, disabled: busy }, tr('搜索')),
      )

      const nameBar =
        naming === null
          ? null
          : h(
              'div',
              { className: 'rs-sf-bar' },
              h('span', { className: 'rs-sf-crumbs' }, naming.kind === 'rename' ? tr('新名字') : tr('名称')),
              h('input', {
                className: 'rs-sf-input',
                autoFocus: true,
                value: name,
                placeholder: naming.kind === 'dir' ? tr('新目录名') : tr('新文件名'),
                onChange: (event) => setName(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') submitName()
                  if (event.key === 'Escape') setNaming(null)
                },
              }),
              h('button', { className: 'rs-sf-btn', onClick: submitName }, tr('确定')),
              h('button', { className: 'rs-sf-btn', onClick: () => setNaming(null) }, tr('取消')),
            )

      const findBar = findOpen
        ? h(
            'div',
            { className: 'rs-sf-find' },
            h('input', {
              className: 'rs-sf-input',
              autoFocus: true,
              placeholder: tr('查找，回车跳到下一个'),
              value: findTerm,
              onChange: (event) => {
                setFindTerm(event.target.value)
                setFindHit(0)
              },
              onKeyDown: (event) => {
                if (event.key === 'Enter') jumpToFind(event.shiftKey ? -1 : 1)
                if (event.key === 'Escape') setFindOpen(false)
              },
            }),
            h('span', { className: 'rs-sf-meta' }, findMatches.length === 0 ? tr('无匹配') : `${findHit + 1}/${findMatches.length}`),
            h('button', { className: 'rs-sf-btn', onClick: () => jumpToFind(-1) }, tr('上一个')),
            h('button', { className: 'rs-sf-btn', onClick: () => jumpToFind(1) }, tr('下一个')),
            h('button', { className: 'rs-sf-btn', onClick: () => setFindOpen(false) }, '×'),
          )
        : null

      const body = (() => {
        if (doc !== null) {
          const isText = doc.kind === 'text'
          if (!isText) {
            const isImage = SF_IMAGE_RE.test(doc.path)
            const isAudio = SF_AUDIO_RE.test(doc.path)
            const url = fileUrl(doc.path)
            return h(
              'div',
              { className: 'rs-sf-editor' },
              h(
                'div',
                { className: 'rs-sf-bar' },
                h('span', { className: 'rs-sf-crumbs', title: doc.path }, filesBaseName(doc.path)),
                h('span', { className: 'rs-sf-meta' }, filesBytes(doc.size)),
                h('button', { className: 'rs-sf-btn', onClick: () => downloadFile(doc.path) }, tr('下载')),
                doc.kind === 'too-large'
                  ? h('button', { className: 'rs-sf-btn', onClick: loadPage }, tr('分页查看'))
                  : null,
                h('button', { className: 'rs-sf-btn', onClick: () => setDoc(null) }, tr('关闭')),
              ),
              isImage
                ? h('div', { className: 'rs-sf-image' }, h('img', { src: url, alt: filesBaseName(doc.path) }))
                : isAudio
                  ? h('div', { className: 'rs-sf-image' }, h('audio', { src: url, controls: true }))
                  : h(
                      'div',
                      { className: 'rs-sf-empty' },
                      doc.kind === 'too-large' ? tr('文件过大。点「分页查看」逐页读取，或直接下载。') : tr('二进制文件，无法以文本编辑'),
                    ),
            )
          }
          const gutter = []
          for (let n = 1; n <= lineCount; n += 1) gutter.push(n)
          return h(
            'div',
            { className: 'rs-sf-editor' },
            h(
              'div',
              { className: 'rs-sf-bar' },
              h('span', { className: 'rs-sf-crumbs', title: doc.path }, filesBaseName(doc.path)),
              h('span', { className: 'rs-sf-meta' }, dirty ? tr('已修改') : filesBytes(doc.size)),
              h('button', { className: 'rs-sf-btn', onClick: save, disabled: busy || dirty === false }, tr('保存')),
              h('button', { className: 'rs-sf-btn', onClick: () => downloadFile(doc.path) }, tr('下载')),
              h('button', { className: 'rs-sf-btn', onClick: () => setFindOpen((previous) => !previous) }, tr('查找')),
              h(
                'button',
                {
                  className: 'rs-sf-btn',
                  onClick: () => {
                    setNaming({ kind: 'rename' })
                    setName(filesBaseName(doc.path))
                  },
                },
                tr('改名'),
              ),
              h('button', { className: 'rs-sf-btn', onClick: () => removePaths([doc.path]), disabled: busy }, tr('删除')),
              h('button', { className: 'rs-sf-btn', onClick: () => setDoc(null) }, tr('关闭')),
              page !== null && page.eof !== true
                ? h('button', { className: 'rs-sf-btn', onClick: loadPage }, tr('加载更多'))
                : null,
            ),
            findBar,
            h(
              'div',
              { className: 'rs-code-wrap rs-sf-codewrap' },
              h('div', { className: 'rs-gutter', ref: gutterRef }, gutter.join('\n')),
              h(
                'div',
                { className: 'rs-code-scroll' },
                h('pre', {
                  className: 'rs-code-hl',
                  ref: hlRef,
                  'aria-hidden': true,
                  dangerouslySetInnerHTML: { __html: html + '\n' },
                }),
                h('textarea', {
                  className: 'rs-code-ta',
                  ref: taRef,
                  value: text,
                  spellCheck: false,
                  wrap: 'off',
                  onChange: (event) => {
                    setText(event.target.value)
                    setDirty(true)
                  },
                  onScroll: syncScroll,
                  onKeyDown: (event) => {
                    if ((event.ctrlKey || event.metaKey) && event.key === 's') {
                      event.preventDefault()
                      save()
                    }
                    if ((event.ctrlKey || event.metaKey) && event.key === 'f') {
                      event.preventDefault()
                      setFindOpen(true)
                    }
                    if (event.key === 'Tab') {
                      event.preventDefault()
                      const ta = event.target
                      const start = ta.selectionStart
                      const end = ta.selectionEnd
                      const next = text.slice(0, start) + '  ' + text.slice(end)
                      setText(next)
                      setDirty(true)
                      requestAnimationFrame(() => {
                        if (taRef.current !== null) {
                          taRef.current.selectionStart = start + 2
                          taRef.current.selectionEnd = start + 2
                        }
                      })
                    }
                  },
                }),
              ),
            ),
            h(
              'div',
              { className: 'rs-sf-meta rs-sf-status' },
              statusLine(lineCount, text.length, dirty),
            ),
          )
        }
        if (hits !== null) {
          const list = (hits.matches || []).map((relative, index) =>
            h(
              'div',
              { key: 'hit-' + index, className: 'rs-sf-row', onClick: () => openHit(relative) },
              h('span', { className: 'rs-sf-icon' }, '·'),
              h('span', { className: 'rs-sf-name', title: relative }, relative),
            ),
          )
          return h(
            'div',
            { className: 'rs-sf-list' },
            list.length === 0 ? h('div', { className: 'rs-sf-empty' }, tr('没有匹配的文件')) : null,
            list,
            hits.truncated === true ? h('div', { className: 'rs-sf-empty' }, tr('结果已截断')) : null,
          )
        }
        if (rows.length === 0) {
          return h('div', { className: 'rs-sf-list' }, h('div', { className: 'rs-sf-empty' }, busy ? tr('加载中…') : tr('空目录')))
        }
        const renderRow = (entry, depth) =>
          h(
            'div',
            {
              key: entry.path,
              className: 'rs-sf-row' + (selected.indexOf(entry.path) === -1 ? '' : ' is-sel'),
              title: entry.path,
              style: depth === 0 ? undefined : { paddingLeft: 8 + depth * 14 },
              onClick: (event) => {
                if (event.ctrlKey || event.metaKey || event.shiftKey) {
                  selectRow(entry, event)
                  return
                }
                setSelected([entry.path])
                // A directory only unfolds in place: the listing stays where it
                // is, so the tree reads as one surface instead of a stack of
                // screens. Use the context menu to make a directory the root.
                if (entry.isDir === true) toggleDir(entry)
                else enter(entry)
              },
              onContextMenu: (event) => openMenu(event, entry),
            },
            entry.isDir === true
              ? h(
                  'span',
                  {
                    className: 'rs-sf-caret' + (kids[entry.path] === undefined ? '' : ' is-open'),
                    title: tr('展开或收起'),
                    onClick: (event) => {
                      event.stopPropagation()
                      toggleDir(entry)
                    },
                  },
                  h(
                    'svg',
                    { width: 16, height: 16, viewBox: '0 0 16 16', 'aria-hidden': 'true' },
                    h('path', {
                      d: 'M6.2 3.4 10.8 8l-4.6 4.6',
                      fill: 'none',
                      stroke: 'currentColor',
                      strokeWidth: 2,
                      strokeLinecap: 'round',
                      strokeLinejoin: 'round',
                    }),
                  ),
                )
              : h('span', { className: 'rs-sf-caret is-leaf' }),
            h('span', { className: 'rs-sf-icon' }, filesIcon(entry)),
            h('span', { className: 'rs-sf-name' + (entry.name.charAt(0) === '.' ? ' is-hidden' : '') }, entry.name),
            entry.isDir === true ? null : h('span', { className: 'rs-sf-meta' }, filesBytes(entry.size)),
            h(
              'button',
              {
                className: 'rs-sf-at',
                title: tr('把路径加入输入框'),
                onClick: (event) => {
                  event.stopPropagation()
                  insertAtReference(entry)
                },
              },
              '@',
            ),
          )

        const renderTree = (entries, depth) => {
          const out = []
          for (const entry of entries) {
            out.push(renderRow(entry, depth))
            const children = kids[entry.path]
            if (children !== undefined && children.length > 0) {
              for (const node of renderTree(children, depth + 1)) out.push(node)
            }
          }
          return out
        }
        const list = renderTree(rows, 0)
        return h(
          'div',
          { className: 'rs-sf-list' },
          list,
          truncated === true ? h('div', { className: 'rs-sf-empty' }, tr('目录项过多，已截断')) : null,
        )
      })()

      const menuNode =
        menu === null
          ? null
          : h(
              'div',
              {
                className: 'rs-sf-menu',
                style: { left: Math.max(8, menu.x - 140), top: menu.y },
                onMouseLeave: () => setMenu(null),
              },
              menu.entry === undefined
                ? null
                : [
                    h('button', { key: 'open', className: 'rs-sf-menuitem', onClick: () => enter(menu.entry) }, menu.entry.isDir ? tr('打开目录') : tr('打开')),
                    h(
                      'button',
                      {
                        key: 'rename',
                        className: 'rs-sf-menuitem',
                        onClick: () => {
                          setNaming({ kind: 'rename', entry: menu.entry })
                          setName(menu.entry.name)
                          setMenu(null)
                        },
                      },
                      tr('重命名'),
                    ),
                    h(
                      'button',
                      {
                        key: 'download',
                        className: 'rs-sf-menuitem',
                        onClick: () => {
                          if (menu.entry.isDir === true) downloadFolder(menu.entry)
                          else downloadFile(menu.entry.path, menu.entry.name)
                          setMenu(null)
                        },
                      },
                      menu.entry.isDir === true ? tr('下载为 zip') : tr('下载'),
                    ),
                    h(
                      'button',
                      {
                        key: 'copy',
                        className: 'rs-sf-menuitem',
                        onClick: () => {
                          if (navigator.clipboard && navigator.clipboard.writeText) {
                            navigator.clipboard.writeText(menu.entry.path).catch(() => {})
                          }
                          setMenu(null)
                        },
                      },
                      tr('复制路径'),
                    ),
                    h(
                      'button',
                      {
                        key: 'remove',
                        className: 'rs-sf-menuitem is-danger',
                        onClick: () => {
                          const paths = selected.indexOf(menu.entry.path) === -1 ? [menu.entry.path] : selected
                          removePaths(paths)
                          setMenu(null)
                        },
                      },
                      tr('删除'),
                    ),
                  ],
            )

      return h(
        'div',
        {
          className: 'rs-sf' + (dropping ? ' is-drop' : ''),
          onDragOver: (event) => {
            if (event.dataTransfer && Array.from(event.dataTransfer.types || []).indexOf('Files') !== -1) {
              event.preventDefault()
              setDropping(true)
            }
          },
          onDragLeave: () => setDropping(false),
          onDrop: (event) => {
            if (event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files.length > 0) {
              event.preventDefault()
              uploadFiles(event.dataTransfer.files)
            }
            setDropping(false)
          },
          onKeyDown: (event) => {
            if (event.key === 'Escape') {
              setMenu(null)
              setFindOpen(false)
            }
            if (event.key === 'Delete' && selected.length > 0 && doc === null) removePaths(selected)
          },
          tabIndex: -1,
        },
        searchBar,
        toolbar,
        nameBar,
        notice === null ? null : h('div', { className: 'rs-sf-notice' }, notice),
          error === null ? null : h('div', { className: 'rs-sf-err' }, error),
        body,
        dropping ? h('div', { className: 'rs-sf-drop' }, tr('松开即可上传到当前目录')) : null,
        menuNode,
      )
    }

    // The native guide row renders `entry.icon` and hands it `{ size }`; without
    // one our takeover is the only row in the list with a blank leading slot.
    function filesGuideIcon(props) {
      const size = (props && typeof props.size === 'number' && props.size > 0) ? props.size : 16
      const FileTypeIcon = primitives.FileTypeIcon
      // better-sidebar wraps the glyph in `span.files`, whose rule is
      // `color: var(--dsw-alias-brand-primary, var(--dsw-alias-label-primary))`.
      // We cannot import its CSS module, so apply the same token inline.
      const brand = { color: 'var(--dsw-alias-brand-primary, var(--dsw-alias-label-primary))' }
      if (typeof FileTypeIcon === 'function') {
        return h('span', { style: brand }, h(FileTypeIcon, { kind: 'folder', size }))
      }
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 16 16', 'aria-hidden': 'true', fill: 'none' },
        h('path', {
          d: 'M1.75 3.5h4.1l1.3 1.5h7.1v7.5H1.75V3.5Z',
          stroke: 'currentColor',
          strokeWidth: 1.2,
          strokeLinejoin: 'round',
        }),
      )
    }
    /** The plugin ctx, captured in apply(); the composer bridge needs it. */
    let appCtx = null

    /**
     * Append a reference to the session's composer draft — the same "put this
     * file in the prompt" gesture better-sidebar offers. Returns false when the
     * host exposes no usable composer, so the caller can fall back to clipboard.
     */
    function composerInsert(sessionId, text) {
      const ctx = appCtx
      if (ctx === null || ctx === undefined) return false
      try {
        const scoped = typeof ctx.sessions?.scope === 'function' ? ctx.sessions.scope(sessionId) : undefined
        const conversation = typeof ctx.get === 'function' ? ctx.get('conversation') : undefined
        if (scoped === undefined || conversation === undefined) return false
        const input = conversation.input.for(scoped)
        const snapshot = input.state.getSnapshot()
        const draft = typeof snapshot.draft === 'string' ? snapshot.draft : ''
        const gap = draft === '' || /\s$/.test(draft) ? '' : ' '
        input.setDraft(draft + gap + text + ' ')
        return true
      } catch (error) {
        console.warn('[dsh-remote-suite] 无法写入输入框:', error)
        return false
      }
    }


    /**
     * Copy for the files panel and its sidebar entry.
     *
     * The panel takes over the Host's own file pane, so it speaks the same two
     * languages dsh-better-sidebar does: Chinese when the DSH locale is Chinese,
     * English otherwise (browser language when no locale service is attached,
     * e.g. in tests). Entries are keyed by the Chinese literal, so a missing
     * translation falls back to the original text instead of a bare key.
     */
    const EN_COPY = {
      "当前：dsh-better-sidebar 的面板（数据由本插件提供）": "Now: dsh-better-sidebar's pane (data served by this plugin)",
      "终端资源加载失败：{detail}\n请确认已刷新页面以加载最新插件。": "The terminal failed to load: {detail}\nReload the page to pick up the latest plugin.",
      "已粘贴 {count} 个字符": "Pasted {count} characters",
      "[已为工作区 {cwd} 启动常驻终端；切走后它继续运行]": "[Resident terminal started for {cwd}; it keeps running when you switch away]",
      "后台终端：{count}": "Terminals: {count}",
      "已复制 {count} 个字符": "Copied {count} characters",
      "选择本工作区终端使用的 shell（默认 shell / Windows:cmd / Windows:PowerShell / WSL / SSH）": "Shell used by terminals in this workspace (default shell / Windows:cmd / Windows:PowerShell / WSL / SSH)",
      "三个开关互相独立、可同时打开；Ctrl+C 只在有选中内容时复制，读取剪贴板需 localhost 或 HTTPS": "The three switches are independent and may all be on; Ctrl+C copies only when something is selected, and reading the clipboard needs localhost or HTTPS",
      "有选中内容时 Ctrl+C（macOS 上 Cmd+C）复制选中文本；没有选中时仍然发送 ^C 中断命令": "With a selection, Ctrl+C (Cmd+C on macOS) copies it; with nothing selected it still sends ^C to interrupt",
      "在终端里点右键直接粘贴剪贴板内容（读取剪贴板需要 localhost 或 HTTPS）": "Right-click in the terminal pastes the clipboard directly (reading the clipboard needs localhost or HTTPS)",
      "当前为浮层：终端盖在 DSH 上。点击改为并排（DSH 让出空间）": "Floating now: the terminal covers DSH. Click to dock side by side (DSH makes room)",
      "当前为并排：DSH 让出右侧空间。点击改为浮层覆盖": "Docked now: DSH makes room on the right. Click to float over it",
      "此环境不允许读取剪贴板，请用 Ctrl+V 粘贴": "This environment does not allow reading the clipboard; paste with Ctrl+V",
      "提示显示在终端面板左下角（不挡输入行右侧）": "Toast at the bottom-left of the panel, clear of the input line",
      "查看和关闭本环境的后台终端（包含当前终端）": "See and close this environment's background terminals, including the current one",
      "提示出现在鼠标位置上方，不占用终端画面": "Toast follows the pointer, off the terminal screen",
      "鼠标松开、选择停稳后自动复制选中文本": "Copies the selection once the mouse is released and the selection settles",
      "addon-fit.js 加载失败": "addon-fit.js failed to load",
      "无法连接终端后端，3 秒后重试…": "Cannot reach the terminal backend; retrying in 3 seconds…",
      "复制失败：浏览器拒绝了剪贴板写入": "Copy failed: the browser refused the clipboard write",
      "连接已断开，3 秒后自动重连…": "Connection lost; reconnecting in 3 seconds…",
      "重新连接当前工作区的 PTY": "Reconnect this workspace's PTY",
      "提示显示在终端面板底部中央": "Toast at the bottom centre of the panel",
      "xterm.js 加载失败": "xterm.js failed to load",
      "当前为暗色。点击切换为浅色": "Dark theme. Click for the light one",
      "当前为浅色。点击切换为暗色": "Light theme. Click for the dark one",
      "提示显示在工具条下方居中": "Toast centred below the toolbar",
      "复制/粘贴后不弹任何提示": "No toast after copying or pasting",
      "收起终端（Ctrl+`）": "Collapse the terminal (Ctrl+`)",
      "打开终端（Ctrl+`）": "Open the terminal (Ctrl+`)",
      "清屏（仅当前工作区）": "Clear (this workspace only)",
      "Ctrl+C 复制": "Ctrl+C copies",
      "复制/粘贴设置": "Copy and paste settings",
      "(默认目录)": "(default directory)",
      "终端启动失败": "The terminal failed to start",
      "关闭其他终端": "Close other terminals",
      "拖动调整宽度": "Drag to resize",
      "选中即复制": "Copy on select",
      "复制/粘贴": "Copy and paste",
      "底部居中": "Bottom centre",
      "底部靠左": "Bottom left",
      "顶部居中": "Top centre",
      "跟随鼠标": "Follow the pointer",
      "关闭提示": "Hide toasts",
      "右键粘贴": "Right-click pastes",
      "连接失败": "Connection failed",
      "连接中…": "Connecting…",
      "（当前）": " (current)",
      "提示位置": "Toast position",
      "已连接": "Connected",
      "暗色": "Dark",
      "浅色": "Light",
      "复制": "Copy",
      "清屏": "Clear",
      "重连": "Reconnect",
      "并排": "Dock",
      "浮层": "Float",
      "收起": "Collapse",
      "文件": "Files",
      "保存": "Save",
      "查找": "Find",
      "查找，回车跳到下一个": "Find; Enter jumps to the next match",
      "打开": "Open",
      "打开目录": "Open folder",
      "二进制文件，无法以文本编辑": "Binary file, cannot edit as text",
      "分页查看": "Page view",
      "复制路径": "Copy path",
      "改名": "Rename",
      "关闭": "Close",
      "加载更多": "Load more",
      "加载中…": "Loading...",
      "结果已截断": "Results truncated",
      "空目录": "Empty folder",
      "没有匹配的文件": "No matching files",
      "名称": "Name",
      "目录项过多，已截断": "Too many entries, truncated",
      "取消": "Cancel",
      "确定": "OK",
      "删除": "Delete",
      "上传": "Upload",
      "上传文件": "Upload files",
      "上一个": "Previous",
      "上一级": "Up",
      "刷新": "Refresh",
      "松开即可上传到当前目录": "Drop to upload into this folder",
      "搜索": "Search",
      "搜索文件名与内容，回车开始": "Search names and contents, Enter to start",
      "文件过大。点「分页查看」逐页读取，或直接下载。": "The file is large. Use \"Page view\" to read it page by page, or download it.",
      "无匹配": "No matches",
      "下一个": "Next",
      "下载": "Download",
      "下载为 zip": "Download as .zip",
      "新建目录": "New folder",
      "新建文件": "New file",
      "新名字": "New name",
      "新目录名": "New folder name",
      "新文件名": "New file name",
      "已保存": "Saved",
      "已修改": "Unsaved",
      "这个目录里没有可以下载的文件": "This folder has nothing to download",
      "重命名": "Rename",
      "浏览工作区文件树，点开即预览或编辑": "Browse the workspace files; open one to preview or edit it.",
      "已把路径加入输入框": "Added the path to the prompt",
      "已复制路径": "Copied the path",
      "无法写入输入框": "Could not reach the prompt",
      "把路径加入输入框": "Put this path in the prompt",
      "展开或收起": "Expand or collapse",
      "终端": "Terminal",
      "新建终端": "New terminal",
      "在会话工作区运行命令": "Run commands in the session workspace",
      "接管设置": "Pane takeover",
      "接管工作区文件": "Take over the file pane",
      "接管终端": "Take over the terminal pane",
      "本机 / WSL / SSH / Docker": "This machine / WSL / SSH / Docker",
      "cmd / PowerShell / WSL / SSH": "cmd / PowerShell / WSL / SSH",
      "删除选中": "Delete selected",
      "当前：本插件接管": "Now: handled by this plugin",
      "当前：DSH 自带": "Now: DSH's own pane",
      "当前：{name} 接管": "Now: handled by {name}",
      "改动立即生效，不需要重启。": "Changes apply immediately; no restart needed.",
    }

    /** The DSH locale service, attached by attachLocale() from apply(). */
    let localeService

    function attachLocale(service) {
      localeService = service === null || service === undefined ? undefined : service
    }

    /** The active locale id: the Host's preference first, then the browser's. */
    function activeLocale() {
      try {
        const active = localeService?.getSnapshot?.().active
        if (typeof active === 'string' && active !== '') return active
      } catch {
        // No service, or one that cannot answer: fall through.
      }
      const language = typeof navigator !== 'undefined' && navigator !== null ? navigator.language : ''
      return typeof language === 'string' ? language : ''
    }

    /** Whether the interface is Chinese (the same rule better-sidebar uses). */
    function isZh() {
      return activeLocale().toLowerCase().startsWith('zh')
    }

    /** Translate panel copy; {name} placeholders are interpolated when given. */
    function tr(text, params) {
      let out = isZh() ? text : EN_COPY[text] ?? text
      if (params !== undefined) {
        for (const [name, value] of Object.entries(params)) out = out.replaceAll('{' + name + '}', String(value))
      }
      return out
    }

    /** The editor status line, in the active language. */
    function statusLine(lines, chars, dirty) {
      return isZh()
        ? lines + ' 行 · ' + chars + ' 字符 · ' + (dirty ? '未保存' : '已保存')
        : lines + ' lines · ' + chars + ' chars · ' + (dirty ? 'Unsaved' : 'Saved')
    }

    /** A value that changes with the locale, for useSyncExternalStore. */
    function localeKey() {
      return activeLocale()
    }

    function subscribeLocale(onChange) {
      try {
        if (typeof localeService?.subscribe === 'function') return localeService.subscribe(onChange)
      } catch {
        // Without the service the language cannot change at runtime.
      }
      return () => {}
    }

    /** Re-render the caller when the interface language switches. */
    function useLocale() {
      return React.useSyncExternalStore(subscribeLocale, localeKey, localeKey)
    }

    // ---------------------------------------------------------------------
    // Terminal panel, merged from @lylgj/dsh-terminal.
    //
    // The bundle below is that plugin's client half, kept verbatim apart from
    // the route prefix, the helper port and the session-storage key so it
    // cannot collide with the original package when both are installed. It is
    // wrapped instead of copied into the factory scope so its module-local
    // names (apply, inject, react, ...) stay out of this file's namespace.
    // ---------------------------------------------------------------------
    const remoteTerminal = (function () {
      var module = { exports: {} };
      var exports = module.exports;
		const react = require("react");
		const h = react.createElement;

		// react-dom 用于把面板挂到 body：并排模式下必须脱离 AppFrame 的 overflow:hidden。
		let reactDom = null;
		try {
			reactDom = require("react-dom");
		} catch {
			reactDom = null;
		}

		//#region 常量
		/** 宿主半边提供的同源路由。 */
		const ASSET_BASE = "/remote-suite/assets";
		const WS_PATH = "/remote-suite/terminal/ws";
		const INFO_PATH = "/remote-suite/terminal/info";

		/**
		 * 独立终端进程的默认端口（与 lib/helper.js、lib/index.js 保持一致）。
		 *
		 * 终端优先直连这个进程：它的事件循环只服务 PTY，不像 dsh 主进程那样会被
		 * 逐 token 流式解析、会话投影、zstd 压缩落盘与 GC 占满（实测主进程在重载下
		 * 最坏 20 秒无响应、按键最坏 5 秒无回显）。可用 localStorage 覆盖，方便
		 * 浏览器通过端口转发访问时指向别的端口。
		 */
		const HELPER_DEFAULT_PORT = 3111;
		const HELPER_PORT_KEY = "remote-suite-terminal-port";

		/**
		 * DSH 官方右侧栏（@deepseek-ai/dsh-client-ui-sidebar-right）的服务名。
		 *
		 * 官方侧栏是 DSH 自带的右侧栏页签系统：主态是「官方侧栏页签」，服务不存在
		 * 时回退到独立浮层面板（不再对接第三方 better-sidebar）。
		 */
		const OFFICIAL_TABS_SERVICE = "sidebarRightTabs";
		const OFFICIAL_RIGHT_SERVICE = "sidebarRight";
		/** 本插件在官方侧栏里注册的 tab 类型 id（全局唯一，也是正文槽位的 key）。 */
		const OFFICIAL_TYPE_ID = "remote-suite/terminal";
		/**
		 * 官方侧栏的 tab kind：直接用内置终端的 "terminal"，以扩展身份接管它。
		 *
		 * 官方注册表允许扩展（priority: "extension"）接管内置（"builtin"）的
		 * 同一个 kind：接管后「新建终端」引导卡片、正文与标题槽位、Ctrl+` 快捷键
		 * 全部落到本插件，开始页只留一个终端入口；扩展卸载时内置定义自动恢复。
		 */
		const OFFICIAL_KIND = "terminal";

		/**
		 * 把多次写入合并到同一个宏任务里一次完成，避免逐帧重排。
		 *
		 * 刻意不用 requestAnimationFrame：标签页切到后台后 rAF 会被暂停，
		 * 隐藏中的终端就会停止刷新滚动缓冲；MessageChannel 不受后台节流影响。
		 */
		const coalesce = (() => {
			let sink = null;
			let scheduled = false;
			const drain = () => {
				scheduled = false;
				const fn = sink;
				sink = null;
				if (fn !== null) fn();
			};
			let post = () => setTimeout(drain, 8);
			if (typeof globalThis.MessageChannel === "function") {
				const channel = new globalThis.MessageChannel();
				channel.port1.onmessage = drain;
				post = () => channel.port2.postMessage(null);
			}
			return (fn) => {
				sink = fn;
				if (scheduled) return;
				scheduled = true;
				post();
			};
		})();

		/** localStorage 键：面板宽度与展开状态。 */
		const KEY_WIDTH = "dsh.terminal.width";
		const KEY_OPEN = "dsh.terminal.open";
		/** localStorage 键：布局模式（仅独立浮层面板使用）。 */
		const KEY_MODE = "dsh.terminal.mode";

		/** 并排：DSH 框架让出右侧空间，互不遮挡。 */
		const MODE_DOCK = "dock";
		/** 浮层：终端盖在 DSH 之上。 */
		const MODE_OVERLAY = "overlay";

		/** localStorage 键：明暗主题。 */
		const KEY_THEME = "dsh.terminal.theme";
		/** 浅色主题名。 */
		const THEME_LIGHT_NAME = "light";
		/** 暗色主题名。 */
		const THEME_DARK_NAME = "dark";

		/** localStorage 键：复制/粘贴行为开关（JSON；缺项按默认值补齐）。 */
		const KEY_CLIPBOARD = "dsh.terminal.clipboard";
		/** localStorage 键：每个工作区选中的 shell（JSON：会话键 -> shell id）。 */
		const KEY_SHELLS = "dsh.terminal.shells";

		/**
		 * 复制/粘贴开关的默认值。
		 *
		 * `ctrlC` 只在「有选中内容」时复制，没有选中时仍然是 ^C（SIGINT），
		 * 所以默认打开不会让人失去中断命令的能力；`rightPaste` 是终端界惯例；
		 * `selectCopy` 默认关闭，因为「看到什么就复制什么」很容易污染剪贴板。
		 */
		const CLIPBOARD_DEFAULTS = { ctrlC: true, rightPaste: true, selectCopy: false, toastPos: "bottom" };

		/** 复制/粘贴提示气泡的位置档位。 */
		const TOAST_POSITIONS = [
			{ key: "bottom", label: "底部居中", title: "提示显示在终端面板底部中央" },
			{ key: "bottomLeft", label: "底部靠左", title: "提示显示在终端面板左下角（不挡输入行右侧）" },
			{ key: "top", label: "顶部居中", title: "提示显示在工具条下方居中" },
			{ key: "cursor", label: "跟随鼠标", title: "提示出现在鼠标位置上方，不占用终端画面" },
			{ key: "off", label: "关闭提示", title: "复制/粘贴后不弹任何提示" }
		];

		/** 三个开关的文案。三者互相独立，可以任意组合。 */
		const CLIPBOARD_OPTIONS = [
			{
				key: "ctrlC",
				label: "Ctrl+C 复制",
				title: "有选中内容时 Ctrl+C（macOS 上 Cmd+C）复制选中文本；没有选中时仍然发送 ^C 中断命令"
			},
			{
				key: "rightPaste",
				label: "右键粘贴",
				title: "在终端里点右键直接粘贴剪贴板内容（读取剪贴板需要 localhost 或 HTTPS）"
			},
			{
				key: "selectCopy",
				label: "选中即复制",
				title: "鼠标松开、选择停稳后自动复制选中文本"
			}
		];

		/** 「选中即复制」的防抖间隔：拖动过程中选中会连续变化，等停稳再复制一次。 */
		const SELECT_COPY_DEBOUNCE_MS = 150;

		/** 提示气泡的显示时长。 */
		const TOAST_MS = 1200;

		const MIN_WIDTH = 280;
		const MAX_WIDTH = 1100;
		const DEFAULT_WIDTH = 460;

		/** xterm 浅色主题（白底深字）。 */
		const THEME_LIGHT = {
			background: "#ffffff",
			foreground: "#1f2328",
			cursor: "#1f2328",
			cursorAccent: "#ffffff",
			selectionBackground: "#b6d7ff",
			black: "#24292f",
			red: "#cf222e",
			green: "#116329",
			yellow: "#953800",
			blue: "#0969da",
			magenta: "#8250df",
			cyan: "#1b7c83",
			white: "#6e7781",
			brightBlack: "#57606a",
			brightRed: "#a40e26",
			brightGreen: "#1a7f37",
			brightYellow: "#9a6700",
			brightBlue: "#218bff",
			brightMagenta: "#a475f9",
			brightCyan: "#3192aa",
			brightWhite: "#8c959f"
		};

		/** xterm 暗色主题（Catppuccin Mocha 系）。 */
		const THEME_DARK = {
			background: "#1b1b25",
			foreground: "#cdd6f4",
			cursor: "#f5e0dc",
			cursorAccent: "#1b1b25",
			selectionBackground: "#585b70",
			black: "#45475a",
			red: "#f38ba8",
			green: "#a6e3a1",
			yellow: "#f9e2af",
			blue: "#89b4fa",
			magenta: "#f5c2e7",
			cyan: "#94e2d5",
			white: "#bac2de",
			brightBlack: "#585b70",
			brightRed: "#f38ba8",
			brightGreen: "#a6e3a1",
			brightYellow: "#f9e2af",
			brightBlue: "#89b4fa",
			brightMagenta: "#f5c2e7",
			brightCyan: "#94e2d5",
			brightWhite: "#a6adc8"
		};

		/**
		 * 主题名对应的 xterm 调色板。
		 * @param name - 主题名。
		 * @returns 调色板对象。
		 */
		function themeOf(name) {
			return name === THEME_DARK_NAME ? THEME_DARK : THEME_LIGHT;
		}

		/** 面板自身样式（一次注入）。 */
		const STYLE_ID = "remote-suite-terminal-style";
		const CSS = `
/* 主题变量：面板与悬浮按钮是兄弟节点，各自带 data-theme，所以两套变量写在二者共用的选择器上。 */
.dsh-term-panel[data-theme="light"],.dsh-term-tab[data-theme="light"],.dsh-term-embed[data-theme="light"]{color-scheme:light;
  --t-bg:#ffffff;--t-fg:#1f2328;--t-muted:#6e7781;--t-head-bg:#f6f8fa;
  --t-border-soft:rgba(0,0,0,.10);
  --t-btn-bg:#ffffff;--t-btn-fg:#24292f;--t-btn-border:rgba(0,0,0,.15);--t-btn-hover-bg:#eaeef2;--t-btn-hover-fg:#000000;
  --t-dot:#d0d7de;--t-dot-on:#1a7f37;--t-dot-on-glow:0 0 6px rgba(26,127,55,.5);--t-dot-err:#cf222e;
  --t-tab-bg:#ffffff;--t-tab-hover-bg:#f3f4f6;--t-tab-fg:#1f2328;--t-tab-border:rgba(0,0,0,.16);
  --t-tab-shadow:0 6px 18px rgba(0,0,0,.18);--t-shadow:-12px 0 32px rgba(0,0,0,.18);
  --t-err-fg:#cf222e;--t-err-bg:rgba(255,255,255,.94);
  --t-count-bg:rgba(0,0,0,.08);--t-count-fg:#24292f;--t-grip-hover:rgba(9,105,218,.25)}
.dsh-term-panel[data-theme="dark"],.dsh-term-tab[data-theme="dark"],.dsh-term-embed[data-theme="dark"]{color-scheme:dark;
  --t-bg:#1b1b25;--t-fg:#cdd6f4;--t-muted:#7f849c;--t-head-bg:rgba(255,255,255,.03);
  --t-border-soft:rgba(255,255,255,.10);
  --t-btn-bg:transparent;--t-btn-fg:#bac2de;--t-btn-border:rgba(255,255,255,.18);--t-btn-hover-bg:rgba(255,255,255,.10);--t-btn-hover-fg:#ffffff;
  --t-dot:#6c7086;--t-dot-on:#a6e3a1;--t-dot-on-glow:0 0 6px #a6e3a1;--t-dot-err:#f38ba8;
  --t-tab-bg:#26263a;--t-tab-hover-bg:#31314a;--t-tab-fg:#cdd6f4;--t-tab-border:rgba(255,255,255,.18);
  --t-tab-shadow:0 6px 18px rgba(0,0,0,.42);--t-shadow:-12px 0 32px rgba(0,0,0,.42);
  --t-err-fg:#f38ba8;--t-err-bg:rgba(17,17,27,.86);
  --t-count-bg:rgba(255,255,255,.12);--t-count-fg:#cdd6f4;--t-grip-hover:rgba(137,180,250,.30)}
.dsh-term-panel{position:fixed;top:0;right:0;bottom:0;display:flex;flex-direction:column;
  pointer-events:auto;z-index:40;min-width:0;background:var(--t-bg);color:var(--t-fg)}
.dsh-term-panel[data-mode="overlay"]{box-shadow:var(--t-shadow)}
/* 嵌在官方侧栏页签里的形态：撑满页签，不要 fixed / 浮层阴影。 */
.dsh-term-embed{display:flex;flex-direction:column;position:relative;width:100%;height:100%;min-width:0;min-height:0;
  overflow:hidden;background:var(--t-bg);color:var(--t-fg)}
.dsh-term-head{display:flex;align-items:center;gap:8px;padding:6px 8px 6px 10px;flex:0 0 auto;flex-wrap:wrap;
  border-bottom:1px solid var(--t-border-soft);background:var(--t-head-bg);
  font:600 12px/1.4 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--t-fg)}
/* 页签形态的两行工具条：第一行状态+目录，第二行动作按钮，窄侧栏里不会挤成一团。 */
.dsh-term-head-compact{flex-wrap:nowrap;flex-direction:column;align-items:stretch;gap:5px}
.dsh-term-head-row{display:flex;align-items:center;gap:8px;min-width:0}
.dsh-term-head-compact .dsh-term-cwd{flex:1 1 auto;max-width:none}
.dsh-term-head-actions{flex-wrap:wrap}
.dsh-term-head-actions .dsh-term-shell{flex:1 1 150px;max-width:none;min-width:130px}
.dsh-term-dot{width:7px;height:7px;border-radius:50%;background:var(--t-dot);flex:0 0 auto}
.dsh-term-dot[data-state="on"]{background:var(--t-dot-on);box-shadow:var(--t-dot-on-glow)}
.dsh-term-dot[data-state="err"]{background:var(--t-dot-err)}
.dsh-term-title{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-term-status{flex:0 0 auto;font:500 11px/1.4 ui-sans-serif,system-ui,sans-serif;color:var(--t-muted)}
.dsh-term-status[data-state="on"]{color:#1a7f37}
.dsh-term-status[data-state="err"]{color:var(--t-err-fg)}
.dsh-term-shell{flex:0 0 auto;max-width:170px;border:1px solid var(--t-btn-border);background:var(--t-btn-bg);
  color:var(--t-btn-fg);border-radius:5px;padding:1px 4px;font:500 11px/1.5 ui-sans-serif,system-ui,sans-serif;cursor:pointer}
.dsh-term-cwd{flex:0 1 auto;max-width:45%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font:400 11px/1.4 ui-monospace,Menlo,Consolas,monospace;color:var(--t-muted)}
.dsh-term-btn{flex:0 0 auto;border:1px solid var(--t-btn-border);background:var(--t-btn-bg);color:var(--t-btn-fg);
  border-radius:5px;padding:2px 7px;font:500 11px/1.5 ui-sans-serif,system-ui,sans-serif;cursor:pointer}
.dsh-term-btn:hover{background:var(--t-btn-hover-bg);color:var(--t-btn-hover-fg)}
.dsh-term-body{position:relative;flex:1 1 auto;min-height:0;padding:6px 4px 6px 8px;overflow:hidden;background:var(--t-bg)}
.dsh-term-hosts{position:relative;width:100%;height:100%}
.dsh-term-body .xterm{height:100%}
.dsh-term-body .xterm-viewport{background:var(--t-bg) !important}
.dsh-term-grip{position:absolute;left:-3px;top:0;bottom:0;width:7px;cursor:col-resize;
  pointer-events:auto;background:transparent}
.dsh-term-grip:hover{background:var(--t-grip-hover)}
.dsh-term-tab{position:fixed;right:0;bottom:0;pointer-events:auto;z-index:40;
  display:flex;align-items:center;gap:6px;margin:0 10px 10px 0;padding:6px 11px;border-radius:8px;
  border:1px solid var(--t-tab-border);background:var(--t-tab-bg);color:var(--t-tab-fg);cursor:pointer;
  box-shadow:var(--t-tab-shadow);font:600 12px/1.2 ui-sans-serif,system-ui,sans-serif}
.dsh-term-tab:hover{background:var(--t-tab-hover-bg)}
.dsh-term-err{position:absolute;left:0;right:0;bottom:0;padding:8px 10px;color:var(--t-err-fg);background:var(--t-err-bg);font:400 12px/1.6 ui-sans-serif,system-ui,sans-serif;white-space:pre-wrap}
.dsh-term-count{padding:0 6px;border-radius:8px;background:var(--t-count-bg);color:var(--t-count-fg);font:600 10px/16px ui-monospace,SFMono-Regular,Menlo,monospace}
.dsh-term-btn[data-active="1"]{background:var(--t-btn-hover-bg);color:var(--t-btn-hover-fg);border-color:var(--t-btn-hover-bg)}
.dsh-term-menu{display:flex;align-items:center;gap:14px;flex-wrap:wrap;flex:0 0 auto;padding:6px 10px;
  border-bottom:1px solid var(--t-border-soft);background:var(--t-head-bg);
  font:500 11px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--t-fg)}
.dsh-term-menu-label{color:var(--t-muted)}
.dsh-term-opt{display:inline-flex;align-items:center;gap:5px;cursor:pointer;user-select:none}
.dsh-term-opt input{margin:0;cursor:pointer;accent-color:#0969da}
.dsh-term-menu-hint{flex:1 1 100%;color:var(--t-muted);font-weight:400}
.dsh-term-toast{position:absolute;z-index:2;padding:4px 12px;border-radius:999px;pointer-events:none;white-space:nowrap;
  background:var(--t-count-bg);color:var(--t-count-fg);box-shadow:0 4px 14px rgba(0,0,0,.20);
  font:500 11px/1.7 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
.dsh-term-toast[data-pos="bottom"]{left:50%;bottom:12px;transform:translateX(-50%)}
.dsh-term-toast[data-pos="bottomLeft"]{left:10px;bottom:12px}
.dsh-term-toast[data-pos="top"]{left:50%;top:8px;transform:translateX(-50%)}
/* 跟随鼠标：脱离面板流，按视口坐标定位在指针右上方，不遮挡刚选中的内容 */
.dsh-term-toast[data-pos="cursor"]{position:fixed;transform:translate(14px,-140%)}
.dsh-term-seg{flex:0 0 auto;padding:1px 8px;border-radius:999px;cursor:pointer;
  border:1px solid var(--t-btn-border);background:var(--t-btn-bg);color:var(--t-btn-fg);
  font:500 11px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
.dsh-term-seg:hover{background:var(--t-btn-hover-bg);color:var(--t-btn-hover-fg)}
.dsh-term-seg[data-active="1"]{background:var(--t-btn-hover-bg);color:var(--t-btn-hover-fg);border-color:var(--t-btn-hover-bg);font-weight:600}
`;

		/**
		 * 注入面板所需的全局样式（只注入一次）。
		 * @returns 无返回值。
		 */
		function ensureStyle() {
			if (typeof document === "undefined") return;
			const exist = document.getElementById(STYLE_ID);
			if (exist !== null) {
				// 插件热更新后同步新样式，避免页面不刷新时仍用旧规则。
				if (exist.textContent !== CSS) exist.textContent = CSS;
				return;
			}
			const el = document.createElement("style");
			el.id = STYLE_ID;
			el.textContent = CSS;
			document.head.appendChild(el);
		}

		/** 资源加载状态缓存，避免重复注入 script/link。 */
		let assetsPromise = null;

		/**
		 * 加载 xterm.js / addon-fit.js / xterm.css（同源，从宿主路由取）。
		 * 依次串行加载，保证 addon 能看到 window.Terminal。
		 * @returns 就绪后 resolve 的 Promise。
		 */
		function loadAssets() {
			if (assetsPromise !== null) return assetsPromise;
			/**
			 * 注入一个 script 标签并等待加载完成。
			 * @param src - 脚本地址。
			 * @returns 加载完成或失败后 resolve 的 Promise。
			 */
			const script = (src) =>
				new Promise((resolve) => {
					const s = document.createElement("script");
					s.src = src;
					s.async = false;
					s.onload = () => resolve(true);
					s.onerror = () => resolve(false);
					document.head.appendChild(s);
				});
			assetsPromise = (async () => {
				const link = document.createElement("link");
				link.rel = "stylesheet";
				link.href = `${ASSET_BASE}/xterm.css`;
				document.head.appendChild(link);
				if (!(await script(`${ASSET_BASE}/xterm.js`))) throw new Error(tr("xterm.js 加载失败"));
				if (!(await script(`${ASSET_BASE}/addon-fit.js`))) throw new Error(tr("addon-fit.js 加载失败"));
				// WebGL 渲染器是可选增强：加载失败就退回 xterm 默认的 DOM 渲染器，
				// 不能因为它把整个终端面板拖挂。
				await script(`${ASSET_BASE}/addon-webgl.js`);
				return true;
			})();
			return assetsPromise;
		}

		/**
		 * 读取宿主探测信息（默认 shell 与工作目录），失败时静默降级。
		 * @returns 信息对象或 null。
		 */
		async function fetchInfo(key) {
			try {
				const res = await fetch(INFO_PATH + (key && key !== DEFAULT_KEY ? "?cwd=" + encodeURIComponent(key) : ""), { headers: { accept: "application/json" } });
				if (!res.ok) return null;
				return await res.json();
			} catch {
				return null;
			}
		}

		/**
		 * 终端后端（dsh 宿主 HTTP 服务）的 origin。
		 *
		 * 浏览器直开时页面就是宿主 origin，直接用 location 拼 WebSocket 没问题；
		 * 但桌面端页面跑在 Electron 自定义 scheme 下（origin 是 `dsh-app://app`），
		 * location.host 并不指向宿主，直接拼出来的 `ws://app/...` 必然连不上。
		 * 宿主通过 preload 在页面上暴露 `__DSH_TRANSPORT__.streamBaseUrl`（DSH 自带的
		 * 客户端也用它拼 WebSocket），这里优先用它，拿不到再退回 location。
		 * @returns 后端 origin 的 URL 对象。
		 */
		function transportBase() {
			const transport = globalThis.__DSH_TRANSPORT__;
			const stream = transport !== undefined && transport !== null ? transport.streamBaseUrl : undefined;
			if (typeof stream === "string" && stream !== "") {
				try {
					const url = new URL(stream);
					if (url.protocol === "http:" || url.protocol === "https:") return url;
				} catch {
					/* 非法值：继续走 location 兜底。 */
				}
			}
			const loc = globalThis.location;
			if (loc !== undefined && loc !== null && typeof loc.protocol === "string") {
				try {
					return new URL(`${loc.protocol}//${loc.host}`);
				} catch {
					/* 测试桩可能没有完整 location。 */
				}
			}
			return new URL("http://127.0.0.1");
		}

		/**
		 * 从 localStorage 读取面板宽度。
		 * @returns 夹取到合法区间的宽度像素值。
		 */
		function readWidth() {
			const raw = Number(globalThis.localStorage?.getItem(KEY_WIDTH));
			if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_WIDTH;
			return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, raw));
		}

		/**
		 * 从 localStorage 读取展开状态，默认展开。
		 * @returns 是否展开。
		 */
		function readOpen() {
			return globalThis.localStorage?.getItem(KEY_OPEN) !== "0";
		}

		/**
		 * 从 localStorage 读取布局模式，默认并排。
		 * @returns 布局模式。
		 */
		function readMode() {
			return globalThis.localStorage?.getItem(KEY_MODE) === MODE_OVERLAY ? MODE_OVERLAY : MODE_DOCK;
		}

		/**
		 * 从 localStorage 读取明暗主题，默认浅色。
		 * @returns 主题名。
		 */
		function readTheme() {
			return globalThis.localStorage?.getItem(KEY_THEME) === THEME_DARK_NAME ? THEME_DARK_NAME : THEME_LIGHT_NAME;
		}

		/**
		 * 从 localStorage 读取复制/粘贴开关。
		 * @returns 三个开关的当前值（缺项或脏数据用默认值补齐）。
		 */
		function readClipboard() {
			const out = { ...CLIPBOARD_DEFAULTS };
			try {
				const raw = globalThis.localStorage?.getItem(KEY_CLIPBOARD);
				if (raw === null || raw === undefined || raw === "") return out;
				const parsed = JSON.parse(raw);
				for (const opt of CLIPBOARD_OPTIONS) {
					if (typeof parsed?.[opt.key] === "boolean") out[opt.key] = parsed[opt.key];
				}
				if (TOAST_POSITIONS.some((p) => p.key === parsed?.toastPos)) out.toastPos = parsed.toastPos;
			} catch {
				/* 隐私模式或脏数据：用默认值。 */
			}
			return out;
		}

		/**
		 * 保存复制/粘贴设置（含提示位置）。
		 * @param next - 完整设置对象。
		 * @returns 无返回值。
		 */
		function saveClipboard(next) {
			try {
				globalThis.localStorage?.setItem(KEY_CLIPBOARD, JSON.stringify(next));
			} catch {
				/* 隐私模式：仅本次会话有效。 */
			}
		}

		/**
		 * 写文本进剪贴板：优先异步剪贴板 API，失败退回 execCommand 老路。
		 *
		 * 页面若通过非 localhost 的明文 HTTP 打开，`navigator.clipboard` 不存在
		 * （非安全上下文），此时 execCommand('copy') 仍然可用，所以两条路都要留。
		 * @param text - 待复制文本。
		 * @returns 是否复制成功。
		 */
		async function copyText(text) {
			if (typeof text !== "string" || text === "") return false;
			try {
				if (typeof globalThis.navigator?.clipboard?.writeText === "function") {
					await globalThis.navigator.clipboard.writeText(text);
					return true;
				}
			} catch {
				/* 权限被拒或非安全上下文 → 走兜底。 */
			}
			try {
				const area = document.createElement("textarea");
				area.value = text;
				area.setAttribute("readonly", "");
				area.style.position = "fixed";
				area.style.left = "-9999px";
				area.style.top = "0";
				document.body.appendChild(area);
				area.select?.();
				const ok = document.execCommand?.("copy") === true;
				area.remove?.();
				return ok;
			} catch {
				return false;
			}
		}

		/**
		 * 读取剪贴板文本。
		 *
		 * 浏览器只在安全上下文（localhost / HTTPS）且获得授权后才允许读剪贴板；
		 * 拿不到时返回 null，由调用方提示改用 Ctrl+V（xterm 自身支持粘贴事件）。
		 * @returns 剪贴板文本；不可读时为 null。
		 */
		async function readClipboardText() {
			try {
				if (typeof globalThis.navigator?.clipboard?.readText === "function") {
					return await globalThis.navigator.clipboard.readText();
				}
			} catch {
				/* 权限被拒。 */
			}
			return null;
		}

		/**
		 * 安全地取终端当前选中的文本。
		 * @param term - xterm 实例。
		 * @returns 选中文本；终端已销毁或 API 不可用时为空串。
		 */
		function selectionOf(term) {
			try {
				if (typeof term?.getSelection !== "function") return "";
				return term.getSelection() ?? "";
			} catch {
				return "";
			}
		}

		/**
		 * 是否具备把面板挂到 body 的能力（并排模式必须脱离框架的 overflow:hidden）。
		 * @returns 可用时为 true。
		 */
		function canPortal() {
			return reactDom !== null && typeof reactDom.createPortal === "function" && document.body != null;
		}

		/**
		 * 在下一帧执行回调（无 requestAnimationFrame 的环境同步执行）。
		 * @param fn - 待执行回调。
		 * @returns 无返回值。
		 */
		function raf(fn) {
			if (typeof globalThis.requestAnimationFrame === "function") globalThis.requestAnimationFrame(fn);
			else fn();
		}

		/** 无工作区信息时使用的会话键。 */
		const DEFAULT_KEY = "\u0000default";

		/**
		 * 由工作区路径得到常驻终端的会话键。
		 * @param cwd - 当前会话所属工作区目录。
		 * @returns 会话键；无 cwd 时返回默认键。
		 */
		function keyOf(cwd) {
			return typeof cwd === "string" && cwd !== "" ? cwd : DEFAULT_KEY;
		}

		/**
		 * 会话键对应的显示名。
		 * @param key - 会话键。
		 * @returns 可展示的工作区路径。
		 */
		function labelOf(key) {
			return key === DEFAULT_KEY ? tr("(默认目录)") : key;
		}

		/**
		 * 运行时未提供 useSessions 时的兜底 hook（保持 hook 调用位置稳定）。
		 * @returns 恒为 undefined。
		 */
		function fallbackUseSessions() {
			return undefined;
		}

		//#endregion

		//#region 共享设置（独立浮层面板与官方侧栏页签共用同一份）
		/** 当前设置：明暗主题 + 复制/粘贴开关。 */
		let settings;
		try {
			settings = { theme: readTheme(), clipboard: readClipboard() };
		} catch {
			settings = { theme: THEME_LIGHT_NAME, clipboard: { ...CLIPBOARD_DEFAULTS } };
		}
		/** 设置变化的订阅者。 */
		const settingsListeners = new Set();

		/**
		 * 读取当前设置。
		 * @returns 设置对象。
		 */
		function getSettings() {
			return settings;
		}

		/**
		 * 订阅设置变化。
		 * @param fn - 变化回调。
		 * @returns 取消订阅函数。
		 */
		function subscribeSettings(fn) {
			settingsListeners.add(fn);
			return () => {
				settingsListeners.delete(fn);
			};
		}

		/**
		 * 更新并持久化设置，通知所有订阅者（两个 UI 的终端都会跟着换主题/开关）。
		 * @param patch - 局部更新。
		 * @returns 更新后的完整设置。
		 */
		function updateSettings(patch) {
			const prev = settings;
			const next = { ...prev, ...patch };
			if (patch.theme !== undefined) {
				try {
					globalThis.localStorage?.setItem(KEY_THEME, next.theme);
				} catch {
					/* 隐私模式：仅本次会话有效。 */
				}
			}
			if (patch.clipboard !== undefined) saveClipboard(next.clipboard);
			settings = next;
			for (const fn of [...settingsListeners]) {
				try {
					fn(next, prev);
				} catch (error) {
					console.error("[remote-suite] 设置订阅者异常：", error);
				}
			}
			return next;
		}

		/** 在浅色/暗色之间切换（并持久化、同步所有终端）。 */
		function toggleTheme() {
			updateSettings({ theme: settings.theme === THEME_DARK_NAME ? THEME_LIGHT_NAME : THEME_DARK_NAME });
		}

		/**
		 * 修改复制/粘贴开关。
		 * @param patch - 要修改的字段。
		 * @returns 无返回值。
		 */
		function patchClipboard(patch) {
			updateSettings({ clipboard: { ...settings.clipboard, ...patch } });
		}

		/** 每个工作区（会话键）选中的 shell id；空串/缺项表示用宿主默认 shell。 */
		const shellChoices = (() => {
			try {
				const raw = globalThis.localStorage?.getItem(KEY_SHELLS);
				const parsed = raw === null || raw === undefined || raw === "" ? null : JSON.parse(raw);
				return parsed !== null && typeof parsed === "object" ? parsed : {};
			} catch {
				return {};
			}
		})();

		/**
		 * 读取某工作区选中的 shell id。
		 * @param key - 会话键。
		 * @returns shell id；未选择时为空串。
		 */
		function getShellChoice(key) {
			const id = shellChoices[key];
			return typeof id === "string" && id !== "bash" ? id : "";
		}

		/**
		 * 记住某工作区选中的 shell id（空串表示恢复宿主默认）。
		 * @param key - 会话键。
		 * @param id - shell id。
		 * @returns 无返回值。
		 */
		function setShellChoice(key, id) {
			if (typeof id === "string" && id !== "") shellChoices[key] = id;
			else delete shellChoices[key];
			try {
				globalThis.localStorage?.setItem(KEY_SHELLS, JSON.stringify(shellChoices));
			} catch {
				/* 隐私模式：仅本次会话有效。 */
			}
		}
		//#endregion

		//#region 终端核心（与 UI 解耦，浮层与页签共用）
		/**
		 * 建一个终端核心：按工作区目录维护常驻 PTY 连接 + xterm 实例。
		 *
		 * 刻意放在模块级（而不是组件内）：浮层面板与官方侧栏页签是两个
		 * 组件，但同一工作区必须共享同一个 shell。组件只负责把宿主 div 挂到自己
		 * 的容器里再摘下来，终端本体与 WebSocket 不随组件挂载/卸载而重建。
		 * @returns 终端核心 API。
		 */
		function createTerminalCore() {
			/** 会话表：工作区目录 -> {host, term, fit, ws, ...}。 */
			const sessions = new Map();
			/** 状态变化订阅者（头部状态点/错误提示需要重渲染）。 */
			const listeners = new Set();
			/** 递增版本号，订阅者据此知道该重渲染了。 */
			let revision = 0;

			/**
			 * 通知所有订阅者会话状态有变化。
			 * @returns 无返回值。
			 */
			function changed() {
				revision++;
				for (const fn of [...listeners]) {
					try {
						fn(revision);
					} catch (error) {
						console.error("[remote-suite] 会话订阅者异常：", error);
					}
				}
			}

			/**
			 * 订阅会话状态变化。
			 * @param fn - 变化回调。
			 * @returns 取消订阅函数。
			 */
			function subscribe(fn) {
				listeners.add(fn);
				return () => {
					listeners.delete(fn);
				};
			}

			/**
			 * 确保某个工作区拥有终端会话记录（不启动 PTY，纯粹建记录）。
			 * @param key - 会话键。
			 * @returns 会话记录。
			 */
			function ensure(key) {
				const exist = sessions.get(key);
				if (exist !== undefined) return exist;
				const host = document.createElement("div");
				host.className = "dsh-term-host";
				host.style.width = "100%";
				host.style.height = "100%";
				host.style.display = "none";
				const s = {
					key,
					host,
					container: null,
					term: null,
					fit: null,
					webgl: null,
					ws: null,
					observer: null,
					status: "wait",
					error: "",
					retry: null,
					/** 宿主回传的环境 id（local / wsl:<发行版> / ssh:<主机>），连接后由控制帧填充。 */
					env: "",
					kind: "",
					disposed: false,
					booting: false,
					booted: false,
					/** 「选中即复制」的防抖定时器。 */
					selectTimer: null,
					/** 右键粘贴的宿主监听器（回收时移除）。 */
					onContextMenu: null,
					/** 提示气泡回调（当前挂载的 UI 注入；未挂载时为 null）。 */
					notify: null
				};
				sessions.set(key, s);
				return s;
			}

			/**
			 * 取会话记录。
			 * @param key - 会话键。
			 * @returns 会话记录或 null。
			 */
			function session(key) {
				return sessions.get(key) ?? null;
			}

			/**
			 * 当前常驻会话键列表。
			 * @returns 键列表。
			 */
			function keys() {
				return [...sessions.keys()];
			}

			/**
			 * 常驻会话数量。
			 * @returns 数量。
			 */
			function size() {
				return sessions.size;
			}

			/**
			 * 对指定会话做一次 fit（容器不可见时跳过，避免 PTY 被缩成 0 列）。
			 * @param key - 会话键。
			 * @returns 无返回值。
			 */
			function refit(key) {
				const s = sessions.get(key);
				if (s === undefined || s === null) return;
				if (s.fit === null || s.host === null) return;
				if (s.host.clientWidth === 0 || s.host.clientHeight === 0) return;
				try {
					s.fit.fit();
				} catch {
					/* 尺寸竞争时忽略。 */
				}
			}

			/**
			 * 聚焦指定会话的终端。
			 * @param key - 会话键。
			 * @returns 无返回值。
			 */
			function focus(key) {
				const s = sessions.get(key);
				if (s === undefined || s === null) return;
				try {
					s.term?.focus?.();
				} catch {
					/* 终端已销毁。 */
				}
			}

			/**
			 * 清屏（仅当前会话，保留滚动缓冲之外的内容）。
			 * @param key - 会话键。
			 * @returns 无返回值。
			 */
			function clear(key) {
				const s = sessions.get(key);
				if (s === undefined || s === null) return;
				try {
					s.term?.clear?.();
				} catch {
					/* 终端已销毁。 */
				}
			}

			/**
			 * 重建到后端的 WebSocket（复用同一个 xterm 与 PTY 后端）。
			 * @param key - 会话键。
			 * @returns 无返回值。
			 */
			function reconnect(key) {
				const s = sessions.get(key);
				if (s === undefined || s === null) return;
				connect(s);
			}

			/**
			 * 把会话的宿主 div 挂进某个容器并启动（幂等）。
			 * @param key - 会话键。
			 * @param container - DOM 容器。
			 * @returns 会话记录。
			 */
			function attach(key, container) {
				const s = ensure(key);
				if (container !== null && container !== undefined && s.container !== container) {
					if (s.host.parentElement !== container) container.appendChild(s.host);
					s.container = container;
				}
				s.host.style.display = "block";
				if (!s.booted && !s.booting) {
					s.booting = true;
					void boot(s);
				}
				raf(() => refit(key));
				return s;
			}

			/**
			 * 显示指定会话（切换工作区时用）。
			 * @param key - 会话键。
			 * @returns 无返回值。
			 */
			function show(key) {
				const s = sessions.get(key);
				if (s === undefined || s === null) return;
				s.host.style.display = "block";
				raf(() => refit(key));
			}

			/**
			 * 隐藏指定会话（保留 PTY 与滚动缓冲，切回来继续）。
			 * @param key - 会话键。
			 * @returns 无返回值。
			 */
			function hide(key) {
				const s = sessions.get(key);
				if (s === undefined || s === null) return;
				s.host.style.display = "none";
			}

			/**
			 * 把会话的宿主 div 从容器里摘下来（不销毁终端）。
			 * @param key - 会话键。
			 * @returns 无返回值。
			 */
			function detach(key) {
				const s = sessions.get(key);
				if (s === undefined || s === null) return;
				try {
					s.host.remove?.();
				} catch {
					/* 已经不在 DOM 里。 */
				}
				s.container = null;
				s.notify = null;
			}

			/**
			 * 把主题同步到所有常驻终端。
			 * @param palette - xterm 调色板。
			 * @returns 无返回值。
			 */
			function applyTheme(palette) {
				for (const s of sessions.values()) {
					const term = s.term;
					if (term === null || term === undefined) continue;
					try {
						term.options.theme = palette;
					} catch {
						/* 终端已销毁。 */
					}
				}
			}

			/**
			 * 为某个会话建立（或重建）到后端的 WebSocket，并按需自动重连。
			 * @param s - 会话记录。
			 * @param attempt - 第几个候选后端（0=独立进程，1=同源路由）。
			 * @returns 无返回值。
			 */
			function connect(s, attempt = 0) {
				const term = s.term;
				if (term === null) return;

				// 重建前先静默关掉旧连接，避免触发它的自动重连。
				const prev = s.ws;
				if (prev !== null) {
					try {
						prev.onclose = null;
						prev.close();
					} catch {
						/* 已经断开。 */
					}
					s.ws = null;
				}
				if (s.retry !== null) {
					clearTimeout(s.retry);
					s.retry = null;
				}

				s.status = "wait";
				s.error = "";
				changed();

				// 后端 origin：浏览器直开时是 location；桌面端（dsh-app:// 页面）是
				// __DSH_TRANSPORT__.streamBaseUrl 指向的宿主 HTTP 服务。
				const base = transportBase();
				const proto = base.protocol === "https:" ? "wss:" : "ws:";
				const qs = new URLSearchParams({ cols: String(term.cols || 80), rows: String(term.rows || 24) });
				// 把本会话所属工作区交给宿主，PTY 就在该目录下启动。
				if (s.key !== DEFAULT_KEY) qs.set("cwd", s.key);
				// 该工作区选中的 shell（cmd / powershell / WSL / SSH …）；空表示宿主默认。
				const chosenShell = getShellChoice(s.key);
				if (chosenShell !== "") qs.set("shell", chosenShell);

				// 候选后端：先独立终端进程（延迟不受 dsh 主进程影响），再同源路由兜底。
				let helperPort = HELPER_DEFAULT_PORT;
				try {
					const override = Number(globalThis.localStorage?.getItem(HELPER_PORT_KEY));
					if (Number.isFinite(override) && override > 0) helperPort = override;
				} catch {
					/* 隐私模式等拿不到 localStorage，用默认端口。 */
				}
				const targets = [
					{ kind: "helper", url: `${proto}//${base.hostname}:${helperPort}/ws?${qs.toString()}` },
					{ kind: "inline", url: `${proto}//${base.host}${WS_PATH}?${qs.toString()}` }
				];
				const target = targets[Math.min(attempt, targets.length - 1)];

				let ws;
				try {
					ws = new WebSocket(target.url);
				} catch (err) {
					s.status = "err";
					s.error = String(err?.message ?? err);
					changed();
					return;
				}
				s.ws = ws;
				/** 是否已成功握手：未握手就断开说明该后端不可达，直接换下一个。 */
				let opened = false;
				/** 本连接待写入 xterm 的 PTY 输出，按宏任务合批后一次写。 */
				const pending = [];
				const flushPending = () => {
					if (pending.length === 0) return;
					term.write(pending.join(""));
					pending.length = 0;
				};

				ws.onopen = () => {
					if (s.disposed) return;
					opened = true;
					s.backend = target.kind;
					s.status = "on";
					s.error = "";
					changed();
					refit(s.key);
					if (term.cols > 0) ws.send(JSON.stringify({ t: "r", c: term.cols, r: term.rows }));
					if (target.kind === "helper") {
						console.info(
							`[remote-suite] 已连接独立终端进程 ${base.hostname}:${helperPort}（按键回显不受 dsh 主进程负载影响）`
						);
					} else {
						console.info("[remote-suite] 独立终端进程不可达，已回退到同源路由。");
					}
				};

				ws.onmessage = (ev) => {
					if (s.disposed) return;
					const data = typeof ev.data === "string" ? ev.data : "";
					// 宿主控制帧（以 {"t":" 开头）与 PTY 原始输出区分开：
					// t:"e" = 终端启动/上限类错误；t:"s" = 本会话所属环境。
					if (data.startsWith('{"t":"')) {
						let frame = null;
						try {
							frame = JSON.parse(data);
						} catch {
							frame = null;
						}
						if (frame !== null && typeof frame === "object") {
							if (frame.t === "e") {
								s.status = "err";
								s.error = typeof frame.d === "string" && frame.d !== "" ? frame.d : tr("终端启动失败");
								changed();
								return;
							}
							if (frame.t === "s") {
								s.env = typeof frame.env === "string" ? frame.env : "";
								s.kind = typeof frame.kind === "string" ? frame.kind : "";
								changed();
								return;
							}
						}
					}
					// 隐藏中的终端同样在收数据，因此其滚动缓冲始终是最新的；
					// 合批到同一个宏任务再写入，避免逐帧重排。
					pending.push(data);
					coalesce(flushPending);
				};

				ws.onclose = () => {
					if (s.disposed) return;
					// 还没握手就断开：说明该后端不可达（独立进程没起、或端口未转发），
					// 立刻换下一个候选后端；全都试过才进入 3 秒重连。
					if (!opened && attempt + 1 < targets.length) {
						s.status = "wait";
						changed();
						connect(s, attempt + 1);
						return;
					}
					s.status = "err";
					s.error = opened ? tr("连接已断开，3 秒后自动重连…") : tr("无法连接终端后端，3 秒后重试…");
					changed();
					if (s.retry !== null) clearTimeout(s.retry);
					s.retry = setTimeout(() => {
						s.retry = null;
						if (!s.disposed) connect(s, 0);
					}, 3000);
				};

				ws.onerror = () => {
					/* 具体原因由 onclose 统一处理。 */
				};
			}

			/**
			 * 启动一个会话：加载 xterm 资源、建终端、挂剪贴板与尺寸监听、连后端。
			 * @param s - 会话记录。
			 * @returns 无返回值。
			 */
			async function boot(s) {
				try {
					await loadAssets();
				} catch (err) {
					if (s.disposed) return;
					s.status = "err";
					s.error = tr("终端资源加载失败：{detail}\n请确认已刷新页面以加载最新插件。", { detail: String(err?.message ?? err) });
					changed();
					return;
				}
				if (s.disposed) return;

				const term = new globalThis.Terminal({
					cursorBlink: true,
					fontSize: 13,
					fontFamily: 'ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace',
					lineHeight: 1.2,
					scrollback: 10000,
					allowProposedApi: true,
					theme: themeOf(getSettings().theme)
				});
				const fit = new globalThis.FitAddon.FitAddon();
				term.loadAddon(fit);
				term.open(s.host);
				s.term = term;
				s.fit = fit;

				/**
				 * WebGL 渲染器：把终端绘制从主线程 DOM 操作搬到 GPU。
				 *
				 * 这很关键 —— 聊天区流式输出时每个 token 都要重渲染，DOM 渲染器
				 * 会和它抢同一个主线程；WebGL 之后终端绘制几乎不占主线程。
				 * 上下文丢失（GPU 驱动重置、标签页回收）时卸载它，自动退回 DOM。
				 */
				try {
					if (typeof globalThis.WebglAddon?.WebglAddon === "function") {
						const webgl = new globalThis.WebglAddon.WebglAddon();
						webgl.onContextLoss(() => {
							try {
								webgl.dispose();
							} catch {
								/* 已经卸载。 */
							}
						});
						term.loadAddon(webgl);
						s.webgl = webgl;
					}
				} catch {
					/* 设备/浏览器不支持 WebGL：保持默认 DOM 渲染器即可。 */
				}

				term.onData((d) => {
					const ws = s.ws;
					if (ws !== null && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "i", d }));
				});
				term.onResize(({ cols, rows }) => {
					const ws = s.ws;
					if (ws !== null && ws.readyState === WebSocket.OPEN) {
						ws.send(JSON.stringify({ t: "r", c: cols, r: rows }));
					}
				});
				term.onTitleChange(() => {
					/* 预留：可用于把标题显示到面板头部。 */
				});

				/**
				 * Ctrl+C 复制（可选）。
				 *
				 * 只有「有选中内容」时才把按键拦下来复制，否则原样交回 xterm 发送
				 * ^C —— 所以即使默认打开，也不会失去中断命令的能力。同时接受
				 * Cmd+C（macOS 习惯）；带 Shift/Alt 的组合一律放行。
				 */
				term.attachCustomKeyEventHandler?.((ev) => {
					if (ev?.type !== "keydown") return true;
					if (getSettings().clipboard.ctrlC !== true) return true;
					const key = typeof ev.key === "string" ? ev.key.toLowerCase() : "";
					if (key !== "c") return true;
					if ((ev.ctrlKey !== true && ev.metaKey !== true) || ev.altKey === true || ev.shiftKey === true) return true;
					const selected = selectionOf(term);
					if (selected === "") return true;
					const at = ev.clientX !== undefined && ev.clientX !== 0 ? { x: ev.clientX, y: ev.clientY } : null;
					void copyText(selected).then((ok) => {
						s.notify?.(ok ? tr("已复制 {count} 个字符", { count: selected.length }) : tr("复制失败：浏览器拒绝了剪贴板写入"), at);
					});
					return false;
				});

				/**
				 * 选中即复制（可选）。
				 *
				 * 拖动过程中选中内容会连续变化，所以做 150ms 防抖：停稳后才复制一次，
				 * 避免把半截内容反复写进剪贴板。
				 */
				term.onSelectionChange?.(() => {
					if (getSettings().clipboard.selectCopy !== true) return;
					if (s.selectTimer !== null) clearTimeout(s.selectTimer);
					s.selectTimer = setTimeout(() => {
						s.selectTimer = null;
						const selected = selectionOf(term);
						if (selected === "") return;
						void copyText(selected).then((ok) => {
							if (ok) s.notify?.(tr("已复制 {count} 个字符", { count: selected.length }));
						});
					}, SELECT_COPY_DEBOUNCE_MS);
				});

				/**
				 * 右键粘贴（可选）。
				 *
				 * 拦截浏览器右键菜单；拿到文本后交给 `term.paste()` 而不是直接发原始
				 * 数据，这样括号粘贴模式与换行处理跟正常粘贴完全一致（多行内容不会被
				 * 应用当成多条命令立刻执行）。
				 */
				const onContextMenu = (ev) => {
					if (getSettings().clipboard.rightPaste !== true) return;
					ev.preventDefault?.();
					const at = { x: ev.clientX ?? 0, y: ev.clientY ?? 0 };
					void readClipboardText().then((text) => {
						if (text === null) {
							s.notify?.(tr("此环境不允许读取剪贴板，请用 Ctrl+V 粘贴"), at);
							return;
						}
						if (text === "") return;
						try {
							if (typeof term.paste === "function") term.paste(text);
							else {
								const ws = s.ws;
								if (ws !== null && ws.readyState === WebSocket.OPEN) {
									ws.send(JSON.stringify({ t: "i", d: text }));
								}
							}
						} catch {
							/* 终端已销毁时忽略。 */
						}
						s.notify?.(tr("已粘贴 {count} 个字符", { count: text.length }), at);
					});
				};
				// 用捕获阶段挂载：即使 xterm 内部对右键做了 stopPropagation，也保证能拦到。
				s.host.addEventListener?.("contextmenu", onContextMenu, true);
				s.onContextMenu = onContextMenu;

				if (typeof ResizeObserver !== "undefined") {
					s.observer = new ResizeObserver(() => refit(s.key));
					s.observer.observe(s.host);
				}

				term.write(`\r\n\x1b[2m` + tr("[已为工作区 {cwd} 启动常驻终端；切走后它继续运行]", { cwd: labelOf(s.key) }) + `\x1b[0m\r\n`);
				s.booted = true;
				refit(s.key);
				connect(s);
				changed();
			}

			/**
			 * 销毁一个会话（关 WS → 后端会回收 PTY；再销毁 xterm 与 DOM）。
			 * @param key - 会话键。
			 * @returns 无返回值。
			 */
			function dispose(key) {
				const s = sessions.get(key);
				if (s === undefined) return;
				s.disposed = true;
				if (s.retry !== null) clearTimeout(s.retry);
				if (s.selectTimer !== null) clearTimeout(s.selectTimer);
				if (s.onContextMenu !== null) {
					try {
						s.host?.removeEventListener?.("contextmenu", s.onContextMenu, true);
					} catch {
						/* 已不在。 */
					}
				}
				s.observer?.disconnect?.();
				if (s.ws !== null) {
					try {
						s.ws.onclose = null;
						s.ws.close();
					} catch {
						/* 忽略。 */
					}
				}
				try {
					s.term?.dispose?.();
				} catch {
					/* 忽略。 */
				}
				try {
					s.host?.remove?.();
				} catch {
					/* 忽略。 */
				}
				sessions.delete(key);
				changed();
			}

			/**
			 * 销毁全部会话（插件卸载时调用）。
			 * @returns 无返回值。
			 */
			function disposeAll() {
				for (const key of [...sessions.keys()]) dispose(key);
			}

			return {
				attach,
				applyTheme,
				clear,
				detach,
				dispose,
				disposeAll,
				focus,
				hide,
				keys,
				reconnect,
				refit,
				session,
				show,
				size,
				subscribe
			};
		}

		/** 全局唯一的终端核心：浮层面板与官方侧栏页签共享。 */
		const core = createTerminalCore();

		/**
		 * 由会话键推断「环境」id（local / wsl:<发行版> / ssh:<主机>）。
		 * 优先用宿主控制帧回传的真实环境（连接后），其次用该工作区选中的 shell、
		 * WSL UNC 路径特征推断，再其次用调用方传入的工作区默认环境（/info 的 env），
		 * 最后回退到本机 local。
		 * @param key - 会话键。
		 * @param fallback - 该工作区的默认环境（仅用于当前终端本身）。
		 * @returns 环境 id。
		 */
		function envOf(key, fallback) {
			const session = core.session(key);
			if (session !== null && typeof session.env === "string" && session.env !== "") return session.env;
			const chosen = getShellChoice(key);
			if (chosen.startsWith("wsl:") || chosen.startsWith("ssh:") || chosen.startsWith("docker:")) return chosen;
			const wsl = /^\\\\(?:wsl(?:\.localhost|\$)|wsl\.localhost)\\([^\\]+)/i.exec(key);
			if (wsl !== null) return `wsl:${wsl[1]}`;
			if (typeof fallback === "string" && fallback !== "") return fallback;
			return "local";
		}
		//#endregion

		//#region 接入方式（官方右侧栏 / 独立浮层）
		/**
		 * 当前 UI 的挂载方式：
		 * - "overlay"：独立浮层面板（没有官方右侧栏时的兜底形态）；
		 * - "sidebar"：作为 DSH 官方右侧栏的页签（0.2.2+ 默认形态）。
		 * 两个 UI 组件都订阅它，保证同一时刻只有一种形态在画面上。
		 */
		const integration = {
			mode: "overlay",
			listeners: new Set(),
			/**
			 * 切换挂载方式并通知订阅者。
			 * @param next - 新的方式。
			 * @returns 无返回值。
			 */
			set(next) {
				if (this.mode === next) return;
				this.mode = next;
				for (const fn of [...this.listeners]) {
					try {
						fn(next);
					} catch (error) {
						console.error("[remote-suite] 接入方式订阅者异常：", error);
					}
				}
			},
			/**
			 * 订阅挂载方式变化。
			 * @param fn - 变化回调。
			 * @returns 取消订阅函数。
			 */
			subscribe(fn) {
				this.listeners.add(fn);
				return () => {
					this.listeners.delete(fn);
				};
			}
		};

		/**
		 * 订阅共享设置（主题/剪贴板）。
		 * @returns 当前设置对象。
		 */
		function useSettings() {
			const [value, setValue] = react.useState(getSettings);
			react.useEffect(() => subscribeSettings((next) => setValue(next)), []);
			return value;
		}

		/**
		 * 订阅挂载方式。
		 * @returns 当前方式（"overlay" / "sidebar"）。
		 */
		function useIntegrationMode() {
			const [mode, setMode] = react.useState(integration.mode);
			react.useEffect(() => integration.subscribe(setMode), []);
			return mode;
		}

		/**
		 * 订阅终端核心的状态变化，让工具条能跟上连接状态/错误/数量。
		 * @returns 递增的版本号（仅用于触发重渲染）。
		 */
		function useCoreVersion() {
			const [version, setVersion] = react.useState(0);
			react.useEffect(() => core.subscribe(setVersion), []);
			return version;
		}

		/**
		 * 复制/粘贴提示气泡：显示、自动消失，并记住最近一次指针位置。
		 * @returns 气泡内容、位置、触发函数与指针跟踪函数。
		 */
		function useFlash() {
			const [toast, setToast] = react.useState("");
			const [toastAt, setToastAt] = react.useState(null);
			const timerRef = react.useRef(null);
			/** 最近一次指针位置（视口坐标），供键盘触发复制/粘贴的「跟随鼠标」档使用。 */
			const pointerRef = react.useRef(null);

			const flash = react.useCallback((message, at) => {
				if (getSettings().clipboard.toastPos === "off") return;
				setToastAt(at ?? pointerRef.current ?? null);
				setToast(message);
				if (timerRef.current !== null) clearTimeout(timerRef.current);
				timerRef.current = setTimeout(() => {
					setToast("");
					setToastAt(null);
				}, TOAST_MS);
			}, []);

			const trackPointer = react.useCallback((ev) => {
				pointerRef.current = { x: ev.clientX, y: ev.clientY };
			}, []);

			react.useEffect(
				() => () => {
					if (timerRef.current !== null) clearTimeout(timerRef.current);
				},
				[]
			);

			return { toast, toastAt, flash, trackPointer };
		}

		/**
		 * 状态点：连接中 / 已连接 / 出错。
		 * @param status - 会话状态。
		 * @returns React 元素。
		 */
		function renderDot(status) {
			return h("span", {
				className: "dsh-term-dot",
				"data-state": status === "on" ? "on" : status === "err" ? "err" : "wait"
			});
		}

		/**
		 * 终端工具条（浮层面板与页签共用的头部）。
		 * @param options - 展示项与按钮回调。
		 * @returns React 元素。
		 */
		function infoOptions(options, shells) { return options.detectedShell && !shells.some((sh) => sh.id === options.detectedShell.id) ? [h("option", { value: options.detectedShell.id }, options.detectedShell.label)] : []; }
		function useMenuDismiss(open, setOpen) {
			react.useEffect(() => {
				if (!open) return;
				const outside = (event) => {
					if (event.target?.closest?.("[data-dsh-terminal-menu], [data-copy-menu]")) return;
					setOpen(false);
				};
				const escape = (event) => {
					if (event.key === "Escape") setOpen(false);
				};
				document.addEventListener?.("pointerdown", outside, true);
				document.addEventListener?.("keydown", escape, true);
				return () => {
					document.removeEventListener?.("pointerdown", outside, true);
					document.removeEventListener?.("keydown", escape, true);
				};
			}, [open, setOpen]);
		}

		function SessionMenu(props) {
			const ref = react.useRef(null);
			react.useEffect(() => {
				const outside = (event) => {
					const node = ref.current;
					if (node?.open && !node.contains(event.target)) node.open = false;
				};
				const escape = (event) => {
					if (event.key === "Escape" && ref.current?.open) ref.current.open = false;
				};
				document.addEventListener("pointerdown", outside, true);
				document.addEventListener("keydown", escape, true);
				return () => {
					document.removeEventListener("pointerdown", outside, true);
					document.removeEventListener("keydown", escape, true);
				};
			}, []);
			return h("details", { ref, className: "dsh-term-sessions", style: { position: "relative" } }, ...props.children);
		}

		function renderToolbar(options) {
			const shells = Array.isArray(options.shells) ? options.shells : [];
			const shellId = typeof options.shellId === "string" ? options.shellId : "";
			const compact = options.compact === true;
			const button = (label, title, onClick, extra) =>
				h("button", { className: "dsh-term-btn", onClick, title, ...(extra ?? {}) }, label);
			const themeButton = button(
				options.theme === THEME_DARK_NAME ? tr("暗色") : tr("浅色"),
				options.theme === THEME_DARK_NAME ? tr("当前为暗色。点击切换为浅色") : tr("当前为浅色。点击切换为暗色"),
				options.onTheme
			);
			const menuButton = button(tr("复制"), tr("复制/粘贴设置"), options.onMenu, {
				"data-active": options.menuOpen ? "1" : "0",
				"data-copy-menu": "1"
			});
			const clearButton = button(tr("清屏"), tr("清屏（仅当前工作区）"), options.onClear);
			const reconnectButton = button(tr("重连"), tr("重新连接当前工作区的 PTY"), options.onReconnect);
			// 第一项是「默认 shell」（空 id）：按工作目录自动选 bash（Windows 用 Git Bash，
			// WSL 目录用该发行版 bash，remote-ssh 工作区 ssh 到远端 bash）。
			const shellSelect =
				shells.length === 0
					? null
					: h(
							"select",
							{
								className: "dsh-term-shell",
								title: tr("选择本工作区终端使用的 shell（默认 shell / Windows:cmd / Windows:PowerShell / WSL / SSH）"),
								value: shellId,
								onChange: (ev) => {
									if (typeof options.onShell === "function") options.onShell(ev.target.value);
								}
							},
							...(infoOptions(options, shells)),
							...shells.map((sh) => h("option", { key: sh.id, value: sh.id }, sh.label ?? sh.id))
						);
			const statusNode = h(
				"span",
				{ className: "dsh-term-status", "data-state": options.status, title: options.statusTitle ?? "" },
				options.status === "on" ? tr("已连接") : options.status === "err" ? tr("连接失败") : tr("连接中…")
			);
			const cwdNode = h("span", { className: "dsh-term-cwd", title: options.shownCwd }, options.shownCwd);
			/** 本环境（local / wsl:<发行版> / ssh:<主机>）的后台终端：列表与计数都只看同一环境。 */
			const sessionKeys = Array.isArray(options.keys) ? options.keys : core.keys();
			const countNode = h(SessionMenu, null,
				h("summary", { className: "dsh-term-count", title: tr("查看和关闭本环境的后台终端（包含当前终端）"), style: { cursor: "pointer", whiteSpace: "nowrap" } }, tr("后台终端：{count}", { count: options.count })),
				h("div", { style: { position: "absolute", right: 0, top: "100%", zIndex: 50, background: "var(--t-bg, white)", border: "1px solid #888", padding: "8px", width: "300px", maxHeight: "240px", overflow: "auto" } },
					...sessionKeys.map((key) => h("div", { key, style: { display: "flex", gap: "8px", marginTop: "6px" } },
						h("span", { title: labelOf(key), style: { flex: 1, overflowWrap: "anywhere" } }, labelOf(key) + (labelOf(key) === options.shownCwd ? tr("（当前）") : "")),
						h("button", { type: "button", onClick: () => core.dispose(key) }, tr("关闭")))),
					h("button", { type: "button", style: { marginTop: "8px", display: "block", marginLeft: "auto", marginRight: "auto" }, onClick: () => {
						for (const key of sessionKeys) if (labelOf(key) !== options.shownCwd) core.dispose(key);
					} }, tr("关闭其他终端"))
				));

			// 页签形态：两行。第一行=状态点 + 连接状态 + 工作目录，第二行=shell 选择 +
			// 操作按钮。页签标题由侧栏自己显示，这里不再重复标题、也不用固定的「收起」。
			if (compact === true) {
				return h(
					"div",
					{ className: "dsh-term-head dsh-term-head-compact" },
					h("div", { className: "dsh-term-head-row" }, renderDot(options.status), statusNode, cwdNode, countNode),
					h(
						"div",
						{ className: "dsh-term-head-row dsh-term-head-actions" },
						shellSelect,
						themeButton,
						menuButton,
						clearButton,
						reconnectButton
					)
				);
			}

			const kids = [
				renderDot(options.status),
				statusNode,
				h("span", { className: "dsh-term-title" }, tr("终端")),
				cwdNode,
				countNode
			];
			if (shellSelect !== null) kids.push(shellSelect);
			kids.push(
				h(
					"button",
					{
						className: "dsh-term-btn",
						onClick: options.onLayout,
						title:
							options.mode === MODE_DOCK
								? tr("当前为并排：DSH 让出右侧空间。点击改为浮层覆盖")
								: tr("当前为浮层：终端盖在 DSH 上。点击改为并排（DSH 让出空间）")
					},
					options.mode === MODE_DOCK ? tr("并排") : tr("浮层")
				),
				themeButton,
				menuButton,
				clearButton,
				reconnectButton,
				h("button", { className: "dsh-term-btn", onClick: options.onCollapse, title: tr("收起终端（Ctrl+`）") }, tr("收起"))
			);
			return h("div", { className: "dsh-term-head" }, ...kids);
		}

		/**
		 * 复制/粘贴设置菜单。
		 * @param options - 当前开关与回调。
		 * @returns React 元素。
		 */
		function renderMenu(options) {
			return h(
				"div",
				{ className: "dsh-term-menu", "data-dsh-terminal-menu": "1" },
				h("span", { className: "dsh-term-menu-label" }, tr("复制/粘贴")),
				...CLIPBOARD_OPTIONS.map((opt) =>
					h(
						"label",
						{ className: "dsh-term-opt", key: opt.key, title: tr(opt.title) },
						h("input", {
							type: "checkbox",
							checked: options.clipboard[opt.key] === true,
							onChange: () => options.onToggle(opt.key)
						}),
						tr(opt.label)
					)
				),
				h(
					"span",
					{ className: "dsh-term-menu-hint" },
					tr("三个开关互相独立、可同时打开；Ctrl+C 只在有选中内容时复制，读取剪贴板需 localhost 或 HTTPS")
				),
				h("span", { className: "dsh-term-menu-label" }, tr("提示位置")),
				...TOAST_POSITIONS.map((pos) =>
					h(
						"button",
						{
							key: pos.key,
							className: "dsh-term-seg",
							"data-active": options.clipboard.toastPos === pos.key ? "1" : "0",
							title: tr(pos.title),
							onClick: () => options.onToastPos(pos.key)
						},
						tr(pos.label)
					)
				)
			);
		}

		/**
		 * 终端主体：宿主容器 + 提示气泡 + 错误条。
		 * @param options - 容器 ref、开关、气泡与错误。
		 * @returns React 元素。
		 */
		function renderBody(options) {
			const clipboard = options.clipboard;
			return h(
				"div",
				{ className: "dsh-term-body" },
				// 每个工作区一个宿主 div，由核心在 attach 时追加进来；
				// 这里用独立容器，避免与 React 的子节点管理相互干扰。
				h("div", { className: "dsh-term-hosts", ref: options.containerRef }),
				options.toast !== ""
					? h(
							"div",
							{
								className: "dsh-term-toast",
								"data-dsh-terminal-toast": "1",
								"data-pos": clipboard.toastPos,
								style:
									clipboard.toastPos === "cursor" && options.toastAt !== null
										? {
												left: `${Math.max(8, Math.min(options.toastAt.x, (globalThis.innerWidth ?? 1024) - 200))}px`,
												top: `${options.toastAt.y}px`
											}
										: undefined
							},
							options.toast
						)
					: null,
				options.error !== "" ? h("div", { className: "dsh-term-err" }, options.error) : null
			);
		}
		//#endregion

		//#region 独立浮层面板（现有形态）
		/**
		 * 右侧常驻终端面板：**每个工作区各保留一个常驻 shell**。
		 *
		 * 组件注册在 root 作用域的 `shell.overlay` 列表槽里，因此对每个会话
		 * （包括新建会话页）都存在，且切换会话不会卸载。内部按工作区目录维护
		 * 多份终端：切换工作区只是切换显示哪一份，其它工作区的 shell 保持运行、
		 * 滚动缓冲保持完整（终端核心在模块级，见 createTerminalCore）。
		 * @param props - 槽注入属性，含全局 useSessions。
		 * @returns 面板、悬浮开合按钮或 null（已接入官方侧栏时）。
		 */
		function TerminalPanel(props) {
			const useSessions = props?.useSessions ?? fallbackUseSessions;
			// 当前会话所属工作区目录：会话摘要里的 cwd 即 header.cwd 直通。
			const wsCwd = useSessions((s) => {
				if (s === undefined || s === null) return undefined;
				const id = s.current;
				if (id === undefined || id === null) return undefined;
				const summary = s.byId === undefined ? undefined : s.byId[id];
				return summary === undefined ? undefined : summary.cwd;
			});
			const activeKey = keyOf(wsCwd);

			const [open, setOpen] = react.useState(readOpen);
			const [width, setWidth] = react.useState(readWidth);
			const [mode, setMode] = react.useState(readMode);
			/** 复制/粘贴设置菜单是否展开。 */
			const [menuOpen, setMenuOpen] = react.useState(false);
			useMenuDismiss(menuOpen, setMenuOpen);
			const [info, setInfo] = react.useState(null);

			const settings = useSettings();
			const integrationMode = useIntegrationMode();
			const { toast, toastAt, flash, trackPointer } = useFlash();
			// 订阅核心状态：连接状态/错误/常驻数量变化时重渲染工具条。
			useCoreVersion();

			/** 各工作区终端宿主的父容器（React 管理，尺寸稳定）。 */
			const hostsRef = react.useRef(null);
			const activeKeyRef = react.useRef(activeKey);
			const aliveRef = react.useRef(false);
			const visibleRef = react.useRef(open);

			// 挂载：注入样式、拉取宿主信息。
			react.useEffect(() => {
				aliveRef.current = true;
				ensureStyle();
				(async () => {
					const meta = await fetchInfo(activeKey);
					if (!aliveRef.current) return;
					setInfo(meta);
				})();
				return () => {
					aliveRef.current = false;
				};
			}, []);

			// 工作区变化：确保该工作区有常驻终端并切到它，其它工作区继续运行。
			// 已接入官方侧栏页签时不再操作浮层容器。
			react.useEffect(() => {
				activeKeyRef.current = activeKey;
				if (integrationMode !== "overlay") return;
				const container = hostsRef.current;
				if (container === null) return;
				const s = core.attach(activeKey, container);
				if (s !== null) s.notify = flash;
				core.show(activeKey);
				for (const key of core.keys()) {
					if (key !== activeKey) core.hide(key);
				}
				raf(() => {
					core.refit(activeKey);
					if (visibleRef.current) core.focus(activeKey);
				});
			}, [activeKey, integrationMode, flash]);

			// 展开/收起：隐藏不销毁，故 shell 与滚动缓冲都保留。
			react.useEffect(() => {
				visibleRef.current = open;
				try {
					globalThis.localStorage?.setItem(KEY_OPEN, open ? "1" : "0");
				} catch {
					/* 隐私模式。 */
				}
				if (!open) return;
				raf(() => {
					core.refit(activeKeyRef.current);
					core.focus(activeKeyRef.current);
				});
			}, [open]);

			// 面板宽度变化：重算行列数。
			react.useEffect(() => {
				core.refit(activeKeyRef.current);
			}, [width]);

			// 并排模式：把 DSH 的 AppFrame 整体收窄，让它的三栏自己重排，终端占住让出来的这一条。
			// AppFrame 用 ResizeObserver 观测自身宽度来解算列宽，所以改 margin 就会触发正确重排
			// （侧栏不妥协、正文保底、必要时自动关掉右侧详情栏），不会像浮层那样盖住内容。
			react.useEffect(() => {
				const overlay = document.querySelector("[data-shell-overlay]");
				const frame = overlay != null ? overlay.parentElement : null;
				if (frame === null) return;
				// 折叠时不占位；浮层模式不占位；页签模式由侧栏管理布局。
				const docked = open === true && mode === MODE_DOCK && canPortal() && integration.mode === "overlay";
				frame.style.marginRight = docked ? `${width}px` : "";
				return () => {
					frame.style.marginRight = "";
				};
			}, [open, width, mode]);

			// 记住布局模式。
			react.useEffect(() => {
				try {
					globalThis.localStorage?.setItem(KEY_MODE, mode);
				} catch {
					/* 隐私模式。 */
				}
			}, [mode]);

			// 全局按键处理：仅接管 Ctrl+`（含 Cmd+`），且只在浮层形态下生效。
			// 接入官方侧栏后由侧栏自己的快捷键负责开合。
			react.useEffect(() => {
				if (integrationMode !== "overlay") return;
				const onKey = (ev) => {
					const key = ev.key;
					const isTick = key === "`" || key === "~" || ev.code === "Backquote";
					if (isTick && (ev.ctrlKey || ev.metaKey) && !ev.altKey) {
						ev.preventDefault();
						ev.stopPropagation();
						setOpen((v) => !v);
					}
				};
				globalThis.addEventListener("keydown", onKey, true);
				return () => globalThis.removeEventListener("keydown", onKey, true);
			}, [integrationMode]);

			/**
			 * 拖拽左侧把手调整面板宽度。
			 * @param ev - pointerdown 事件。
			 * @returns 无返回值。
			 */
			const onGripDown = react.useCallback(
				(ev) => {
					ev.preventDefault();
					const startX = ev.clientX;
					const startW = width;
					/**
					 * 拖动中的宽度更新。
					 * @param e - pointermove 事件。
					 * @returns 无返回值。
					 */
					const move = (e) => {
						const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startW + (startX - e.clientX)));
						setWidth(next);
						core.refit(activeKeyRef.current);
					};
					/** 结束拖动并持久化宽度。 */
					const up = () => {
						globalThis.removeEventListener("pointermove", move);
						globalThis.removeEventListener("pointerup", up);
						const el = document.querySelector(".dsh-term-panel");
						const finalWidth = el !== null ? Math.round(el.getBoundingClientRect().width) : startW;
						try {
							globalThis.localStorage?.setItem(KEY_WIDTH, String(finalWidth));
						} catch {
							/* 隐私模式。 */
						}
					};
					globalThis.addEventListener("pointermove", move);
					globalThis.addEventListener("pointerup", up);
				},
				[width]
			);

			// 暴露一个调试/测试入口，便于在控制台直接开合与查看各工作区终端。
			react.useEffect(() => {
				globalThis.__DSH_TERMINAL__ = {
					open: () => setOpen(true),
					close: () => setOpen(false),
					toggle: () => setOpen((v) => !v),
					reconnect: () => core.reconnect(activeKeyRef.current),
					clear: () => core.clear(activeKeyRef.current),
					sessions: () => core.keys().map(labelOf),
					state: () => core.session(activeKeyRef.current)?.status ?? "wait",
					mode: () => mode,
					theme: () => getSettings().theme,
					toggleTheme: () => toggleTheme(),
					toggleLayout: () => setMode((m) => (m === MODE_DOCK ? MODE_OVERLAY : MODE_DOCK)),
					frameMargin: () => {
						const o = document.querySelector("[data-shell-overlay]");
						return o != null && o.parentElement !== null ? o.parentElement.style.marginRight : "";
					}
				};
			});

			// 已作为侧栏页签挂载：浮层完全让位，避免出现两个终端。
			if (integrationMode !== "overlay") return null;

			const act = core.session(activeKey);
			const state = act !== null ? act.status : "wait";
			const error = act !== null ? act.error : "";
			const shownCwd = typeof wsCwd === "string" && wsCwd !== "" ? wsCwd : (typeof info?.cwd === "string" ? info.cwd : labelOf(activeKey));
			// 「后台终端」只统计/展示与当前终端同一环境（本机 / 各 WSL 发行版 / 各 SSH 主机）的终端。
			const currentEnv = envOf(activeKey, info?.env);
			const envKeys = core.keys().filter((key) => envOf(key) === currentEnv);
			const count = envKeys.length;
			const clipboard = settings.clipboard;

			/** 面板主体（始终挂载，折叠时用 display:none 隐藏以保留所有 shell）。 */
			const panel = h(
				"div",
				{
					className: "dsh-term-panel",
					"data-dsh-terminal-panel": "1",
					"data-mode": mode,
					"data-theme": settings.theme,
					style: { width: `${width}px`, display: open ? "flex" : "none" },
					// 记下指针位置，供提示气泡的「跟随鼠标」档与键盘触发的复制使用。
					onPointerMove: trackPointer
				},
				h("div", { className: "dsh-term-grip", onPointerDown: onGripDown, title: tr("拖动调整宽度") }),
				renderToolbar({
					compact: false,
					status: state,
					statusTitle: error,
					shownCwd,
					count,
					keys: envKeys,
					shells: info !== null && Array.isArray(info.shells) ? info.shells : [],
					shellId: getShellChoice(activeKey) || info?.detectedShell?.id || "",
					detectedShell: info?.detectedShell,
					onShell: (id) => {
						setShellChoice(activeKey, id);
						core.reconnect(activeKey);
					},
					menuOpen,
					mode,
					theme: settings.theme,
					onTheme: toggleTheme,
					onMenu: () => setMenuOpen((v) => !v),
					onClear: () => core.clear(activeKey),
					onReconnect: () => core.reconnect(activeKey),
					onLayout: () => setMode((m) => (m === MODE_DOCK ? MODE_OVERLAY : MODE_DOCK)),
					onCollapse: () => setOpen(false)
				}),
				menuOpen
					? renderMenu({
							clipboard,
							onToggle: (key) => patchClipboard({ [key]: clipboard[key] !== true }),
							onToastPos: (pos) => patchClipboard({ toastPos: pos })
						})
					: null,
				renderBody({ containerRef: hostsRef, clipboard, toast, toastAt, error })
			);

			/** 折叠时的悬浮开合按钮。 */
			const tab =
				open === true
					? null
					: h(
							"button",
							{
								className: "dsh-term-tab",
								"data-theme": settings.theme,
								onClick: () => setOpen(true),
								title: tr("打开终端（Ctrl+`）")
							},
							renderDot(state),
							tr("终端")
						);

			const tree = h(react.Fragment, null, panel, tab);
			// 挂到 body：脱离 AppFrame 的 overflow:hidden，position:fixed 才能锚定视口右缘。
			return canPortal() ? reactDom.createPortal(tree, document.body) : tree;
		}
		//#endregion

		//#region 会话服务与图标

		/**
		 * 客户端 sessions 服务（会话列表 + 会话记录）。
		 *
		 * 本插件的 `inject` 只声明了 `slots`，没有注入 `sessions`，所以不能直接读
		 * `ctx.sessions`；Cordis 允许用 `ctx.get(name)` 取已注册的服务。
		 * @param ctx - 客户端上下文。
		 * @returns sessions 服务或 undefined。
		 */
		function sessionsServiceOf(ctx) {
			try {
				if (typeof ctx?.get === "function") {
					const fromGet = ctx.get("sessions");
					if (fromGet !== undefined && fromGet !== null) return fromGet;
				}
				return ctx?.sessions;
			} catch {
				return undefined;
			}
		}

		/**
		 * 会话当前的工作目录（官方侧栏只会给出 sessionId）。
		 * @param ctx - 客户端上下文（需要 sessions 服务）。
		 * @param sessionId - 会话 id。
		 * @returns 工作目录；会话服务不可用或没有 cwd 时返回 undefined。
		 */
		function sessionCwdOf(ctx, sessionId) {
			if (typeof sessionId !== "string" || sessionId === "") return undefined;
			try {
				const sessions = sessionsServiceOf(ctx);
				const snapshot = typeof sessions?.list?.getSnapshot === "function" ? sessions.list.getSnapshot() : undefined;
				const summary = snapshot?.byId?.[sessionId];
				if (typeof summary?.cwd === "string" && summary.cwd !== "") return summary.cwd;
				const record = typeof sessions?.get === "function" ? sessions.get(sessionId) : undefined;
				const cwd = record?.header?.cwd;
				if (typeof cwd === "string" && cwd !== "") return cwd;
			} catch {
				/* 会话服务不可用时回退默认目录。 */
			}
			return undefined;
		}

		/**
		 * 订阅会话列表变化（工作目录可能随会话切换而变）。
		 * @param ctx - 客户端上下文。
		 * @param listener - 变化回调。
		 * @returns 取消订阅函数。
		 */
		function subscribeSessions(ctx, listener) {
			try {
				const unsubscribe = sessionsServiceOf(ctx)?.list?.subscribe?.(listener);
				if (typeof unsubscribe === "function") return unsubscribe;
			} catch {
				/* 忽略：保持静态 cwd。 */
			}
			return () => {};
		}

		/**
		 * 官方侧栏引导页卡片与页签图标：终端提示符折线。
		 * @param props - { size } 图标尺寸。
		 * @returns SVG 元素。
		 */
		function TerminalGlyph(props) {
			const size = typeof props?.size === "number" ? props.size : 16;
			return h(
				"svg",
				{
					width: size,
					height: size,
					viewBox: "0 0 16 16",
					fill: "none",
					stroke: "currentColor",
					"stroke-width": 1.4,
					"stroke-linecap": "round",
					"stroke-linejoin": "round",
					"aria-hidden": "true"
				},
				h("path", { d: "M2.5 3.8 6.8 8l-4.3 4.2" }),
				h("path", { d: "M8.6 12.2h4.9" })
			);
		}

		//#endregion

		//#region 官方右侧栏页签形态（DSH 自带 sidebar-right）
		/**
		 * 作为 DSH 官方右侧栏页签渲染的终端。
		 *
		 * 官方侧栏只提供 sessionId（正文槽位的 inject 工厂），工作目录从
		 * `ctx.sessions` 的会话摘要里读；页签自己的位置/宽度/开合都由官方
		 * 侧栏管理，这里只保留终端本体与紧凑工具条。
		 * @param props - 官方侧栏正文槽位的属性（sessionId/cwdOf/subscribeSessions 由 inject 注入）。
		 * @returns 终端页签。
		 */
		function OfficialTerminalTab(props) {
			const sessionId = typeof props?.sessionId === "string" ? props.sessionId : "";
			const useTabInfo = props?.useTabInfo;
			const tabInfo = typeof useTabInfo === "function" ? useTabInfo() : null;
			const visible = tabInfo?.tab?.visible !== false;
			const signal = tabInfo?.tab?.signal;

			/** 当前会话的工作目录；会话服务变化时刷新。 */
			const [cwd, setCwd] = react.useState(() => (typeof props?.cwdOf === "function" ? props.cwdOf() : undefined));
			react.useEffect(() => {
				setCwd(typeof props?.cwdOf === "function" ? props.cwdOf() : undefined);
				return subscribeSessionsFromProps(props, setCwd);
			}, [sessionId]);

			const activeKey = keyOf(cwd);
			if (sessionId !== "" && typeof props?.onKey === "function") props.onKey(activeKey);

			const settings = useSettings();
			const { toast, toastAt, flash, trackPointer } = useFlash();
			// 订阅核心状态：连接状态/错误/常驻数量变化时重渲染工具条。
			useCoreVersion();
			const [menuOpen, setMenuOpen] = react.useState(false);
			useMenuDismiss(menuOpen, setMenuOpen);
			/** 宿主能力（可用 shell 列表等）；页签里用于渲染 shell 下拉。 */
			const [info, setInfo] = react.useState(null);
			const containerRef = react.useRef(null);

			// 拉取宿主信息：/info 里的 shells 是宿主探测到的可用 shell 目录。
			react.useEffect(() => {
				let alive = true;
				(async () => {
					const meta = await fetchInfo(activeKey);
					if (alive) setInfo(meta);
				})();
				return () => {
					alive = false;
				};
			}, [activeKey]);

			// 挂进页签容器；页签真正关闭（tab.signal 中止）时结束该工作区的 PTY。
			react.useEffect(() => {
				const container = containerRef.current;
				if (container === null) return;
				const s = core.attach(activeKey, container);
				if (s !== null) s.notify = flash;
				raf(() => core.refit(activeKey));
				return () => {
					if (s !== null) s.notify = null;
					core.detach(activeKey);
				};
			}, [activeKey, flash]);

			// 页签关闭（记录销毁）→ 回收 PTY；仅收起/切会话不会中止 signal。
			react.useEffect(() => {
				if (signal === undefined || signal === null) return;
				if (signal.aborted === true) {
					core.dispose(activeKey);
					return;
				}
				const onAbort = () => core.dispose(activeKey);
				signal.addEventListener("abort", onAbort);
				return () => signal.removeEventListener("abort", onAbort);
			}, [signal, activeKey]);

			// 页签重新可见时重算行列数并聚焦。
			react.useEffect(() => {
				if (!visible) return;
				raf(() => {
					core.refit(activeKey);
					core.focus(activeKey);
				});
			}, [visible, activeKey]);

			const act = core.session(activeKey);
			const state = act !== null ? act.status : "wait";
			const error = act !== null ? act.error : "";
			const shownCwd = labelOf(activeKey);
			// 只显示/统计当前环境（本机 / 各 WSL 发行版 / 各 SSH 主机）的后台终端。
			const currentEnv = envOf(activeKey, info?.env);
			const envKeys = core.keys().filter((key) => envOf(key) === currentEnv);
			const count = envKeys.length;
			const clipboard = settings.clipboard;

			return h(
				"div",
				{
					className: "dsh-term-embed",
					"data-dsh-terminal-embed": "official",
					"data-theme": settings.theme,
					onPointerMove: trackPointer
				},
				renderToolbar({
					compact: true,
					status: state,
					statusTitle: error,
					shownCwd,
					count,
					keys: envKeys,
					shells: info !== null && Array.isArray(info.shells) ? info.shells : [],
					shellId: getShellChoice(activeKey) || info?.detectedShell?.id || "",
					detectedShell: info?.detectedShell,
					onShell: (id) => {
						setShellChoice(activeKey, id);
						core.reconnect(activeKey);
					},
					menuOpen,
					mode: MODE_DOCK,
					theme: settings.theme,
					onTheme: toggleTheme,
					onMenu: () => setMenuOpen((v) => !v),
					onClear: () => core.clear(activeKey),
					onReconnect: () => core.reconnect(activeKey),
					onLayout: () => {},
					onCollapse: () => {}
				}),
				menuOpen
					? renderMenu({
							clipboard,
							onToggle: (key) => patchClipboard({ [key]: clipboard[key] !== true }),
							onToastPos: (pos) => patchClipboard({ toastPos: pos })
						})
					: null,
				renderBody({ containerRef, clipboard, toast, toastAt, error })
			);
		}

		/**
		 * 订阅会话列表（由官方侧栏注入的 subscribeSessions）。
		 * @param props - 正文槽位属性。
		 * @param setCwd - 刷新 cwd 的回调。
		 * @returns 清理函数。
		 */
		function subscribeSessionsFromProps(props, setCwd) {
			try {
				const unsubscribe = props?.subscribeSessions?.(() => {
					if (typeof props?.cwdOf === "function") setCwd(props.cwdOf());
				});
				return typeof unsubscribe === "function" ? unsubscribe : () => {};
			} catch {
				return () => {};
			}
		}
		//#endregion

		//#region 插件入口
		/** 需要的客户端服务：槽注册表（浮层面板与官方侧栏页签都在这里注册）。 */
		const inject = ["slots"];

		/**
		 * 注册为 DSH 官方右侧栏（sidebar-right）的页签类型。
		 *
		 * 只走公开扩展点：
		 * - `ctx.sidebarRightTabs.register()` 以 `priority: "extension"` 注册 kind
		 *   `"terminal"`，接管内置终端（builtin）：接管后开始页只留一个「新建终端」
		 *   入口，正文、标题槽与 Ctrl+` 快捷键都落到本插件；扩展卸载时内置定义自动恢复；
		 * - `ctx.slots.register({ name: "sidebar.right.pane.tab", key: 类型 id })`
		 *   注册正文组件（正文槽按「生效定义的 id」查找，key 必须是本插件 id）；
		 * - 关闭钩子由内置终端占用（同一 kind 只允许一个，重复注册会抛错），本插件
		 *   不再注册；PTY 由正文组件的 `tab.signal` 中止回收。
		 * @param ctx - 客户端上下文（需 sidebarRightTabs/slots；可选 sessions/sidebarRight）。
		 * @returns 是否成功接管界面。
		 */
		function applyOfficialSidebar(ctx) {
			const getService = (name) => (typeof ctx.get === "function" ? ctx.get(name) : undefined);
			const tabs = getService(OFFICIAL_TABS_SERVICE);
			if (tabs === undefined || tabs === null || typeof tabs.register !== "function") return false;
			const slots = ctx.slots;
			if (slots === undefined || slots === null || typeof slots.register !== "function") return false;

			/**
			 * 读取此刻仍在生效的内置终端定义（本插件注册前，builtin 就是当前生效者）。
			 *
			 * 接管只接管「谁响应 kind」，外观与文案必须和内置卡片一字不差：标题、
			 * 图标、描述、排序全部直接复用内置定义的字段——它们是官方 locale 的
			 * thunk 与官方图标组件，切换语言、官方换图标都会自动跟随，不需要本插件
			 * 自己再写一份文案或图形。
			 * @returns 内置定义；读不到（注册顺序更早、服务不支持 get）时为 null。
			 */
			function heldDefinition() {
				try {
					const held = typeof tabs.get === "function" ? tabs.get(OFFICIAL_KIND) : undefined;
					if (held === null || held === undefined || held.kind !== OFFICIAL_KIND) return null;
					if (typeof held.title !== "function" || !Array.isArray(held.guide)) return null;
					return held;
				} catch {
					return null;
				}
			}

			const held = heldDefinition();
			/**
			 * 官方开始页卡片/页签用的终端图形组件（`PluginArtworkTerminal`）。
			 *
			 * 冷启动时本插件可能先于内置终端插件注册，读不到内置定义；但官方
			 * primitives 是 Web 端的「平台种子模块」（`__ModuleLoader__` 的
			 * staticModules 里），任何插件都能 require 到同一个组件实例，
			 * 所以即使拿不到内置定义，卡片图形仍与原生完全一致。
			 * @returns 图标组件；种子模块不可用时退回本插件的折线图形。
			 */
			function cardIcon() {
				try {
					const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
					const artwork = primitives === null || primitives === undefined ? undefined : primitives.PluginArtworkTerminal;
					if (typeof artwork === "function") return artwork;
				} catch {
					// 宿主没有提供该种子模块（非官方 Web 端）：退回自带图形。
				}
				return TerminalGlyph;
			}
			/**
			 * 与内置终端完全一致的引导卡片：能读到内置定义就直接用它那条 guide 条目，
			 * 只有读不到时才用官方的图标组件与同款中文文案。
			 */
			const guide = held === null
				? [
					{
						id: "new",
						order: 20,
						// 让卡片右下角显示官方「新建终端」的快捷键（Ctrl+`）。
						commandId: "terminal.new",
						title: () => tr("新建终端"),
						description: () => tr("在会话工作区运行命令"),
						icon: cardIcon()
					}
				]
				: held.guide.map((entry) => {
					// 内置卡片不写 commandId（它的快捷键硬编码在官方组件里），这里补上，
					// 让默认卡片右下角同样显示 Ctrl+`。
					const commandId = typeof entry.commandId === "string" ? entry.commandId : "terminal.new";
					return { ...entry, commandId };
				});
			const definition = {
				id: OFFICIAL_TYPE_ID,
				kind: OFFICIAL_KIND,
				// 一个会话只留一个终端页：PTY 按工作目录复用，多开只会互相抢同一个终端。
				multiple: false,
				keepMounted: true,
				priority: "extension",
				title: held === null ? () => tr("终端") : held.title,
				guide
			};
			try {
				if (typeof ctx.effect === "function") {
					ctx.effect(() => tabs.register(definition), "ui-terminal.official-type");
				} else {
					tabs.register(definition);
				}
			} catch (error) {
				console.error("[remote-suite] 注册官方侧栏页签类型失败，回退到浮层面板：", error);
				return false;
			}

			slots.inject("sidebar.right.pane.tab", () =>
				slots.register(
					{
						name: "sidebar.right.pane.tab",
						key: OFFICIAL_TYPE_ID,
						inject: (sessionId) => ({
							sessionId,
							cwdOf: () => sessionCwdOf(ctx, sessionId),
							subscribeSessions: (listener) => subscribeSessions(ctx, listener)
						})
					},
					OfficialTerminalTab
				)
			);

			integration.set("sidebar");
			return true;
		}

		/**
		 * 挂载原来的独立浮层面板（root 作用域的 `shell.overlay` 列表槽）。
		 *
		 * 用 `slots.inject()` 而不是直接 register，是因为目标槽的声明可能由
		 * ui-layout 稍后激活或被替换；inject 会在槽存在时再执行注册，并在槽
		 * 重新声明后自动重放。
		 * @param ctx - 客户端根上下文。
		 * @returns 无返回值。
		 */
		function mountOverlay(ctx) {
			if (ctx.slots === undefined || ctx.slots === null || typeof ctx.slots.inject !== "function") {
				console.error("[remote-suite] 当前客户端没有 slots 服务，无法挂载独立终端面板。");
				return;
			}
			ctx.slots.inject("shell.overlay", function* () {
				try {
					yield ctx.slots.register({ name: "shell.overlay", id: "terminal", order: 100 }, TerminalPanel);
				} catch (error) {
					console.error("[remote-suite] 注册 shell.overlay 槽失败：", error);
				}
			});
		}

		/**
		 * 客户端插件主体（按可用能力选择唯一一种 UI 形态）：
		 * 1. DSH 官方右侧栏（0.2.2+ 自带）→ 以扩展档接管内置终端 kind；
		 * 2. 没有官方右侧栏 → 独立浮层面板兜底。
		 *
		 * 不把 sidebarRightTabs 写死进 exports.inject：否则缺少该服务的环境会一直
		 * 等注入、连浮层都加载不出来。这里用 ctx.get 探测，并用 ctx.inject 兜住
		 * 「服务稍后才激活」的顺序问题。
		 * @param ctx - 客户端根上下文。
		 * @returns 无返回值。
		 */
		function apply(ctx) {
			try {
				ensureStyle();
			} catch (error) {
				console.error("[remote-suite] 注入样式失败：", error);
			}

			// 主题切换同步到所有常驻终端；插件卸载时回收全部 PTY 会话。
			subscribeSettings((next) => core.applyTheme(themeOf(next.theme)));
			if (typeof ctx.effect === "function") {
				ctx.effect(() => () => core.disposeAll());
			}

			// 1) 官方右侧栏：DSH 0.2.2+ 自带，接管内置终端 kind 是主形态。
			if (typeof ctx.get === "function") {
				const official = ctx.get(OFFICIAL_TABS_SERVICE);
				if (official !== undefined && official !== null && typeof official.register === "function") {
					// 官方侧栏存在时只走官方扩展点：接管失败就退浮层，避免出现两个终端入口。
					if (applyOfficialSidebar(ctx)) return;
					mountOverlay(ctx);
					return;
				}
			}

			// 2) 没有官方侧栏：独立浮层面板兜底。
			mountOverlay(ctx);

			// 服务晚到时再接管一次（官方侧栏可能与本插件并发加载），避免停留在浮层。
			if (typeof ctx.inject === "function") {
				ctx.inject([OFFICIAL_TABS_SERVICE], (injected) => {
					if (integration.mode === "sidebar") return;
					const official = typeof injected.get === "function" ? injected.get(OFFICIAL_TABS_SERVICE) : undefined;
					if (official === undefined || official === null || typeof official.register !== "function") return;
					if (applyOfficialSidebar(injected)) return;
					console.error("[remote-suite] 切换官方右侧栏失败，保持浮层形态");
				});
			}
		}
		//#endregion


		exports.apply = apply;
		exports.ensureStyle = ensureStyle;
		exports.disposeAll = () => core.disposeAll();
		exports.OfficialTerminalTab = OfficialTerminalTab;
		exports.sessionCwdOf = sessionCwdOf;
		exports.subscribeSessions = subscribeSessions;
		exports.TerminalGlyph = TerminalGlyph;
		exports.constants = {
			OFFICIAL_KIND,
			OFFICIAL_TYPE_ID,
			OFFICIAL_TABS_SERVICE,
			INFO_PATH,
			WS_PATH,
		};
		return module.exports;
    })()

    // ---------------------------------------------------------------------
    // Takeover switches
    //
    // Two of the Host's own panes are replaced by this plugin: the workspace
    // file tree and the terminal. Both replacements are optional, both default
    // to on, and both live in state.json beside the workspaces so one file
    // describes the whole plugin.
    //
    // A pane can be claimed by one extension at a time — the registry throws on
    // a second claim — so a refused claim switches that toggle off and records
    // who holds the pane instead of leaving the UI in a lie. Turning the toggle
    // back on retries, which is also how a user recovers after uninstalling
    // whichever plugin was holding it.
    // ---------------------------------------------------------------------

    const FILES_TAB_ID = PANEL_ID + '/files'
    const TERMINAL_TAB_ID = PANEL_ID + '/terminal'
    const TAKEOVER_IDS = { files: FILES_TAB_ID, terminal: TERMINAL_TAB_ID }
    // dsh-better-sidebar claims the `files` kind at extension level. The host
    // allows exactly one extension per kind and the loser throws, so when it is
    // installed it keeps that pane and we keep supplying the data (its file pane
    // already calls the /sidebar/api routes mounted by this plugin). The terminal
    // kind is ours either way: better-sidebar's terminal is part of its own
    // layout, not a right-sidebar tab.
    const BETTER_SIDEBAR_ID = 'dsh-better-sidebar'

    let takeoverSettings = { takeOverFiles: true, takeOverTerminal: true }
    const takeoverHolders = { files: null, terminal: null }
    const takeoverListeners = new Set()
    const takeoverMounts = { files: null, terminal: null }
    let takeoverCtx = null

    function takeoverSnapshot() {
      return takeoverSettings
    }

    function subscribeTakeover(listener) {
      takeoverListeners.add(listener)
      return () => takeoverListeners.delete(listener)
    }

    function emitTakeover(patch) {
      takeoverSettings = { ...takeoverSettings, ...patch }
      for (const listener of [...takeoverListeners]) {
        try {
          listener()
        } catch (error) {
          console.error('dsh-remote-suite: a takeover listener threw', error)
        }
      }
    }

    function useTakeoverSettings() {
      return React.useSyncExternalStore(subscribeTakeover, takeoverSnapshot, takeoverSnapshot)
    }

    function sidebarTabs(ctx) {
      try {
        const tabs = typeof ctx.get === 'function' ? ctx.get('sidebarRightTabs') : ctx.sidebarRightTabs
        if (tabs === undefined || tabs === null || typeof tabs.register !== 'function') return null
        return tabs
      } catch {
        return null
      }
    }

    /** Who is currently answering `kind`, or null when nobody is. */
    function heldPane(ctx, kind) {
      const tabs = sidebarTabs(ctx)
      if (tabs === null || typeof tabs.get !== 'function') return null
      try {
        const held = tabs.get(kind)
        if (held === undefined || held === null) return null
        return { id: String(held.id ?? ''), band: held.priority ?? 'extension', definition: held }
      } catch {
        return null
      }
    }

    function terminalCardIcon() {
      try {
        const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
        const artwork = primitives === null || primitives === undefined ? undefined : primitives.PluginArtworkTerminal
        if (typeof artwork === 'function') return artwork
      } catch {
        // Non-web hosts have no primitives seed module; fall back to our glyph.
      }
      return remoteTerminal.TerminalGlyph
    }

    function mountFilesPane(ctx, tabs) {
      const disposers = []
      disposers.push(
        tabs.register({
          id: FILES_TAB_ID,
          kind: 'files',
          keepMounted: true,
          priority: 'extension',
          title: () => tr('文件'),
          guide: [
            {
              id: 'files',
              order: 10,
              title: () => tr('文件'),
              description: () => tr('浏览工作区文件树，点开即预览或编辑'),
              icon: filesGuideIcon,
            },
          ],
        }),
      )
      disposers.push(
        ctx.slots.inject('sidebar.right.pane.tab', () =>
          ctx.slots.register(
            { name: 'sidebar.right.pane.tab', key: FILES_TAB_ID, inject: (sessionId) => ({ sessionId }) },
            FilesPanel,
          ),
        ),
      )
      return disposers
    }

    function mountTerminalPane(ctx, tabs) {
      // Reuse the built-in definition's title, guide and artwork when it is
      // readable, so the tab and its start card stay identical to the pane
      // being replaced and follow the host locale automatically.
      const held = heldPane(ctx, 'terminal')
      const builtin = held === null ? null : held.definition
      const usable = builtin !== null && typeof builtin.title === 'function' && Array.isArray(builtin.guide)
      const guide = usable
        ? builtin.guide.map((entry) => ({
            ...entry,
            commandId: typeof entry.commandId === 'string' ? entry.commandId : 'terminal.new',
          }))
        : [
            {
              id: 'new',
              order: 20,
              commandId: 'terminal.new',
              title: () => tr('新建终端'),
              description: () => tr('在会话工作区运行命令'),
              icon: terminalCardIcon(),
            },
          ]
      const disposers = []
      disposers.push(
        tabs.register({
          id: TERMINAL_TAB_ID,
          kind: 'terminal',
          multiple: false,
          keepMounted: true,
          priority: 'extension',
          title: usable ? builtin.title : () => tr('终端'),
          guide,
        }),
      )
      disposers.push(
        ctx.slots.inject('sidebar.right.pane.tab', () =>
          ctx.slots.register(
            {
              name: 'sidebar.right.pane.tab',
              key: TERMINAL_TAB_ID,
              inject: (sessionId) => ({
                sessionId,
                cwdOf: () => remoteTerminal.sessionCwdOf(ctx, sessionId),
                subscribeSessions: (listener) => remoteTerminal.subscribeSessions(ctx, listener),
              }),
            },
            remoteTerminal.OfficialTerminalTab,
          ),
        ),
      )
      return disposers
    }

    function disposeTakeover(kind) {
      const current = takeoverMounts[kind]
      takeoverMounts[kind] = null
      if (takeoverHolders[kind] === TAKEOVER_IDS[kind]) takeoverHolders[kind] = null
      if (current === null) return
      for (const dispose of current.slice().reverse()) {
        try {
          if (typeof dispose === 'function') dispose()
        } catch (error) {
          console.warn('[dsh-remote-suite] 释放 ' + kind + ' 接管失败', error)
        }
      }
    }

    function persistTakeover(patch) {
      return call('settings-set', patch).catch((error) => {
        console.warn('[dsh-remote-suite] 保存接管设置失败', error)
        return null
      })
    }

    /**
     * Bring the live registrations in line with the switches: mount what is on
     * and not yet mounted, unmount what is off, and switch a pane off when its
     * extension slot belongs to someone else.
     */
    /**
     * True when dsh-better-sidebar is loaded: it exposes a `betterSidebar`
     * service. It claims the `files` tab kind, and the host refuses the second
     * extension-level claim, so taking that pane over would only make it throw.
     */
    function betterSidebarLoaded(ctx) {
      try {
        return ctx !== null && ctx !== undefined && typeof ctx.get === 'function' && ctx.get('betterSidebar') !== undefined
      } catch {
        return false
      }
    }

    function applyTakeovers(ctx) {
      takeoverCtx = ctx
      const tabs = sidebarTabs(ctx)
      if (tabs === null) return
      const betterSidebar = betterSidebarLoaded(ctx)
      for (const kind of ['files', 'terminal']) {
        const enabled = kind === 'files' ? takeoverSettings.takeOverFiles : takeoverSettings.takeOverTerminal
        if (!enabled) {
          disposeTakeover(kind)
          // Whoever holds the slot now (usually DSH's builtin) is the label.
          const after = heldPane(ctx, kind)
          takeoverHolders[kind] = after === null || after.id === TAKEOVER_IDS[kind] || after.band !== 'extension'
            ? null
            : after.id
          continue
        }
        // dsh-better-sidebar only claims the `files` kind (its terminal lives in
        // its own layout, not as a right-sidebar tab), so the file pane is the
        // only one it can lose a registration race over.
        if (betterSidebar && kind === 'files') {
          // Let it draw the pane; the switch still means "this plugin supplies
          // the files", which is what /sidebar/api does for its file pane.
          disposeTakeover(kind)
          if (takeoverHolders[kind] !== BETTER_SIDEBAR_ID) {
            takeoverHolders[kind] = BETTER_SIDEBAR_ID
            console.info('[dsh-remote-suite] dsh-better-sidebar 已安装，文件页签由它显示，数据仍由本插件提供')
          }
          continue
        }
        if (takeoverMounts[kind] !== null) continue
        const held = heldPane(ctx, kind)
        if (held !== null && held.band === 'extension' && held.id !== TAKEOVER_IDS[kind]) {
          takeoverHolders[kind] = held.id
          emitTakeover(kind === 'files' ? { takeOverFiles: false } : { takeOverTerminal: false })
          // The terminal plugin this feature came from is merged into this one:
          // say so instead of leaving a bare "someone else holds it".
          const merged = kind === 'terminal' && /dsh-terminal/.test(held.id)
          console.warn(
            '[dsh-remote-suite] 右侧栏 ' + kind + ' 页签已被 ' + held.id + ' 占用，这项接管已自动关闭' +
              (merged ? '（终端功能已并入本插件，卸掉 @lylgj/dsh-terminal 后本插件即可接管）' : ''),
          )
          void persistTakeover(kind === 'files' ? { takeOverFiles: false } : { takeOverTerminal: false })
          continue
        }
        try {
          takeoverMounts[kind] = kind === 'files' ? mountFilesPane(ctx, tabs) : mountTerminalPane(ctx, tabs)
          takeoverHolders[kind] = TAKEOVER_IDS[kind]
        } catch (error) {
          console.error('dsh-remote-suite: the ' + kind + ' takeover could not be registered', error)
          takeoverHolders[kind] = held === null ? null : held.id
          emitTakeover(kind === 'files' ? { takeOverFiles: false } : { takeOverTerminal: false })
          void persistTakeover(kind === 'files' ? { takeOverFiles: false } : { takeOverTerminal: false })
        }
      }
      emitTakeover({})
    }

    async function readTakeoverSettings(ctx) {
      // Nothing to reconcile against when the host cannot be reached (a pasted
      // page served from elsewhere, or a test harness): keep the defaults.
      if (typeof fetch !== 'function') return
      try {
        const value = await call('settings')
        emitTakeover({
          takeOverFiles: value === null || value === undefined ? true : value.takeOverFiles !== false,
          takeOverTerminal: value === null || value === undefined ? true : value.takeOverTerminal !== false,
        })
        applyTakeovers(ctx)
      } catch (error) {
        console.warn('[dsh-remote-suite] 读取接管设置失败，沿用默认（都接管）', error)
      }
    }

    function toggleTakeover(kind, enabled) {
      emitTakeover(kind === 'files' ? { takeOverFiles: enabled } : { takeOverTerminal: enabled })
      applyTakeovers(takeoverCtx)
      void persistTakeover(kind === 'files' ? { takeOverFiles: enabled } : { takeOverTerminal: enabled })
    }

    function holderLabel(kind, enabled) {
      if (kind === 'files' && takeoverHolders[kind] === BETTER_SIDEBAR_ID) {
        return tr('当前：dsh-better-sidebar 的面板（数据由本插件提供）')
      }
      if (enabled) return tr('当前：本插件接管')
      const holder = takeoverHolders[kind]
      if (holder === null || holder === '') return tr('当前：DSH 自带')
      return tr('当前：{name} 接管', { name: holder })
    }

    /** Row glyph for the takeover switches: a folder or a terminal card. */
    function settingsGlyph(kind) {
      const common = { width: 18, height: 18, viewBox: '0 0 16 16', 'aria-hidden': 'true', fill: 'none' }
      if (kind === 'files') {
        return h(
          'svg',
          common,
          h('path', {
            d: 'M1.9 4.1c0-.6.5-1.1 1.1-1.1h3.2l1.4 1.7h5.4c.6 0 1.1.5 1.1 1.1v6.6c0 .6-.5 1.1-1.1 1.1H3c-.6 0-1.1-.5-1.1-1.1V4.1Z',
            stroke: 'currentColor',
            strokeWidth: 1.25,
            strokeLinejoin: 'round',
          }),
        )
      }
      return h(
        'svg',
        common,
        h('rect', {
          x: 1.7,
          y: 2.6,
          width: 12.6,
          height: 10.8,
          rx: 2,
          stroke: 'currentColor',
          strokeWidth: 1.25,
        }),
        h('path', {
          d: 'M4.4 6.1 6.6 8l-2.2 1.9M8.3 10.2h3.4',
          stroke: 'currentColor',
          strokeWidth: 1.25,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      )
    }

    function TakeoverSettings() {
      useTakeoverSettings()
      const rows = [
        {
          kind: 'files',
          enabled: takeoverSettings.takeOverFiles,
          title: tr('接管工作区文件'),
          hint: tr('本机 / WSL / SSH / Docker'),
        },
        {
          kind: 'terminal',
          enabled: takeoverSettings.takeOverTerminal,
          title: tr('接管终端'),
          hint: tr('cmd / PowerShell / WSL / SSH'),
        },
      ]
      return h(
        'div',
        { className: 'rs-set' },
        rows.map((row) =>
          h(
            'div',
            { className: 'rs-set-row', key: row.kind },
            h('div', { className: 'rs-set-glyph' }, settingsGlyph(row.kind)),
            h(
              'div',
              { className: 'rs-set-main' },
              h('div', { className: 'rs-set-title' }, row.title),
              h('div', { className: 'rs-set-hint' }, row.hint),
              h(
                'div',
                { className: 'rs-set-state' + (row.enabled && takeoverHolders[row.kind] !== BETTER_SIDEBAR_ID ? ' is-on' : '') },
                holderLabel(row.kind, row.enabled),
              ),
            ),
            h(
              'button',
              {
                type: 'button',
                role: 'switch',
                'aria-checked': row.enabled ? 'true' : 'false',
                className: 'rs-set-switch' + (row.enabled ? ' is-on' : ''),
                onClick: () => toggleTakeover(row.kind, !row.enabled),
              },
              h('span', { className: 'rs-set-knob' }),
            ),
          ),
        ),
        h('p', { className: 'rs-set-foot' }, tr('改动立即生效，不需要重启。')),
      )
    }

    function registerTakeoverSettings(ctx, stops) {
      try {
        stops.push(
          ctx.slots.inject('settings.section', () =>
            ctx.slots.register(
              { name: 'settings.section', id: PANEL_ID, order: 60, label: () => tr('接管设置') },
              TakeoverSettings,
            ),
          ),
        )
      } catch (error) {
        console.error('dsh-remote-suite: the takeover settings section could not mount', error)
      }
    }

    function registerSeats(ctx, stops) {
      try {
        stops.push(
          ctx.slots.inject('shell.overlay', () =>
            ctx.slots.register({ name: 'shell.overlay', id: PANEL_ID, order: 100 }, WorkbenchOverlay),
          ),
        )
      } catch (error) {
        console.error('dsh-remote-suite: the workbench could not mount in shell.overlay', error)
      }
      try {
        stops.push(
          ctx.slots.inject('sidebar.panellist', () =>
            ctx.slots.register(
              { name: 'sidebar.panellist', id: PANEL_ID, order: 47, label: () => '远程' },
              RailEntry,
            ),
          ),
        )
      } catch (error) {
        console.error('dsh-remote-suite: the rail entry could not mount in sidebar.panellist', error)
      }
      // The partner of the rail entry: the host resolves a rail click to the
      // `main` panel sharing the id, so this seat must exist for the icon to
      // react at all. It renders nothing and opens the floating workbench.
      try {
        stops.push(
          ctx.slots.inject('main', () =>
            ctx.slots.register(
              { name: 'main', key: PANEL_ID, inject: () => ({ layout: layoutServices.layout }) },
              MainLaunch,
            ),
          ),
        )
      } catch (error) {
        console.error('dsh-remote-suite: the launch panel could not mount in main', error)
      }
    }

    function apply(ctx) {
      appCtx = ctx
      if (ctx.slots === undefined || ctx.slots === null) {
        console.error('dsh-remote-suite: this DSH has no slots service; the remote panel stays off')
        return
      }
      ensureStyle()
      workspaceServices.workspaces = typeof ctx.get === 'function' ? ctx.get('workspaces') : null
      workspaceServices.uiWorkspace = typeof ctx.get === 'function' ? ctx.get('uiWorkspace') || null : null
      workspaceServices.sessions = typeof ctx.get === 'function' ? ctx.get('sessions') || null : null
      // The files panel follows the DSH interface language, like the pane it
      // takes over: Chinese when the Host locale is Chinese, English otherwise.
      attachLocale(typeof ctx.get === 'function' ? ctx.get('locale') : ctx.locale)
      layoutServices.layout =
        typeof ctx.get === 'function' ? ctx.get('layout') || null : null
      if (layoutServices.layout === null && ctx.layout !== undefined) layoutServices.layout = ctx.layout
      // The scoped form below is what dshmarket uses, and it is the only one
      // guaranteed to hand over a live layout service on every host build.
      if (typeof ctx.inject === 'function') {
        try {
          ctx.inject(['layout'], (scoped) => {
            if (scoped !== undefined && scoped !== null && scoped.layout !== undefined) {
              layoutServices.layout = scoped.layout
            }
          })
        } catch (error) {
          console.error('dsh-remote-suite: the layout service could not be resolved', error)
        }
      }
      var stops = []
      for (const seat of FLOW_SLOTS) {
        try {
          stops.push(
            ctx.slots.inject(seat, () =>
              ctx.slots.register({ name: seat, priority: -100 }, AddWorkspaceFlow),
            ),
          )
        } catch (error) {
          console.error('dsh-remote-suite: the add-workspace flow could not mount in ' + seat, error)
        }
      }
      registerSeats(ctx, stops)
      registerTakeoverSettings(ctx, stops)
      // The terminal pane's stylesheet (and its xterm asset loader) lives in the
      // merged bundle; the pane itself is registered by applyTakeovers below.
      try {
        remoteTerminal.ensureStyle()
      } catch (error) {
        console.error('dsh-remote-suite: the terminal styles could not be injected', error)
      }
      if (typeof ctx.effect === 'function') {
        ctx.effect(() => () => remoteTerminal.disposeAll(), 'dsh-remote-suite: terminal sessions')
      }
      // Claim both panes right away with the defaults, then reconcile with what
      // is persisted: registration order decides who wins an extension slot, so
      // waiting for the HTTP round-trip would hand the pane to a plugin that
      // loaded faster.
      applyTakeovers(ctx)
      void readTakeoverSettings(ctx)
      return () => {
        for (const stop of stops) {
          if (typeof stop === 'function') stop()
        }
        disposeTakeover('files')
        disposeTakeover('terminal')
      }
    }

    return { apply, inject }
  },
})
