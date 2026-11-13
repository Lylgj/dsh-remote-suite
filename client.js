// dsh-remote-suite, browser half.
//
// A plain hand-written bundle, exactly like the ones DSH ships: no build step,
// no import/export keywords, no JSX. The page loads it as a script, the module
// loader hands it a `require`, and the only modules it may ask for are React
// and the client UI primitives declared in package.json's `dsh.client.inject`.
//
// What it contributes:
//   - one rail entry in the left sidebar (`sidebar.panellist`), whose panel is
//     the target switcher, saved workspaces and the file tree, and
//   - the `main` seat under the same key: editor tabs plus a command console.
//
// Everything it shows comes from the host half's JSON API (`/remote-suite/api`),
// never from the filesystem directly, so the browser half has no idea whether a
// path lives on Windows, in a WSL distribution or behind SSH.
//
// Layout facts (verified against dsh-wsl-tool's panel, which uses the same seats):
//   - `sidebar.panellist` entries carry `id`, `order` and `label`, and render
//     their own icon (there is no icon field).
//   - `main` is keyed by that same id; the two seats appear together or not at all.

window.__ModuleLoader__.load({
  id: 'dsh-remote-suite',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
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
    // Store: one shared object, because the sidebar panel and the main seat
    // are two separate mounts.
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
      addOpen: false,
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

    function openDialog() {
      setState({ addOpen: true })
    }

    function closeDialog() {
      setState({ addOpen: false })
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

    function closeTab(index) {
      const closing = state.tabs[index]
      if (closing !== undefined && closing.kind === 'web' && closing.forwardId !== undefined) {
        // Best effort: the tab is going away either way.
        call('forward-close', { forward: closing.forwardId }).catch(() => {})
      }
      setState((current) => {
        const tabs = current.tabs.filter((_, i) => i !== index)
        let active = current.active
        if (active === index) active = Math.min(index, tabs.length - 1)
        else if (active > index) active -= 1
        return { tabs, active }
      })
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
      .rs-workspace { display: flex; height: 100%; min-height: 0; }
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
      .rs-main { display: flex; flex-direction: column; height: 100%; min-height: 0; }
      .rs-tabs { display: flex; align-items: stretch; gap: 2px; border-bottom: 1px solid var(--dsh-border, rgba(127,127,127,0.25));
                 padding: 0 6px; overflow-x: auto; }
      .rs-tab { display: flex; align-items: center; gap: 6px; padding: 5px 10px; font-size: 12px; cursor: pointer;
                border-bottom: 2px solid transparent; white-space: nowrap; }
      .rs-tab.active { border-bottom-color: var(--dsh-accent, #4b8bf5); }
      .rs-tab .rs-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--dsh-accent, #4b8bf5); }
      .rs-body { flex: 1; min-height: 0; display: flex; }
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
      .rs-term-wrap { flex: 1; display: flex; flex-direction: column; min-height: 0; }
      .rs-term-bar { display: flex; align-items: center; gap: 8px; padding: 4px 10px; font-size: 12px;
                border-bottom: 1px solid var(--dsh-border, rgba(127,127,127,0.25)); }
      .rs-xterm { flex: 1; min-height: 0; padding: 4px 6px; }
      .rs-xterm .xterm { height: 100%; }
      .rs-xterm .xterm-viewport { background: transparent !important; }
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
      .rs-flow-row { display: flex; align-items: center; gap: 8px; min-width: 0; }
      .rs-flow-row > input, .rs-flow-row > select, .rs-flow-row > button, .rs-flow-row > .rs-select,
      .rs-flow input, .rs-flow select, .rs-flow .rs-select { height: 34px; box-sizing: border-box;
        padding: 0 10px; font: inherit; line-height: 32px; }
      .rs-flow-row > button { padding: 0 12px; }
      .rs-flow-row > select { line-height: normal; }
      .rs-flow-row > :first-child { flex: 1; min-width: 0; }
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
      .rs-picker-card { width: min(560px, 92vw); max-height: min(560px, 84vh); display: flex;
        flex-direction: column; overflow: hidden; border-radius: 12px;
        border: 1px solid color-mix(in srgb, currentColor 14%, transparent);
        background: var(--dsh-surface, #ffffff); color: inherit; box-shadow: 0 18px 48px rgba(0, 0, 0, 0.28); }
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

    function TreeNode({ entry, depth }) {
      const store = useStore()
      const expanded = store.expanded[entry.path] === true
      const node = store.dirs[entry.path]

      const onActivate = () => {
        if (entry.type === 'dir') toggleDir(entry.path)
        else openFile(entry.path)
      }

      const icon = entry.type === 'dir' ? (expanded ? '▾' : '▸') : entry.type === 'file' ? '·' : '?'
      const children = []
      children.push(
        h(
          'div',
          { key: 'row', className: 'rs-node', style: { paddingLeft: `${8 + depth * 12}px` }, onClick: onActivate, title: entry.name },
          h('span', { style: { width: '12px', textAlign: 'center', opacity: 0.7 } }, icon),
          h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, entry.name),
        ),
      )
      if (entry.type === 'dir' && expanded) {
        if (node === undefined || node.loading === true) {
          children.push(h('div', { key: 'loading', className: 'rs-dim', style: { paddingLeft: `${20 + depth * 12}px` } }, '加载中…'))
        } else if (node.error) {
          children.push(h('div', { key: 'error', className: 'rs-err' }, node.error))
        } else {
          for (const child of node.entries) {
            children.push(h(TreeNode, { key: child.path, entry: child, depth: depth + 1 }))
          }
          if (node.entries.length === 0) {
            children.push(h('div', { key: 'empty', className: 'rs-dim', style: { paddingLeft: `${20 + depth * 12}px` } }, '（空）'))
          }
        }
      }
      return h(React.Fragment, null, children)
    }

    function Panel() {
      useStyle()
      const store = useStore()
      const [rootText, setRootText] = React.useState('')
      const [portText, setPortText] = React.useState('')
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
          tree.push(h('div', { key: 'error', className: 'rs-err' }, rootNode.error))
        } else {
          for (const entry of rootNode.entries) {
            tree.push(h(TreeNode, { key: entry.path, entry, depth: 0 }))
          }
        }
      }

      const changeTarget = async (id) => {
        await selectTarget(id)
      }

      const goTo = async () => {
        const next = rootText.trim()
        if (next === '') return
        setState({ root: next, expanded: {} })
        await loadDir(next)
      }

      return h(
        'div',
        { className: 'rs-root' },
        h(
          'div',
          { className: 'rs-title' },
          h('span', null, '远程'),
          h(
            'button',
            { className: 'rs-btn', onClick: () => initialize() },
            '刷新',
          ),
        ),
        h(
          'div',
          { className: 'rs-row' },
          h(
            'select',
            {
              className: 'rs-select',
              style: { flex: 1 },
              value: store.target === null ? '' : store.target,
              onChange: (event) => changeTarget(event.target.value),
            },
            store.targets.map((target) => h('option', { key: target.id, value: target.id }, target.label || target.id)),
          ),
        ),
        store.workspaces.length > 0
          ? h(
              'div',
              { className: 'rs-chips' },
              store.workspaces.map((workspace) =>
                h(
                  'span',
                  { key: workspace.id, className: 'rs-chip', onClick: () => openWorkspace(workspace), title: `${workspace.targetId}:${workspace.path}` },
                  workspace.name,
                  h(
                    'span',
                    {
                      className: 'rs-x',
                      onClick: (event) => {
                        event.stopPropagation()
                        removeWorkspace(workspace.id)
                      },
                    },
                    '×',
                  ),
                ),
              ),
            )
          : null,
        h(
          'div',
          { className: 'rs-row', style: { paddingBottom: '6px' } },
          h('input', {
            className: 'rs-input',
            value: rootText,
            spellCheck: false,
            onChange: (event) => setRootText(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') goTo()
            },
          }),
          h('button', { className: 'rs-btn', onClick: goTo }, '前往'),
        ),
        h('div', { className: 'rs-tree' }, tree),
        store.error !== null ? h('div', { className: 'rs-err', style: { paddingBottom: '6px' } }, store.error) : null,
        h(
          'div',
          { className: 'rs-row', style: { paddingBottom: '6px' } },
          h('input', {
            className: 'rs-input',
            value: portText,
            spellCheck: false,
            placeholder: '远端端口，如 3000',
            onChange: (event) => setPortText(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') openForward(Number.parseInt(portText.trim(), 10))
            },
          }),
          h(
            'button',
            { className: 'rs-btn', onClick: () => openForward(Number.parseInt(portText.trim(), 10)), disabled: store.target === null },
            '转发',
          ),
        ),
        h(
          'div',
          { className: 'rs-row', style: { paddingBottom: '10px' } },
          h('button', { className: 'rs-btn rs-primary', onClick: openDialog }, '＋ 添加工作区'),
          h('button', { className: 'rs-btn', onClick: addWorkspace, disabled: store.root === null }, '存为工作区'),
        ),
      )
    }

    // ---------------------------------------------------------------------
    // "Add workspace": local / WSL / Docker / SSH, each landing on a real DSH
    // workspace. WSL directories are reachable through their 9p UNC path;
    // SSH and Docker directories are not, so those workspaces open on a local
    // mirror directory and the remote path stays in this plugin's state.
    // ---------------------------------------------------------------------

    const workspaceServices = { workspaces: null, uiWorkspace: null }

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
          // Start where the field already points: a key outside ~/.ssh (D:\lgj\ssh
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
            { key: 'target', className: 'rs-flow-row' },
            h(
              'select',
              { className: 'rs-select', value: choiceValue, onChange: (event) => pickChoice(event.target.value) },
              h(
                'option',
                { value: '' },
                targets === null ? '加载中…' : candidates.length === 0 ? emptyLabel : '选择目标…',
              ),
              candidates.map((option) => h('option', { key: option.value, value: option.value }, option.label)),
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
          { key: 'path', className: 'rs-flow-row' },
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

    function EditorTab({ tab, index, hidden }) {
      const dirty = tab.text !== tab.saved
      const onChange = (event) => updateTab(index, { text: event.target.value })
      return h(
        'div',
        { className: 'rs-editor', style: hidden ? { display: 'none' } : null },
        h(
          'div',
          { className: 'rs-editor-bar' },
          h('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }, title: tab.path }, tab.path),
          dirty ? h('span', { className: 'rs-dim' }, '未保存') : null,
          h('button', { className: 'rs-btn', onClick: () => saveTab(index), disabled: !dirty }, '保存'),
        ),
        h('textarea', {
          value: tab.text,
          spellCheck: false,
          onChange,
          onKeyDown: (event) => {
            if ((event.ctrlKey || event.metaKey) && event.key === 's') {
              event.preventDefault()
              if (dirty) saveTab(index)
            }
          },
        }),
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
        // empty target would only produce an error frame. Wait for one.
        if (store.target === null) return undefined
        let alive = true
        loadTerminalAssets()
          .then(() => {
            if (alive) connect(store.target, store.root)
          })
          .catch((error) => {
            if (alive) {
              setFallback(error.message || String(error))
              setStatus('error')
            }
          })
        return () => {
          alive = false
          disconnect()
        }
        // Mount + first target only: reconnecting is an explicit action, so a
        // target switch never yanks a running shell out from under the user.
      }, [store.target === null])

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
                className: 'rs-x',
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
          '终端',
        ),
      )

      const bodies = tabs.map((tab, index) =>
        tab.kind === 'web'
          ? h(WebTab, { tab, key: tab.key, hidden: active !== index })
          : h(EditorTab, { tab, index, key: tab.key, hidden: active !== index }),
      )
      bodies.push(h(TerminalTab, { key: 'terminal', hidden: active !== termIndex }))

      return h('div', { className: 'rs-main' }, h('div', { className: 'rs-tabs' }, tabBar), h('div', { className: 'rs-body' }, bodies))
    }

    // The rail icon opens this one view: targets + tree on the left, editor and
    // console on the right.
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
    // Seats
    // ---------------------------------------------------------------------

    function Icon() {
      const props = {
        title: '远程',
        style: {
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '24px',
          height: '24px',
          fontSize: '13px',
          fontWeight: 600,
          borderRadius: '6px',
          border: '1px solid rgba(127,127,127,0.45)',
        },
      }
      return h('span', props, 'R')
    }

    var inject = ['slots', 'workspaces']

    // The host renders its own add-workspace dialog through these two slots.
    // Registering at a low priority takes the flow over, exactly the way the
    // remote-ssh plugin did, so the official "＋ 添加工作区" opens our tabs.
    var FLOW_SLOTS = ['conversation.hero.workspace.directoryFlow', 'sidebar.workspaces.directoryFlow']

    function apply(ctx) {
      if (ctx.slots === undefined || ctx.slots === null) {
        console.error('dsh-remote-suite: this DSH has no slots service; the add-workspace flow stays native')
        return
      }
      ensureStyle()
      workspaceServices.workspaces = typeof ctx.get === 'function' ? ctx.get('workspaces') : null
      workspaceServices.uiWorkspace = typeof ctx.get === 'function' ? ctx.get('uiWorkspace') || null : null
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
      return () => {
        for (const stop of stops) {
          if (typeof stop === 'function') stop()
        }
      }
    }

    return { apply, inject }
  },
})
