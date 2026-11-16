# `dsh-better-sidebar` — File Interface Specification

Reverse-engineered from the installed package:

```
C:\Users\Administrator\.dsh\profiles\desktop\node_modules\dsh-better-sidebar
  package.json      name "dsh-better-sidebar", version 0.32.1, "type": "module"
  lib/index.js      host bundle (425 KB)
  lib/client.js     client bundle
  src/*.ts          host TypeScript sources (252 files)
  src/client/**     browser TypeScript sources
```

Everything below is derived from `src/**` (host half) and `src/client/**` (browser half).
Line numbers are 1-based and refer to those files. Code blocks marked **verbatim** are copied
from the source; blocks marked *equivalent logic* reconstruct a handler from its source lines
and must not be quoted as literal code.

This document covers the **file interface only**. Git, sidechat, workflow/team and session
routes are mentioned only where they share a route with the file interface
(`/sidebar/api` multiplexer, `/sidebar/ws/agent-opens`).

---

## 0. Conventions

### 0.1 Transport

* Plain HTTP/1.1 on the DSH host web server, registered through
  `ctx.webServer.register({ kind, path, handler })` for HTTP and
  `ctx.webServer.registerUpgrade({ path, handler })` for WebSockets
  (`src/index.ts:1630`, `:1714`, `:1752`, `:1805`, `:1830`, `:1921`, `:1980`, `:2001`, `:2023`).
* `kind: 'exact'` = exact path match; `kind: 'prefix'` = match on the path **and every path under it**
  (so `/sidebar/file/anything` reaches the `/sidebar/file` handler).
* Every route except the WebSocket upgrades is fenced first (see 0.3).
* No CORS headers are emitted; the browser client is served from the same origin and builds URLs
  relative to the host base (`src/client/host-route-url.ts`).

### 0.2 Response envelope (JSON routes)

**verbatim** — `src/wire.ts:55-60`

```ts
export interface SidebarOk<T> { ok: true; value: T }

export interface SidebarErr { ok: false; error: { code: SidebarErrorCode; message: string } }
```

`writeOk` = `200` + `{ ok: true, value }`; `writeError` maps a thrown value to a status and an
envelope, and destroys the response if headers were already sent (`src/wire.ts:150-176`).

**verbatim** — `src/wire.ts:14-37` (the complete `code` vocabulary)

```ts
export type SidebarErrorCode =
```

…with the members (one per line in the source):

```
'bad-request' | 'not-found' | 'forbidden' | 'method-error' | 'too-large' | 'unavailable'
| 'fs-error' | 'fs-directory' | 'fs-conflict' | 'git-error' | 'graph-stale' | 'graph-limit'
| 'git-suggest-empty' | 'git-suggest-error' | 'job-error' | 'team-error' | 'team-conflict'
| 'sidechat-error' | 'subagents-unavailable' | 'settings-rejected' | 'settings-conflict'
| 'internal'
```

**verbatim** — `src/wire.ts:38-49`

```ts
/** One API failure with its wire code and HTTP status. */
export class SidebarError extends Error {
  constructor(
    readonly code: SidebarErrorCode,
    message: string,
    readonly status = 400,
    /** Optional structured context carried alongside the code. */
    readonly meta?: Record<string, string>,
  ) {
    super(message)
  }
}
```

`writeError` rule set (`src/wire.ts:155-176`):

| thrown value | status | `error.code` |
|---|---|---|
| `SidebarError` | `error.status` (default **400**) | `error.code` |
| `GitCommandError` with `code === 'not-repo'` | **409** | `not-repo` |
| any other `GitCommandError` | **400** | `git-error` |
| anything else | **500** | `internal` |

The message is `error.message` (for non-`Error` values, `String(error)`).

### 0.3 The browser-trust fence

**verbatim** — `src/index.ts:1442`

```ts
const fence = (req: SidebarHttpRequest): boolean => ctx.connection.requestRejection(req) === undefined
```

`fence(req) === false` means the host connection service refuses the request (host policy /
browser-trust check). Consequences:

| route | refusal answer |
|---|---|
| `/sidebar/api`, `/sidebar/upload`, `/sidebar/write`, `/sidebar/archive` | `403` + JSON `{"ok":false,"error":{"code":"forbidden","message":"forbidden"}}` |
| `/sidebar/file`, `/sidebar/html`, `/sidebar/bundle` | `403` + plain-text body `forbidden` |
| `/sidebar/ws/*` | raw socket `destroy()` before the WebSocket handshake |

There is **no token, cookie, or session authentication** beyond this fence: any request the host
connection layer accepts is served. `sessionId` selects *which* session's cwd is used — it is a
routing key, not an authorization check.

### 0.4 Body limits

**verbatim** — `src/wire.ts:52`

```ts
const MAX_BODY_BYTES = 1 << 20
```

* JSON RPC bodies: `readJsonBody(req)` default limit `1048576`; only `sidechat.prompt` raises it
  (`sidechatPromptBodyLimit(ctx)`) — `src/index.ts:1660`.
* `/sidebar/write` raw text body: `WRITE_BODY_GUARD_BYTES` = `8 * 1024 * 1024` (`src/editor-limits.ts:50`).
* `/sidebar/upload` request body: **unbounded** (the stream is piped straight to disk).

---

## 1. Route table

All routes are under `/sidebar`. Registered from `src/index.ts` unless stated.

| # | kind | method | path | registered at | file-related |
|---|---|---|---|---|---|
| 1 | `prefix` | `POST` | `/sidebar/api` | `src/index.ts:1630-1632` (handler `1633-1687`) | ✔ (JSON RPC: `fs.*`, `session.cwd`, `archive.*`, `open.external`) |
| 2 | `exact` | `GET` | `/sidebar/sidechat-image` | `src/index.ts:1689-1691` | ✘ (sidechat) |
| 3 | `exact` | `POST` | `/sidebar/upload` | `src/index.ts:1714-1716` | ✔ |
| 4 | `exact` | `POST` | `/sidebar/write` | `src/index.ts:1752-1754` | ✔ |
| 5 | `prefix` | `GET`/`HEAD` | `/sidebar/bundle` | `src/bundle-route.ts:139-144`, called at `src/index.ts:1795` | ✔ (static chunk scripts) |
| 6 | `exact` | `GET` | `/sidebar/archive` | `src/index.ts:1805-1807` | ✔ (zip/tar download) |
| 7 | `prefix` | `GET` | `/sidebar/file` | `src/index.ts:1830-1832` (handler `1833-1908`) | ✔ (byte stream + Range) |
| 8 | `prefix` | `GET` | `/sidebar/html` | `src/index.ts:1921-1923` (handler `1924-1971`) | ✔ (HTML preview) |
| 9 | upgrade | `GET` (Upgrade) | `/sidebar/ws/agent-opens` | `src/index.ts:1980-1981` | ✘ (agent file-open push) |
| 10 | upgrade | `GET` (Upgrade) | `/sidebar/ws/fs-watch` | `src/index.ts:2001-2002` | ✔ |
| 11 | upgrade | `GET` (Upgrade) | `/sidebar/ws/sidechat` | `src/index.ts:2023-2024` | ✘ (sidechat) |

**Totals:** 11 registered routes = 8 HTTP routes + 3 WebSocket upgrades.
Of these, **8 serve the file interface** — #1 `api`, #3 `upload`, #4 `write`, #5 `bundle` (static
chunk scripts, not user files), #6 `archive`, #7 `file`, #8 `html`, #10 `fs-watch` — and #2, #9, #11
belong to sidechat/agent-opens. `#1` is a single route that carries 9 `fs.*` methods plus
`session.cwd`, `archive.build`, `archive.status` and `open.external`.

The `/sidebar/api` multiplexer additionally carries 44 fixed methods
(`src/index.ts:790-1287`) plus a dynamic `sidechat.*` surface. Full method list, in registration
order:

```
session.phase, session.cwd,
fs.tree, fs.trees, fs.search, fs.read, fs.readPage, fs.rename, fs.mkdir, fs.createFile, fs.remove,
git.worktrees, git.status, git.diff, git.diff-head, git.stage, git.unstage, git.commit, git.push,
git.pull, git.branch, git.checkout, git.graph, git.history, git.log, git.commit-diff,
git.discard, git.revert, git.cherry-pick, git.show, git.blame, git.suggest-message,
git.commit-model, git.models,
changes.ops, subagents.live, workflows.list, teams.taskCreate, teams.taskUpdate,
settings.get, settings.update, open.external, archive.build, archive.status,
...buildSidechatApi(...)   // sidechat.*
```

`fs.write` does **not** exist as an RPC; saving goes through the raw `/sidebar/write` route so the
document body is not JSON-escaped (`src/client/api.ts:464-472`).

### 1.1 `/sidebar/api` dispatch

*equivalent logic* — `src/index.ts:1633-1687`

```ts
if (!fence(req)) return writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
if (req.method !== 'POST') throw new SidebarError('method-error', 'method not allowed', 405)
const method = methodOf(url.pathname)            // pathname.slice('/sidebar/api/'.length)
if (method === undefined || method.includes('/'))
  throw new SidebarError('not-found', 'unknown sidebar API method', 404)
if (!Object.hasOwn(api, method) || typeof api[method] !== 'function')
  throw new SidebarError('not-found', `unknown sidebar API method "${method}"`, 404)
const payload = await readJsonBody(req, method === 'sidechat.prompt' ? sidechatPromptBodyLimit(ctx) : undefined)
const controller = method === 'changes.ops' ? new AbortController() : undefined   // aborted on res 'close'
return writeOk(res, await api[method](payload, controller?.signal))
```

`/sidebar/api` with **no** suffix (`/sidebar/api`, no trailing slash) → `method === undefined` →
`404 not-found "unknown sidebar API method"`. Any method containing `/` (e.g.
`/sidebar/api/fs/tree`) → same 404. GET/PUT → `405 method-error "method not allowed"`.

---

## 2. Request schemas

### 2.1 Workspace-root resolution (applies to every file route and RPC)

Every file operation needs a **cwd** (workspace root). `/sidebar/file` and `/sidebar/html` are the
only ones that ever see a client-supplied cwd; the RPCs and the mutation routes all build it the
same way:

*equivalent logic* — `src/index.ts:742-759` (`cwdOf`)

```ts
const sessionId = requireString(payload, 'sessionId')          // '' or non-string -> bad-request
const clientCwd = typeof payload.cwd === 'string' && payload.cwd !== '' ? payload.cwd : undefined
// deduped by `${sessionId}\0${clientCwd ?? ''}` while a lookup is in flight
return await activeWorktreeRootOf(ctx, sessionId, await sessionCwdOf(ctx, sessionId, clientCwd))
```

`sessionCwdOf` — `src/index.ts:244-273` — resolves in this exact precedence:

1. live session working directory: `ctx.get('workingDirectory')?.get(session)` then
   `session.header.cwd`;
2. the persisted session header (`storedHeaderCwdOf(ctx, sessionId)`), required to be absolute —
   failure → `SidebarError('bad-request', 'invalid working directory "<stored>"')`;
3. `ctx.get('workingDirectory')?.defaultDirectory`;
4. the client hint `?cwd=` / `"cwd"` (must be absolute, else `bad-request`);
5. `process.cwd()`.

`activeWorktreeRootOf` — `src/active-worktree.ts:504` — then maps that base to the session's
*active git worktree root*:

* env override `ACTIVE_ROOT_OVERRIDE_ENV` (must be absolute) wins outright;
* a detached / not-yet-live session returns the base unchanged;
* otherwise the active worktree root of the base, cached per sessionId (key includes base +
  `directoryEpoch` + TTL), in-flight deduped by `` `${sessionId}\0${base}\0${directoryEpoch}` ``,
  re-validated for existence (`directoryPresence`) before serving;
* it is never the repository top level when a worktree is checked out.

`/sidebar/file` and `/sidebar/html` also accept a `cwd` hint but pass it into the same chain:
`src/index.ts:1841` / `:1936` (`/sidebar/html` does **not** accept a cwd hint at all).

`session.cwd` exposes the result so the client can render the tree root:

**verbatim** — `src/index.ts:802-805`

```ts
'session.cwd': async (payload) => {
  const { sessionId, cwd } = await cwdOf(payload)
  return { sessionId, cwd, root: rootLabel(cwd), parent: parentOf(cwd) ?? null }
},
```

`rootLabel`/`parentOf` live at `src/fs-tree.ts:387` / `:393`.

### 2.2 Path resolution (`fs.*`, `/sidebar/file`, `/sidebar/html`, `/sidebar/upload`, `/sidebar/write`)

**verbatim** — `src/path-security.ts:60-77` (doc comments elided, marked `…`)

```ts
export function resolveTarget(cwd: string, target: string): string {
  …
  const homeExpanded = target === '~' || target.startsWith('~/') || target.startsWith('~\\')
    ? join(homedir(), target.slice(1))
    : target
  …
  const joined = isAbsolute(homeExpanded) ? homeExpanded : join(cwd, homeExpanded)
  return requireAbsolute(resolveSessionPath(cwd, joined))
}
```

The doc block above it states the contract precisely:

> The single resolution primitive: session-relative targets resolve under the session cwd,
> absolute targets stay absolute, and the result is `resolve()`d (lexical `..` collapse).
> Throws fs-error for a non-absolute result.

**verbatim** — `src/path-security.ts:38-47` and `:56-63` (both are now thin aliases)

```ts
export async function ensureWorkspacePath(cwd: string, target: string, _fence?: boolean): Promise<string> {
  return resolveTarget(cwd, target)
}
export async function ensureWorkspaceWritePath(cwd: string, target: string, _fence?: boolean): Promise<string> {
  return resolveTarget(cwd, target)
}
```

Module header, **verbatim** (`src/path-security.ts:1-20`, abridged to the load-bearing sentence):

> ⚠️ This module no longer enforces workspace containment … the sidebar fs routes now reach any
> path the HOST USER can reach, bounded only by OS permissions (and by the browser-trust fence on
> the routes themselves).

So the model is:

* `~`, `~/x`, `~\x` expand against the **host's** `os.homedir()`;
* a relative target is joined onto the resolved cwd; an absolute target is used as-is;
* the result must be absolute (`requireAbsolute`, `src/fs-tree.ts:405-409`:
  `SidebarError('fs-error', '"<path>" is not an absolute path')`);
* `resolveSessionPath(cwd, joined)` (`src/session-path.ts:101`) rewrites POSIX-looking paths when
  the cwd is a WSL share (`\\wsl.localhost\<distro>\…`, regex `src/session-path.ts:5`) or a remote
  mirror (`.dsh\remote-workspaces\<x>\<y>\…`, regex `:12`) — mapping `/a/b` onto
  `\\wsl.localhost\<distro>\a\b` or onto the mirror root when `.dsh-remote-meta.json`
  (`:15`) records a `remotePath` that is a POSIX prefix of the target;
* **no containment check, no symlink rejection, no `..` rejection** on the read side. A path that
  escapes the workspace is served if the host user can read it.

`fs.trees` is the one place a relative path is joined *without* calling `ensureWorkspacePath`
(`src/index.ts:846-851`), so its per-level `path` echoes what the client asked for.

### 2.3 `fs.tree`

Request — `src/index.ts:806-819`

| field | type | req | default | notes |
|---|---|---|---|---|
| `sessionId` | `string` | ✔ | — | `requireString` → `bad-request 'missing or invalid "sessionId"'` |
| `cwd` | `string` | ✘ | — | client hint, empty string ignored |
| `path` | `string` | ✘ | *cwd* | absolute, `~`-relative, or cwd-relative; resolved via `ensureWorkspacePath` |
| `exclude` | `string[]` | ✘ | — | exclude patterns, see 4.6 |

**verbatim** — `src/index.ts:806-819` (comments elided, marked `…`)

```ts
'fs.tree': async (payload) => {
  const { cwd } = await cwdOf(payload)
  const record = payload as { path?: unknown; exclude?: unknown }
  const target = record.path === undefined ? cwd : await ensureWorkspacePath(cwd, requireString(payload, 'path'))
  …
  const exclude = compileExcludePatterns(record.exclude, cwd)
  …
  return listDirectory(target, resolved.listLimit, exclude, createProbeGate())
},
```

`resolved.listLimit` default **1000**, configurable `1..∞` step 1 (`src/config.ts:59`, `:79-84`).

Response `value` = `SidebarFsListing` (`src/fs-tree.ts:46-49`), **verbatim**:

```ts
export interface SidebarFsListing {
  path: string
  entries: SidebarFsEntry[]
  truncated: boolean
}
```

`path` is the **resolved absolute** directory. `entries` is sorted (4.2) and capped at `listLimit`.
`fs.tree` never returns `error`; failures throw (see 3.4).

### 2.4 `fs.trees` (batched levels)

Request — `src/index.ts:825-861`

| field | type | req | default | limits |
|---|---|---|---|---|
| `sessionId` | `string` | ✔ | — | |
| `cwd` | `string` | ✘ | — | |
| `paths` | `string[]` | ✔ | — | non-empty; **≤ 64** (`FS_TREES_MAX_PATHS`, `src/fs-batch.ts:10`); non-string / `''` items are silently dropped |
| `exclude` | `string[]` | ✘ | — | |

Errors: empty (after filtering) → `bad-request 'paths must be a non-empty array'`;
`paths.length > FS_TREES_MAX_PATHS` → `bad-request 'too many paths (max 64)'`
(`src/index.ts:834-838`).

Per-level path normalisation (`src/index.ts:846-851`):

```ts
const homeRelative = raw === '~' || raw.startsWith('~/') || raw.startsWith('~\\')
const requested = isAbsolute(raw) || homeRelative ? raw : `${cwd}${sep}${raw}`
```

Response `value`:

**verbatim** — `src/index.ts:107-112`

```ts
export interface SidebarFsLevel {
  path: string
  entries: SidebarFsEntry[]
  truncated: boolean
  error?: string
}
```

`value` is `{ levels: SidebarFsLevel[] }` — one level **per requested path, in request order**.
A level that fails does **not** fail the batch: it comes back as
`{ path: requested, entries: [], truncated: false, error: <message> }` (`src/index.ts:855-860`).
A shared `ProbeGate` (`createProbeGate()`, budget `PROBE_BUDGET = 32`, `src/fs-tree.ts:223-245`)
bounds symlink/compact probes **across the whole batch**.

### 2.5 `fs.search`

Request — `src/index.ts:862-874`

| field | type | req | default | notes |
|---|---|---|---|---|
| `sessionId` | `string` | ✔ | — | |
| `cwd` | `string` | ✘ | — | search root = resolved cwd (never `repoRoot`) |
| `query` | `string` | ✔ | — | `requireString`; blank/whitespace → empty result (not an error) |
| `exclude` | `string[]` | ✘ | — | |

Response `value` — **verbatim** `src/fs-search.ts:59-68`:

```ts
export interface FsSearchResult {
  matches: string[]
  dirs: string[]
  truncated: boolean
}
```

* `matches` — for a tree search: paths **relative to the root**, `/`-separated, sorted,
  capped at `DEFAULT_MAX_MATCHES = 200` (`src/fs-search.ts:70-78`; RPC passes no override).
* for a **direct-path query** (absolute, `~`, `~/…`, `~\…`, or dot-anchored like `./x`) the single
  result is the **resolved absolute** target (`src/fs-search.ts:286-320`); `dirs` additionally
  contains it when it is a directory.
* `dirs` — matched directories, same path convention.
* `truncated` — the 200-match cap or the `DEFAULT_MAX_VISITED = 100_000` visited-entry cap tripped.

There is **no cursor** for `fs.search`: it is a single bounded snapshot. Refining means re-querying
with a longer needle.

### 2.6 `fs.read`

Request — `src/index.ts:875-883`

| field | type | req | default | notes |
|---|---|---|---|---|
| `sessionId` | `string` | ✔ | — | |
| `cwd` | `string` | ✘ | — | |
| `repoRoot` | `string` | ✘ | — | when present, the read base becomes `await git.repoRoot(cwd, repoRoot)` instead of cwd (`selectedRepoOf`, `src/index.ts:276-280`) |
| `path` | `string` | ✔ | — | absolute / `~` / relative to the base |

Response `value` — **verbatim** `src/index.ts:505-513`:

```ts
export type SidebarReadResult =
  | { kind: 'text'; content: string; size: number; mtimeMs: number }
  | { kind: 'binary'; size: number; mtimeMs: number; head: string }
  | { kind: 'too-large'; size: number; mtimeMs: number; head: string }
```

`head` is **base64** of at most `READ_HEAD_LIMIT = 4096` bytes (`src/index.ts:486`) — the sniff
window, so a media/binary preview can be drawn without a second request.
`content` is the decoded whole document, newline style preserved as on disk.

### 2.7 `fs.readPage`

Request — `src/index.ts:888-898` → `readPage(path, offset)` (`src/index.ts:619`)

| field | type | req | default | notes |
|---|---|---|---|---|
| `sessionId` | `string` | ✔ | — | |
| `cwd` | `string` | ✘ | — | |
| `repoRoot` | `string` | ✘ | — | same base override as `fs.read` |
| `path` | `string` | ✔ | — | |
| `offset` | `number` | ✘ | `0` | floored; non-finite or `< 0` → `0`; **byte offset**, not line |

Response `value` — **verbatim** `src/index.ts:594-604`:

```ts
/** One page of a large text file: whole lines, plus where to continue. */
interface ReadPageResult {
  kind: 'text'
  text: string
  offset: number
  nextOffset: number
  eof: boolean
  size: number
  mtimeMs: number
  encoding: TextEncoding
}
```

Pagination model (4.4): the client's cursor **is** `nextOffset`; there is no opaque token and no
page cache — a page is a pure function of `(path bytes, offset)`, so a changed file naturally
re-decodes.

### 2.8 Mutations: `fs.rename`, `fs.mkdir`, `fs.createFile`, `fs.remove`

All four share `{ sessionId, cwd?, path }` plus `name` for the first three; all return
`{ path: string }` (`value.path` is the resolved absolute path of the affected entry).

| method | registered | extra fields | result |
|---|---|---|---|
| `fs.rename` | `src/index.ts:902-909` | `path`, `name` | `{ path }` |
| `fs.mkdir` | `src/index.ts:912-919` | `path` (parent), `name` | `{ path }` |
| `fs.createFile` | `src/index.ts:924-931` | `path` (parent), `name` | `{ path }` |
| `fs.remove` | `src/index.ts:934-940` | `path` | `{ path }` |

Input shapes (field lists; the source declares these as `export interface … { … }` with doc
comments at `src/fs-operations.ts:265`, `:385`, `:477`, `:523`):

```ts
// src/fs-operations.ts:265  WorkspaceRenameInput
{ cwd: string; path: string; name: string; fence?: boolean }
// src/fs-operations.ts:385  WorkspaceMkdirInput
{ cwd: string; path: string; name: string; fence?: boolean }
// src/fs-operations.ts:477  WorkspaceCreateFileInput
{ cwd: string; path: string; name: string; fence?: boolean }
// src/fs-operations.ts:523  WorkspaceRemoveInput
{ cwd: string; path: string; fence?: boolean }
```

`fence?: boolean` is **deprecated and ignored** in all four (`@deprecated IGNORED — containment was
removed. Do not pass it.`, `src/fs-operations.ts:272-273`); the routes never pass it.

`name` is the new base name only — a rename never moves an entry between directories
(`src/fs-operations.ts:270-271`).

Name rules (4.7): single segment only, plus Windows illegal characters / reserved device names.

### 2.9 `/sidebar/write`

*Multiplexed; raw body.*

Query — `src/index.ts:1752-1789`

| param | type | req | notes |
|---|---|---|---|
| `sessionId` | `string` | ✔ | |
| `path` | `string` | ✔ | non-empty |
| `cwd` | `string` | ✘ | client hint |
| `expectedMtimeMs` | `string` (numeric) | ✘ | parsed with `Number(...)`; non-finite → treated as absent (no CAS gate) |

Body: **raw UTF-8 text**, `content-type` ignored, decoded with a fatal `TextDecoder`
(`readTextBody`, `src/wire.ts:114-140`). Missing `sessionId`/`path` →
`bad-request 'sessionId and path are required'`. Non-POST → `405 method-error 'method not allowed'`.
Body over `WRITE_BODY_GUARD_BYTES` (8 MiB) → `too-large` 413 with message
`request body exceeds the 8388608 byte limit` (`src/wire.ts:114-140`). Invalid UTF-8 →
`bad-request 'request body is not valid UTF-8'`.

Semantics (4.5): the bytes are re-encoded into the file's **existing** encoding and the file's
existing EOL style is restored before writing; the write is atomic (temp file + rename) and
optionally guarded by an mtime compare-and-swap.

### 2.10 `/sidebar/upload`

Query — `src/index.ts:1714-1746`

| param | type | req | notes |
|---|---|---|---|
| `sessionId` | `string` | ✔ | |
| `dir` | `string` | ✔ | destination directory; resolved by `resolveTarget(cwd, dir)` |
| `relativePath` | `string` | ✔ | must be non-empty after `trim()`; must stay below `dir` |
| `cwd` | `string` | ✘ | |

Body: the file bytes (any content type). Missing any of the three params →
`bad-request 'sessionId, dir, and relativePath are required'`.

`relativePath` validation (`src/fs-operations.ts:134-183`): split on `/[\\/]/`, reject if the value
is empty, starts with `/` or `\`, or any segment is `''`, `'.'`, or `'..'` →
`bad-request 'relativePath must stay below the upload directory'`.

### 2.11 `/sidebar/archive` (download)

Query — `src/archive-route.ts:143-176`

| param | type | req |
|---|---|---|
| `sessionId` | `string` | ✔ |
| `id` | `string` | ✔ (non-empty) |

Missing → `bad-request 'sessionId and id are required'` (400).

### 2.12 `/sidebar/bundle`

Path shape — `src/bundle-route.ts:88-95`

```
GET|HEAD /sidebar/bundle/<name>.js      name ∈ { editor, mermaid, locale, terminal }
```

`CHUNK_NAMES` — **verbatim** `src/bundle-route.ts:25`:

```ts
export const CHUNK_NAMES = ['editor', 'mermaid', 'locale', 'terminal'] as const
```

Anything else (including traversal attempts — the regex is
`/^\/sidebar\/bundle\/([a-z0-9-]+)\.js$/`) → `404` plain `not found`. Other methods → `405` empty.

---

## 3. Response schemas

### 3.1 `fs.tree` / `fs.trees` entry objects

**verbatim** — `src/fs-tree.ts:25-43`

```ts
/** One explorer row. */
export interface SidebarFsEntry {
  name: string
  path: string
  isDir: boolean
  hidden: boolean
  /** Whether the row is a symlink; `isDir` then describes the link's target. */
  isSymlink: boolean
  /** For symlinks: the target is missing or unreadable (stat failed). */
  broken: boolean
  /**
   * Directory rows only: the contents are EXACTLY one child — the explorer
   * folds such singleton chains into one breadcrumb row (VSCode's "compact
   * folders"). The terminal link (sole child is a FILE) is marked too, so
   * the row label never shifts when the chain expands. Symlink children
   * never qualify: a self-referential link would otherwise fold forever.
   */
  compact?: boolean
}
```

Field meanings:

| field | meaning |
|---|---|
| `name` | base name, exact bytes from `readdir` |
| `path` | **absolute**; `` `${dir}${sep}${name}` ``, with `dir` from the request (no trailing-sep doubling) |
| `isDir` | `dirent.isDirectory()` — **a symlink to a directory is `isDir: false`**; the tree keeps it as a file row |
| `hidden` | `name.startsWith('.')` |
| `isSymlink` | `dirent.isSymbolicLink()`; probing is capped by the probe gate + `SYMLINK_PROBE_CONCURRENCY = 32` (`src/fs-tree.ts:70`) |
| `broken` | symlink whose follow-`stat` threw |
| `compact` | only set for directories, only when the level is **not truncated**, only for the first `COMPACT_PROBE_MAX = 32` candidates, concurrency 32 (`src/fs-tree.ts:315`, `:326`); `true` ⇒ the dir holds exactly one non-dot, non-excluded, non-symlink child |

### 3.2 Status codes per route

| route | success | failures |
|---|---|---|
| `/sidebar/api` | `200` `{ok:true,value}` | `403 forbidden`, `404 not-found`, `405 method-error`, `413 too-large`, `400/409/410/500` from the method |
| `/sidebar/file` | `200` (full), `206` (partial) | `403` `forbidden` (text), `405` empty, `400 fs-error`, `416` unsatisfiable range |
| `/sidebar/html` | `200` stream | `403` `forbidden` (text), `405` empty, `400`/`404` decode (`bad-request` envelope), `400 fs-error` |
| `/sidebar/upload` | `200` `{ok:true,value:{path,size}}` | `403`, `405`, `400 bad-request` |
| `/sidebar/write` | `200` `{ok:true,value:{ok:true,mtimeMs?}}` | `403`, `405`, `413 too-large`, `409 fs-conflict`, `400 fs-error` |
| `/sidebar/archive` | `200` stream | `400`, `403 forbidden`, `404 not-found`, `409 bad-request 'archive is still being built'`, `410 fs-error` |
| `/sidebar/bundle` | `200` / `304`, `HEAD` → headers only | `403` text, `404` text, `405` empty |

### 3.3 Headers on file-ish routes

`/sidebar/file` (`src/index.ts:1864-1908`):

```
content-type: <mediaTypeForPath(path)>
cache-control: no-cache
accept-ranges: bytes
x-content-type-options: nosniff
referrer-policy: no-referrer
content-length: <size | range length>
content-range: bytes <start>-<end>/<size>        (206 only)
content-disposition: attachment; filename*=UTF-8''<encodeURIComponent(basename)>   (?download=1)
content-security-policy: sandbox allow-scripts allow-popups allow-downloads allow-modals; object-src 'none'
content-security-policy: sandbox; object-src 'none'                               (image/svg+xml)
```

The HTML types that get the CSP sandbox are `text/html`, `application/xhtml+xml`, `image/svg+xml`
(`src/index.ts:1878-1890`).

`mediaTypeForPath` — `src/index.ts:161-172` — is a **plain extension table**, not a sniffer:

```
.png image/png            .jpg/.jpeg image/jpeg     .gif image/gif          .webp image/webp
.svg image/svg+xml        .bmp image/bmp            .ico image/x-icon       .avif image/avif
.pdf application/pdf      .html/.htm text/html      .css text/css           .js/.mjs text/javascript
.json application/json    .woff font/woff           .woff2 font/woff2       .ttf font/ttf
.otf font/otf             .wasm application/wasm    .mp4/.m4v video/mp4     .webm video/webm
.ogv video/ogg            .mov video/quicktime      .mp3 audio/mpeg         .m4a audio/mp4
.aac audio/aac            .wav audio/wav            .flac audio/flac        .ogg/.oga/.opus audio/ogg
(default) application/octet-stream
```

`/sidebar/html` (`src/index.ts:1938-1962`):

```
content-type: text/html; charset=utf-8     (for .html/.htm; else mediaTypeForPath)
cache-control: no-cache
x-content-type-options: nosniff
referrer-policy: no-referrer
content-security-policy: sandbox allow-scripts allow-popups allow-downloads allow-modals; object-src 'none'
```

`/sidebar/archive` (`src/archive-route.ts:162-170`):

```
content-type: application/gzip   (name ends .tar.gz)  |  application/zip
content-disposition: attachment; filename="<ascii fallback>"; filename*=UTF-8''<percent-encoded>
cache-control: no-cache
content-length: <size>
```

`contentDispositionOf` — **verbatim** `src/archive-route.ts:100-102`:

```ts
export function contentDispositionOf(name: string): string {
  return `attachment; filename="${asciiFallbackOf(name)}"; filename*=UTF-8''${encodeURIComponent(name)}`
}
```

`/sidebar/bundle` (`src/bundle-route.ts:103-134`):

```
200: content-type: text/javascript; charset=utf-8, cache-control: no-cache, etag: "<12 hex>"
304: cache-control: no-cache, etag: "<12 hex>"     (If-None-Match matched)
HEAD 200: same headers + content-length, no body
```

ETag = `"<sha1(body) first 12 hex>"`, memoized per file by `mtimeMs`+`size`
(`src/bundle-route.ts:51-66`).

### 3.4 Error payload catalogue (file interface)

| situation | code | status | message |
|---|---|---|---|
| fence refused (JSON routes) | `forbidden` | 403 | `forbidden` |
| non-POST on `/sidebar/api` | `method-error` | 405 | `method not allowed` |
| unknown RPC method | `not-found` | 404 | `unknown sidebar API method "<m>"` |
| body not JSON | `bad-request` | 400 | `request body is not valid JSON` |
| JSON body > 1 MiB | `too-large` | 413 | `request body too large` |
| text body > limit | `too-large` | 413 | `request body exceeds the <n> byte limit` |
| text body not UTF-8 | `bad-request` | 400 | `request body is not valid UTF-8` |
| missing/blank string field | `bad-request` | 400 | `missing or invalid "<key>"` |
| `fs.tree` readdir failure | `fs-error` | 400 | `cannot list "<abs>": <errno message>` |
| path not absolute | `fs-error` | 400 | `"<path>" is not an absolute path` |
| file missing (read/stat) | `fs-error` | 400 | `File not found: "<abs>"` |
| other stat/read failure | `fs-error` | 400 | `cannot read "<abs>": <message>` |
| read a directory | `fs-directory` | 400 | `"<abs>" is a directory` |
| `/sidebar/file` target not a regular file | `fs-error` | 400 | `not a file` |
| `/sidebar/html` target not a regular file | `fs-error` | 400 | `not a file` |
| write with stale `expectedMtimeMs` | `fs-conflict` | 409 | `"<abs>" changed on disk since it was loaded (expected mtime X, found Y)` |
| write with `expectedMtimeMs` but file gone | `fs-conflict` | 409 | `"<abs>" no longer exists on disk (expected mtime X)` |
| write failure | `fs-error` | 400 | `cannot write "<abs>": <message>` |
| rename to existing name | `fs-error` | 409 | `"<name>" already exists` |
| rename failure | `fs-error` | 400 | `cannot rename "<path>" to "<name>": <message>` |
| rename the root | `fs-error` | 400 | `cannot rename the workspace root` |
| mkdir existing | `fs-error` | 409 | `"<name>" already exists` |
| mkdir failure | `fs-error` | 400 | `cannot create "<name>": <message>` |
| create existing | `fs-error` | 409 | `"<name>" already exists` |
| remove the root | `fs-error` | 400 | `cannot remove the workspace root` |
| remove failure | `fs-error` | 400 | `cannot remove "<path>": <message>` |
| bad segment name | `bad-request` | 400 | `name must be a single path segment` |
| illegal filename char | `bad-request` | 400 | `name contains a character that is not allowed in a file name: "<char>"` |
| reserved Windows name | `bad-request` | 400 | `"<name>" is a reserved device name on Windows` |
| upload path escape | `bad-request` | 400 | `relativePath must stay below the upload directory` |
| archive building | `bad-request` | 409 | `archive is still being built` |
| archive failed | `fs-error` | 410 | `<task error>` |
| archive unknown/expired/consumed | `not-found` | 404 | `unknown or expired archive` |
| archive of another session | `forbidden` | 403 | `archive belongs to another session` |
| no zip and no tar | `unavailable` | 501 | `no archive tool is available: neither zip nor tar could be run` |
| too many concurrent archives | `bad-request` | 409 | `too many archives are being built (max 4)` |
| unhandled | `internal` | 500 | `error.message` |

`fileReadError` — **verbatim** `src/fs-read-error.ts:7-13`:

```ts
export function fileReadError(path: string, error: unknown): SidebarError {
  const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined
  const message = code === 'ENOENT'
    ? `File not found: "${path}"`
    : `cannot read "${path}": ${error instanceof Error ? error.message : String(error)}`
  return new SidebarError('fs-error', message, 400)
}
```

---

## 4. Semantics

### 4.1 What is rejected

| input | rejected? | where |
|---|---|---|
| relative path (reads) | no — joined onto cwd | `src/path-security.ts:73` |
| `..` segments (reads) | **no** | `resolveTarget` only calls `path.resolve` |
| absolute path outside the workspace | **no** | module header, `src/path-security.ts:1-20` |
| `~`, `~/x`, `~\x` | no — expands to host home | `src/path-security.ts:67-69` |
| path that is not absolute *after* resolution | yes → `fs-error` | `src/fs-tree.ts:405-409` |
| symlink to outside the workspace (read) | no — followed | `resolve` does not `realpath` |
| symlink (write, existing) | no — writes **through** the link | `ensureWorkspaceWritePath` does not resolve existing links |
| name with `/`, `\`, `''`, `.`, `..` | yes → `bad-request` | `assertSingleSegmentName`, `src/fs-operations.ts` |
| name with `< > : " | ? *` or C0 control | yes → `bad-request` | `ILLEGAL_FILE_NAME_CHARS` |
| Windows device name (`CON`, `PRN`, `AUX`, `NUL`, `COM1-9`, `LPT1-9`, before the first dot) | yes → `bad-request` | `RESERVED_FILE_NAMES` |
| `relativePath` with any empty/`.`/`..` segment or leading slash | yes → `bad-request` | `src/fs-operations.ts:134-160` |
| removing / renaming the workspace root | yes → `fs-error` | `isWorkspaceRoot` (dev+ino compare, `lstat(..., {bigint:true})`) |

### 4.2 Sorting of tree entries

**verbatim** — `src/fs-tree.ts:52-67`

```ts
/**
 * Directory-first, case-insensitive name ordering (VSCode explorer order).
 *
 * `toLowerCase()` + code-point comparison instead of `localeCompare`: measured
 * at ~0.35ms/10k rows against ~14.6ms for the collator, and the tie-break on
 * the ORIGINAL name keeps the order total and deterministic for names that
 * only differ in case (`A` before `a`).
 */
export function compareEntries(a: SidebarFsEntry, b: SidebarFsEntry): number {
  if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
  const la = a.name.toLowerCase()
  const lb = b.name.toLowerCase()
  if (la !== lb) return la < lb ? -1 : 1
  if (a.name === b.name) return 0
  return a.name < b.name ? -1 : 1
}
```

Directories first; then a case-folded **code-point** comparison of the name (deliberately not
`localeCompare`); ties broken by raw code-unit order so `A` precedes `a`.

### 4.3 Caps, truncation and caching

* `listLimit` (default 1000, `src/config.ts:59`) applies **after** exclude filtering:
  `truncated = visible.length > maxEntries`, and only `maxEntries` rows are built/sorted.
* Directory listing cache: `directoryCache` keyed by
  `` `${path}\0${maxEntries}\0${exclude?.key ?? ''}` `` — TTL `DIRECTORY_CACHE_TTL_MS = 1_500`,
  max `DIRECTORY_CACHE_MAX = 512`, cleared wholesale or per-prefix by
  `invalidateDirectoryCache(path?)` (`src/fs-tree.ts:78`, `:95`, `:111`, `:124`).
  Invalidation points: `fs-watch` events (`src/fs-watch.ts`), and after writes/uploads/renames/
  deletes in `fs-operations.ts`.
* Symlink/compact probing: `PROBE_BUDGET = 32` per request (or per `fs.trees` batch), concurrency 32.
* Search: 200 matches, 100 000 visited entries (`src/fs-search.ts:70-78`).
* Read: whole-document text only up to `MAX_EDITABLE_BYTES = 5 * 1024 * 1024`; above that the
  response degrades to `too-large` + 4 KiB head, and the UI pages with `fs.readPage`.
* Page: `PAGE_BYTES = 128 * 1024` bytes per request (`src/editor-limits.ts:39`).
* Upload: **no cap** (streamed). Write body: 8 MiB guard. JSON body: 1 MiB.
* `fs.trees`: 64 paths. Exclude patterns: 64 entries, 256 chars each.
* Archive: 4 concurrent builds, finished task TTL `ARCHIVE_TTL_MS = 5 * 60 * 1000`, and a
  download **consumes** the task (`release(id)` in a `finally`, `src/archive-route.ts:171-175`).
* Watch: 64 directories per socket, 150 ms debounce (`src/fs-watch.ts`).

### 4.4 Text pagination (`fs.readPage`) — exact algorithm

*equivalent logic* — `src/index.ts:619-695`

```
stat(path)                                   -> fileReadError on failure
if (info.isDirectory())                      -> SidebarError('fs-directory', `"${path}" is a directory`, 400)
size = info.size
if (offset >= size)                          -> {kind:'text', text:'', offset, nextOffset:size, eof:true,
                                                 size, mtimeMs, encoding:'utf8'}      // no read at all
length     = min(PAGE_BYTES, size - offset)
slice      = pread(offset, length)            // bytesRead may be < length
nextOffset = offset + bytesRead
cacheKey   = `${path}\u0000${size}\u0000${info.mtimeMs}`
locked     = wideEncodingCache.get(cacheKey)  // only WIDE encodings are ever stored
if (nextOffset < size):
    cut = lastLineBreakEnd(slice, locked ?? 'utf8')   // byte offset just past the last 0x0A, unit-aware
    if (cut >= 0) { slice = slice[0..cut); nextOffset = offset + cut }
decoded = decodeTextBytes(slice, /*truncated*/ true)
if (locked !== undefined):
    encoding = locked
    text     = (offset === 0 && decoded !== null) ? decoded.content : decodeTextAs(slice, locked)
else:
    encoding = decoded?.encoding ?? 'utf8'
    text     = decoded?.content ?? decodeTextAs(slice, 'utf8')     // last-resort lossy UTF-8
    if (decoded !== null && isWideEncoding(decoded.encoding)):
        store(cacheKey -> decoded.encoding)        // LRU-ish: evict first key at PAGE_ENCODING_CACHE_MAX
return {kind:'text', text, offset, nextOffset, eof: nextOffset >= size, size, mtimeMs, encoding}
```

Consequences an implementer must reproduce:

* `offset` is a **byte** offset; the client must not treat it as a line index.
* a page is trimmed back to a newline boundary when more bytes follow, so **no line is ever split
  across pages**; a single line longer than 128 KiB is returned untrimmed and the client stitches
  consecutive pages.
* only **wide** encodings (UTF-16/UTF-32) are locked for a `(path, size, mtime)` triple — a
  byte-oriented encoding is re-sniffed per page by design, because a long ASCII prefix sniffs as
  UTF-8 while a later GBK window sniffs as GBK. This is safe *because* pages are line-aligned:
  `0x0A` can be neither a UTF-8 continuation byte nor a GBK trail byte
  (`src/index.ts:575-592`).
* page 0 may carry a BOM; every later page is decoded **BOM-less** under the locked verdict.
* `eof` is `nextOffset >= size`, so a caller can stop on `eof` alone.
* `text-encoding.ts` decides UTF-32/UTF-16 BOMs, then a BOM-less UTF-16 NUL-lane heuristic
  (≥90 % plausible units), then rejects any buffer containing a NUL byte as binary, then fatal
  UTF-8, then GB18030/GBK (`src/text-encoding.ts:240-292`). `unitWidth` (`:294`) and
  `lastLineBreakEnd` (`:335`) are unit-aware (2/4-byte encodings scan in code-unit steps).

### 4.5 Writes

*equivalent logic* — `src/fs-operations.ts:223-263`

```
absolute = await ensureWorkspaceWritePath(cwd, path)      // compose, no realpath
{encoding, eol} = await fileFormatOf(absolute)            // ENOENT -> {utf8, lf}; sniffs 64 KiB
if (expectedMtimeMs !== undefined):
    current = stat(absolute).mtimeMs                      // missing -> fs-conflict 409
    if (current !== expectedMtimeMs) -> fs-conflict 409 with "changed on disk ... (expected X, found Y)"
tmp = join(dirname(absolute), `.${basename}.dsh-sidebar-tmp-${randomUUID()}.tmp`)
writeFile(tmp, encodeText(restoreEol(content, eol), encoding), { flag: 'wx' })
rename(tmp, absolute)                                     // atomic replace
return { mtimeMs: (await stat(absolute)).mtimeMs }
```

Notes: the body arrives as LF-normalised text from the browser; `restoreEol` puts the document's
original CRLF back (`detectEol` = majority vote over the first 4096 chars,
`src/text-encoding.ts:513-537`). `fileFormatOf` returns `{encoding:'utf8', eol:'lf'}` for a new
file. Failure of the temp write or the rename → `fs-error 'cannot write "<abs>": <msg>'`.

The mtime is an **explicit optimistic-concurrency token**, not a lock: two concurrent saves race,
the loser gets `409 fs-conflict` and the client must reload.

### 4.6 Exclude patterns

**verbatim** — `src/exclude-patterns.ts:19-40`

```ts
export const EXCLUDE_PATTERN_LIMIT = 64
export const EXCLUDE_PATTERN_MAX_LENGTH = 256

export type ExcludeTest = (entryPath: string, name: string) => boolean

export interface ExcludeMatcher extends ExcludeTest {
  readonly key: string
}
```

Grammar (normalised by `normalizePattern`: trim, `\`→`/`, drop `./`, drop leading `/`, drop
trailing `/`, drop `**/` head → suffix kind, drop a bare `**`):

| pattern | kind | matches |
|---|---|---|
| `node_modules` | `name` | any entry (file or dir) whose **base name** equals it, at any depth |
| `dist/assets` | `path` | the entry whose path **relative to cwd** equals it (anchored at the root) |
| `**/generated` | `suffix` | a name match **or** any trailing run of segments equal to the pattern |

Glob translation (`globToRegExp`): `**`→`.*`, `*`→`[^/]*`, `?`→`[^/]`; everything else regex-escaped;
anchored `^…$`; **case-insensitive on win32 only** (`/i` flag added when `process.platform === 'win32'`).
`compileExcludePatterns(raw, root, platform)` (`src/exclude-patterns.ts:115`) returns `undefined`
for a non-array, silently drops invalid patterns, and builds `key` as
`` `${root}\0${kind}:${source}:${flags}` `` joined by `\0` — the client passes that key back as the
`exclude` array and the cache key derives from it.

Excluded entries are neither returned **nor descended into** during `fs.search`.

### 4.7 Mutations

| op | rules |
|---|---|
| rename | `name` must be a single segment; renaming to the same name is a **no-op success** returning `{path: absolute}`; a pre-existing destination → `409 "…" already exists`; retries up to 10 times on `EPERM`/`EACCES`/`EBUSY` (Windows AV/indexer contention), yielding via `setImmediate` between attempts (`RENAME_CONTENTION`, `RENAME_ATTEMPT_LIMIT`) |
| mkdir | `mkdir(path/name)`; `EEXIST` → 409 |
| createFile | `writeFile(dest, '', {flag:'wx', encoding:'utf8'})`; `EEXIST` → 409 |
| remove | `lstat` first; directory → `rm({recursive:true})`, else `unlink` — **a symlink row unlinks the link only**; root refused |

`isWorkspaceRoot` compares `lstat` `dev`+`ino` as bigints, falling back to a spelling comparison
(win32 case-insensitive, `\\?\` prefix stripped) when inode identity is unavailable.

### 4.8 Upload

*equivalent logic* — `src/fs-operations.ts:134-183`

```
base     = resolveTarget(cwd, dir)
segments = relativePath.split(/[\\/]/)        // reject '' / '.' / '..' / leading '/'|'\'
target   = join(base, ...segments)
safe     = await ensureWorkspaceWritePath(cwd, target)
tmp      = join(dirname(safe), `.${basename(safe)}.dsh-upload-${randomUUID()}.tmp`)
mkdir(dirname(safe), { recursive: true })
createWriteStream(tmp, { flags: 'wx' })  <- pipe request chunks, honouring backpressure
renameIntoPlace(tmp, safe)                    // same contention retry as rename
stat(safe) -> invalidateDirectoryCache(dirname(safe))
return { path: safe, size }
```

On any failure the temp file is removed. The multipart/multi-file case is **client-side**: the
browser issues one request per file (`src/client/upload.ts:146`), sequentially, so a per-file
failure is isolated and reported in the summary.

---

## 5. Watch protocol — `/sidebar/ws/fs-watch`

### 5.1 Transport

WebSocket upgrade only (`src/index.ts:2001-2012`), handler `attachFsWatch(ctx, ws, req)`
(`src/index.ts:2054-2143`), server `new WebSocketServer({ noServer: true })`.

* URL: `ws(s)://<host>/sidebar/ws/fs-watch?sessionId=<id>`
* missing `sessionId` → `ws.close(1008, 'sessionId is required')` (`src/index.ts:2060-2063`)
* fence failure (upgrade level) → socket `destroy()`
* messages are **JSON text frames only**; malformed JSON is silently dropped
  (`catch { return }`, `src/index.ts:2118-2123`)

### 5.2 Client → server frames

**verbatim** — `src/index.ts:2054-2057`

```ts
interface FsWatchFrame {
  op?: unknown
  path?: unknown
}
```

| `op` | `path` | effect | reply |
|---|---|---|---|
| `"watch"` | non-empty string | resolve `dir`, add an OS watch | `{"dir":"<resolved>","ok":true}` or `ok:false` |
| `"unwatch"` | non-empty string | resolve `dir`, drop the watch | **none** |
| anything else / missing `path` / `path === ''` | — | silently ignored | none |

Server-side handling, *equivalent logic* (`src/index.ts:2124-2142`):

```
path = typeof frame.path === 'string' ? frame.path : undefined
if (path === undefined || path === '') return
try {
  cwd = await activeWorktreeRootOf(ctx, sessionId, await sessionCwdOf(ctx, sessionId))
  dir = await ensureWorkspacePath(cwd, path)
  if (frame.op === 'unwatch') { watchers.remove(dir); return }
  if (frame.op !== 'watch') return
  const ok = watchers.add(dir)
  ws.send(JSON.stringify({ dir, ok }))
} catch (error) {
  ws.send(JSON.stringify({ dir: path, ok: false, reason: message }))
}
```

Note `dir` in the success frame is the **resolved absolute** path; in the failure frame it is the
**raw as-sent** string — the client keys its watch set on the raw path it sent, so a failure is
recognisable as "this requested path was refused".

### 5.3 Server → client frames

| frame | when | client reaction |
|---|---|---|
| `{"dir":"<abs>","ok":true}` | a `watch` succeeded | adds `dir` to the confirmed set |
| `{"dir":"<raw>","ok":false,"reason":"<msg>"}` | resolution/add failed | ignored (no retry loop), the level just stays static |
| `{"dir":"<abs>","ok":false}` | an existing watcher errored | ignored |
| `{"dir":"<abs>"}` | a change was debounced in that directory | re-list that directory (`onStale`) |

**verbatim** — `src/fs-watch.ts:34-45`

```ts
export interface DirectoryWatchEvent {
  dir: string
}

export interface DirectoryWatchers {
  add(dir: string): boolean
  remove(dir: string): void
  close(): void
}
```

### 5.4 Debounce and limits

* `const DEBOUNCE_MS = 150` (`src/fs-watch.ts`): per-directory timer, `.unref()`ed, coalescing all
  events in a burst into **one** `{dir}` push.
* Before every push: `invalidateDirectoryCache(dir)` — so the client's immediate re-list is fresh
  and cannot be served from the 1.5 s listing cache.
* `const MAX_WATCHES = 64`: past the cap `add()` returns `false` (client sees `ok:false`). A
  directory is one `fs.watch(dir, { persistent: false })` handle, so cost scales with **expanded**
  directories, not with tree size. Collapsing a node sends `unwatch`.
* watcher `'error'` → `onError(dir)` → `{dir, ok:false}`, handle dropped.
* teardown: all clients of all three `WebSocketServer`s are closed on dispose
  (`src/index.ts:2036-2051`).

### 5.5 What it drives on the client

`src/client/use-dir-watch.ts`:

```ts
interface FsWatchFrame { dir?: unknown; ok?: unknown }
interface DirectoryWatchOptions {
  sessionId?: string
  root?: string
  dirs: readonly string[]
  visible?: boolean
  onStale: (dirs: readonly string[]) => void
}
```

* The **root is watched too**: `wanted = [root, ...dirs]`, deduped on `'\u0000'`.
* Armed only while the tree is visible, a `sessionId` exists and `wanted.length > 0`.
* Reconnect backoff: `min(1000 * 2**(n-1), 15000)` (`RETRY_BASE_MS = 1000`, `RETRY_MAX_MS = 15000`).
* After a reconnect the whole wanted set is re-sent and `onStale(allWanted)` fires **once**, so one
  batched re-list heals everything missed while the socket was down.
* `onStale(dirs)` → `FileTree.loadLevels(dirs, { force: true })` → one `fs.trees` batch for the
  affected levels (not a full tree reload).

Client refresh sources in total: the watch push, the `focus` window event and the custom
`dsh-sidebar:refresh-files` event, plus a 5 s `session.cwd` poll (`SESSION_ROOT_POLL_MS = 5_000`)
that re-roots the tree when the session cwd changes (`src/client/use-session-root.ts`).

---

## 6. Client usage

All client calls go through `src/client/api.ts`. `call<T>` POSTs JSON to
`sidebar/api/<method>`; `readEnvelope` requires HTTP ok, `parsed.ok === true` and
`parsed.value !== undefined`, otherwise throws
`SidebarApiError(parsed?.error?.code ?? 'http', parsed?.error?.message ?? 'HTTP <status>')`
(`src/client/api.ts:242-276`).

**verbatim** — `src/client/api.ts:369-377`

```ts
/** Fold a scope into a JSON payload ({cwd} only when present). */
function scopePayload(scope: SessionScope, extra: Record<string, unknown>): Record<string, unknown> {
  return {
    sessionId: scope.sessionId,
    ...(scope.cwd !== undefined && scope.cwd !== '' ? { cwd: scope.cwd } : {}),
    ...(scope.repoRoot !== undefined && scope.repoRoot !== '' ? { repoRoot: scope.repoRoot } : {}),
    ...extra,
  }
}
```

`SessionScope = { sessionId: string; cwd?: string; repoRoot?: string }`.

| endpoint / RPC | client function (file:line) | call site | payload | reads |
|---|---|---|---|---|
| `session.cwd` | `api.sessionCwd` `src/client/api.ts:432` | `src/client/use-session-root.ts:90` (polls every 5 s while visible) | `{sessionId}` | `value.cwd` becomes the tree root |
| `fs.trees` | `api.fsTrees` `src/client/api.ts:443` | `src/client/FileTree.tsx:963` | `{sessionId, cwd, paths: batch, exclude: excludeKey.split('\0')}` — batches of 64 | `levels[]` → per-level entries |
| `fs.tree` | `api.fsTree` `src/client/api.ts:434` | single-level refresh paths in `FileTree.tsx` | `{sessionId, cwd, path, exclude}` | one level |
| `fs.search` | `api.fsSearch` `src/client/api.ts:455` | `src/client/TreePanel.tsx:211` (filter box), `src/client/EditorHost.tsx:644` (quick-open candidate batches) | `{sessionId, cwd, query, exclude}` | `matches`, `dirs`, `truncated` |
| `fs.read` | `api.fsRead` `src/client/api.ts:457` | `TextEditor.tsx:888` (open), `EditorHost.tsx:582`, `changes/DiffPane.tsx:342`, `diff/use-git-diff.ts:97,164` | `{sessionId, cwd, repoRoot?, path}` | `kind` → editor / binary viewer / paged preview |
| `fs.readPage` | `api.fsReadPage` `src/client/api.ts:462` | `src/client/text-pages.ts:184` | `{sessionId, cwd, path, offset}` | appends `text`, sets next cursor to `nextOffset`, stops at `eof` |
| `fs.rename` | `api.fsRename` `src/client/api.ts:478` | `FileTree.tsx:1065` | `{sessionId, cwd, path, name}` | refreshes parent level |
| `fs.remove` | `api.fsRemove` `src/client/api.ts:482` | `FileTree.tsx:1324` (single), `:1548` (bulk) | `{sessionId, cwd, path}` | refreshes parent level |
| `fs.mkdir` | `api.fsMkdir` `src/client/api.ts:487` | `FileTree.tsx:1454` | `{sessionId, cwd, path, name}` | refreshes parent level |
| `fs.createFile` | `api.fsCreateFile` `src/client/api.ts:492` | `FileTree.tsx:1505` | `{sessionId, cwd, path, name}` | refreshes parent level |
| `POST /sidebar/write` | `api.fsWrite` `src/client/api.ts:473` → `fetchWrite` `:339` | `TextEditor.tsx:827` | query `{sessionId, path, cwd?, expectedMtimeMs?}`, body = document (LF), `content-type: text/plain; charset=utf-8` | `value.mtimeMs` → new CAS token |
| `POST /sidebar/upload` | `api.uploadFile` `src/client/api.ts:496` → `fetchUpload` `:299` | `src/client/upload.ts:146` | query `{sessionId, dir, relativePath, cwd?}`, body = `File` | `{path,size}` per file |
| `GET /sidebar/file` | `mediaUrl` `:689`, `downloadUrl` `:695`, `fileUrl` `:742` | `EditorHost.tsx:554` (media preview), `PdfView.tsx:25` (fetch), `binary-download.tsx:18`, `builtins/media-preview.tsx:71`, `LargeFileView.tsx:171`, `TextEditor.tsx:1241` (iframe src), `FileTree.tsx:1877` (download) | query `{sessionId, path: resolveSidebarPath(cwd, path), cwd?, download?}` | bytes |
| `GET /sidebar/html` | `htmlUrl` `src/client/api.ts:757` | `TextEditor.tsx:1241`, `changes/DiffPane.tsx:454` | path-encoded URL (`encodeHtmlUrl`) | rendered page |
| `archive.build` | `archiveBuild` `:707` | `FileTree.tsx:2008` | `{sessionId, cwd, paths, name}` | `{id, name, entries}` |
| `archive.status` | `archiveStatus` `:728` | `FileTree.tsx:1974` (250 ms self-scheduling poll) | `{sessionId, id}` | `{state, bytes, error?}` |
| `GET /sidebar/archive` | `archiveDownloadUrl` `:737` | `FileTree.tsx:1954` (anchor `href` + `download`) | query `{sessionId, id}` | bytes |

### 6.1 How the tree gets its root

1. `Sidebar.tsx:276` / `native/tab-adapter.tsx:503` call
   `useSessionRoot(ctx, sessionId, { visible })` → `src/client/use-session-root.ts:174`.
2. That hook calls `api.sessionCwd({ sessionId })` (`:90`) — the `session.cwd` RPC — every
   `SESSION_ROOT_POLL_MS = 5_000` ms while at least one visible subscriber exists and
   `document.visibilityState === 'visible'`, plus immediately on window `focus` and on the
   `dsh-sidebar:refresh-files` event.
3. The value is applied only if the generation matches and the cwd actually changed; on failure the
   hook falls back to the session list snapshot's stored `cwd`.
4. The resulting `cwd` is passed down as `root` (`FileTree.tsx:2325` `root={cwd}`) and sent back in
   every RPC payload as `cwd` — i.e. the **client echoes the root it was given**, and the host
   re-resolves it through `activeWorktreeRootOf` anyway, so a stale or malicious `cwd` cannot
   widen access (it only picks the base for relative paths).

### 6.2 Save path (editor)

`TextEditor.tsx:827`:

```ts
api.fsWrite(scope, path, text, mtimeRef.current ?? null).then((result) => {
  if (viewRef.current !== view) return                 // a file switch happened during the write
  if (typeof result.mtimeMs === 'number') mtimeRef.current = result.mtimeMs
  savedTextRef.current = text
  …
})
```

* `fsWrite(scope, path, content, expectedMtimeMs?: number | null)` maps `null` to *absent*
  (`expectedMtimeMs ?? undefined`, `src/client/api.ts:473-474`), i.e. "no CAS token — just write",
  which is what a file that did not exist at load time uses;
* the body is normalised to LF on the client; the host restores the file's own EOL;
* `mtimeRef` is the token returned by the last read/write; on `fs-conflict` the editor surfaces a
  reload prompt instead of retrying;
* a binary or `too-large` document never reaches the editor — it goes to the binary viewer or the
  paged preview (`text-pages.ts`), which is read-only, so no write is attempted.

### 6.3 Upload path

`src/client/upload.ts`:

```ts
interface UploadItem { file: File; relativePath: string }
interface UploadResult { relativePath: string; ok: boolean; path?: string; code?: string; error?: string }
```

* `relativePath` comes from `file.webkitRelativePath || file.name`, sanitised by
  `sanitizeRelativePath` (same rules as the host: no `''`/`.`/`..` segment, not absolute);
* folder drag-and-drop is traversed with `webkitGetAsEntry` + repeated `readEntries` batches;
* files are uploaded **sequentially**, one `POST /sidebar/upload` each, never rejecting the batch;
  an `AbortError` stops the queue; failures are summarised per file
  (`too-large` maps to the `uploadTooLarge` message).

---

## 7. Gaps vs a remote (SSH) backend

Everything below is a place where the implementation assumes it is running **on the same machine as
the files**. A remote implementation must either run this code remotely or reproduce it.

### 7.1 Direct `node:fs` access — must be proxied

| module | calls | impact |
|---|---|---|
| `src/fs-tree.ts:158-390` | `readdir(withFileTypes)`, `stat`, `lstat` | sorting, symlink/broken detection, compact probing, `listLimit` |
| `src/index.ts:498-700` | `stat`, `open`+`read` (fd-based window reads) | `fs.read` sniffing, `fs.readPage` byte windows |
| `src/fs-operations.ts` | `writeFile`/`createWriteStream`/`rename`/`mkdir`/`rm`/`unlink`/`lstat`/`stat` | all mutations; atomic temp-file + rename |
| `src/text-encoding.ts:539` | `open`+`read` for `fileFormatOf` | encoding/EOL sniff of the **existing** file before overwriting |
| `src/file-stream.ts:82` | `createReadStream` | `/sidebar/file` and `/sidebar/archive` bodies |
| `src/bundle-route.ts:55` | `stat`, `readFile` | chunk ETags (host-local, stays local) |

A remote backend must expose at least: `readdir` with `dirent` flags, `stat`/`lstat` with
`mtimeMs`/`size`/`mode`, `open`+`pread(offset,len)`, `stat`-based `isFile`, `write` (atomic via
temp+rename), `rename`, `mkdir(recursive)`, `rm(recursive)`, `unlink`, plus a streaming read for
byte ranges.

### 7.2 Byte ranges and streaming — must be re-implemented, not proxied naively

`byteRangeOf` (`src/file-stream.ts:44-80`) accepts exactly one range with the shape
`/^bytes=(\d*)-(\d*)$/u`, supports the suffix form `bytes=-N`, and returns `'unsatisfiable'` for
`size === 0` or `start >= size` (→ `416` + `content-range: bytes */size`). Multiple ranges fall
back to a **200 full body** (no multipart/byteranges is ever produced).

`streamFileToResponse` (`src/file-stream.ts:82`) opens the stream and awaits `'open'` **before**
writing headers, so a race with a delete still produces a JSON error rather than a truncated 200.

Over SSH this means SFTP `read` with offset/length or `dd`-style ranged reads plus correct
`content-length`/`content-range`; the "open before headers" guarantee has to be reconstructed from
the first read succeeding.

### 7.3 File watching — nothing to use over SSH

`src/fs-watch.ts` is a thin `fs.watch(dir, { persistent: false })` wrapper. There is **no**
chokidar, no polling, no reconfigure-RPC.

* one OS handle per **expanded** directory, capped at 64;
* no remote notification channel exists over SSH, so a remote backend must either run a watcher
  daemon on the remote side and forward events, or poll (which changes the 150 ms debounce
  semantics and the "push invalidates the listing cache" contract);
* `invalidateDirectoryCache` is an **in-process** cache of the host half
  (`src/fs-tree.ts:95`), so remote events must invalidate the proxy's cache too, or the tree will
  serve 1.5 s-stale levels.

### 7.4 Path resolution is host-platform-specific

`resolveTarget` (`src/path-security.ts:65`) uses `node:path` (`resolve`/`join`/`isAbsolute`),
`os.homedir()`, and `resolveSessionPath`'s Windows/WSL/mirror rewriting
(`src/session-path.ts:101`, regexes at `:5` and `:12`, remote meta at `:15`). On a POSIX remote:

* `~` must expand to the **remote** home, not the host user's;
* a Windows drive path (`D:\…`) or UNC path (`\\server\share`) is meaningless — but the client
  sends absolute Windows paths because `session.cwd` returned one;
* `requireAbsolute` and `isWorkspaceRoot`'s `dev`+`ino` identity check have no POSIX analogue
  worth relying on (inode is meaningful, but `dev`+`ino` across an SFTP session is not exposed);
* `resolveSessionPath`'s WSL/mirror translation exists precisely because the host and the target
  disagree about path syntax — a remote backend must decide on one canonical path language and
  translate at the single boundary, otherwise the html route's relative-asset resolution breaks
  (7.6).

### 7.5 Binary detection, encodings and paging math run on the host

`decodeTextBytes` (`src/text-encoding.ts:240`) runs an 11-way decision (UTF-32/16 BOMs, BOM-less
UTF-16 NUL-lane heuristic, NUL-byte binary rejection, fatal UTF-8, GB18030, GBK, lossy UTF-8).
`lastLineBreakEnd` (`:335`) is **unit-width aware** (1/2/4 bytes) because trimming a page at a byte
offset would corrupt a UTF-16 file.

To keep `nextOffset`/`eof`/`encoding` byte-compatible over SSH, the remote side must deliver
**raw bytes** for the window and let the host do this decoding — i.e. the proxy must expose
`pread(offset,len)` and `stat`, not pre-decoded text. Doing the decode remotely would change the
sniffing results (ICU availability for `gbk`/`gb18030` varies by Node build).

### 7.6 `/sidebar/html` encodes the path in the URL, not the query

**verbatim** rationale, `src/html-route.ts:1-35`:

> Why path-encoded parameters instead of a query string: the previewed page resolves its relative
> assets (./style.css, img/x.png) against the document URL, and the WHATWG URL algorithm DROPS the
> query of a path-relative reference — `/sidebar/html?a=1&path=/a/b/` + `./style.css` would lose
> the session scope and the route would reject the asset.

So the URL must keep the shape
`/sidebar/html/<sessionId>/<absolute path segments, encodeURIComponent'd>` (UNC encoded as
`/<sid>//server/share/...`, home-relative as `/<sid>/~/notes/x.html`, Windows drive as
`/<sid>/C%3A/Users/...`). Any remote proxy that rewrites the path shape breaks every relative asset
on the previewed page.

### 7.7 External tool invocation

* **Archive**: `resolveArchiveTool` probes `zip` then `tar` on the host and shells out
  (`src/archive-tools.ts:129`, `:190`, `:276`); `archiveFileName` caps the stem at
  `ARCHIVE_STEM_MAX = 100` (`:311-340`). Over SSH the packing must happen **remotely** (else every
  file is downloaded first), which means the remote side needs `zip`/`tar`, and the "no tool"
  branch becomes a remote capability probe.
* **Search**: `src/fs-search.ts:286` tries `usableEngines()` and spawns `fd`/`rg`
  (`src/search-engines.ts`, 27 KB) with the needle and `maxMatches + 1` as arguments, post-filters
  with the exclude matcher, and falls back to a pure `opendir` walk. Over SSH the binary may not
  exist or may be a different version — the fallback walk is the safe path, but it changes results
  for the `dirs` intersection and for `truncated`.
* **open.external**: `launchExternal` runs `explorer.exe /select,…` or a URL opener on the host
  (`src/open-external.ts:329`, `:113`, `:180`); over SSH "reveal in file manager" is meaningless —
  it must open the remote file in a remote editor or be dropped.
* **git**: every `git.*` RPC runs `git` with `cwd` (`src/git.ts:581`), including WSL launching
  (`wslLaunch`, `:427`) — out of scope here, but it shares the same cwd-resolution chain.

### 7.8 Process-identity assumptions

* `process.cwd()` is the last cwd fallback (`src/index.ts:271`) — on a remote target it means
  nothing.
* `process.platform` decides exclude-pattern case sensitivity, `SEPARATOR_RE`, `DOT_ANCHORED_RE`
  and the reserved-name checks (`fs-operations.ts`, `exclude-patterns.ts`, `fs-search.ts`).
* `homedir()` is used for `~` expansion.
* The directory cache, the wide-encoding page cache, the mtime in-flight dedupe map and the archive
  task table are all **in-process** state keyed by local absolute paths — a proxy must key them by
  `(target, path)` instead, or two sessions on different hosts will collide.

### 7.9 Minimal remote contract

To serve this interface faithfully over SSH, the remote agent needs (all paths as opaque strings,
all failures mapped to the same `{code,message}` vocabulary):

| capability | used by |
|---|---|
| `stat`/`lstat` → `{isDir,isFile,isSymlink,size,mtimeMs,mode}` | tree, read, write CAS, `/sidebar/file` |
| `readdir` → `[{name,isDir,isSymlink}]` | `fs.tree`, `fs.trees` |
| `pread(path, offset, length)` → bytes | `fs.read` (4 KiB sniff / whole ≤5 MiB), `fs.readPage` (128 KiB), `/sidebar/file` ranges, archive download |
| `writeFile(path, bytes, {exclusive})` + `rename` + `mkdir` + `rm` + `unlink` | write, upload, rename/mkdir/createFile/remove |
| `watch(dir)` stream of change events (or a documented polling substitute) | `fs.watch` replacement |
| `spawn`/probe for `fd`, `rg`, `zip`, `tar` (optional) | search engines, archive builder |

Losses that must be documented to callers: symlink probing latency (one `stat` per entry, capped at
32/batch), `dev`+`ino` root identity, atomicity of remote temp+rename, and the mtime granularity
used by the CAS token (an mtime with second granularity makes `fs-conflict` fire spuriously or not
at all).

---

## Appendix A — verbatim declarations index

| declaration | file:line |
|---|---|
| `SidebarErrorCode` | `src/wire.ts:14-37` |
| `SidebarError` | `src/wire.ts:39-50` |
| `MAX_BODY_BYTES` | `src/wire.ts:52` |
| `SidebarOk` / `SidebarErr` | `src/wire.ts:55-60` |
| `readJsonBody` / `readTextBody` | `src/wire.ts:70` / `:114` |
| `writeOk` / `writeError` / `requireString` | `src/wire.ts:150` / `:155` / `:178` |
| `SidebarReadResult` | `src/index.ts:505-513` |
| `SidebarFsLevel` | `src/index.ts:107-112` |
| `ReadPageResult` | `src/index.ts:595-605` |
| `SidebarFsEntry` | `src/fs-tree.ts:26-44` |
| `SidebarFsListing` | `src/fs-tree.ts:46-49` |
| `compareEntries` | `src/fs-tree.ts:60-68` |
| `DIRECTORY_CACHE_TTL_MS` / `invalidateDirectoryCache` / `DIRECTORY_CACHE_MAX` | `src/fs-tree.ts:78` / `:111` / `:124` |
| `listDirectory` | `src/fs-tree.ts:158` |
| `PROBE_BUDGET` / `ProbeGate` / `createProbeGate` | `src/fs-tree.ts:223` / `:226` / `:240` |
| `rootLabel` / `parentOf` / `requireAbsolute` / `isWithin` / `messageOf` | `src/fs-tree.ts:387` / `:393` / `:405` / `:424` / `:437` |
| `resolveTarget` / `ensureWorkspacePath` / `ensureWorkspaceWritePath` | `src/path-security.ts:65` / `:38` / `:56` |
| `resolveSessionPath` (+ WSL/mirror regexes) | `src/session-path.ts:101` (+ `:5`, `:12`, `:15`) |
| `WorkspaceUploadInput` / `writeWorkspaceUpload` | `src/fs-operations.ts:45` / `:134` |
| `WorkspaceWriteInput` / `writeWorkspaceText` | `src/fs-operations.ts:184` / `:223` |
| `WorkspaceRenameInput` / `renameWorkspaceEntry` | `src/fs-operations.ts:265` / `:362` |
| `WorkspaceMkdirInput` / `mkdirWorkspaceEntry` | `src/fs-operations.ts:385` / `:405` |
| `WorkspaceCreateFileInput` / `createWorkspaceFile` | `src/fs-operations.ts:477` / `:501` |
| `WorkspaceRemoveInput` / `removeWorkspaceEntry` | `src/fs-operations.ts:523` / `:540` |
| `FsSearchResult` / `FsSearchOptions` | `src/fs-search.ts:59` / `:70` |
| `searchFilesPlain` / `searchFiles` | `src/fs-search.ts:180` / `:286` |
| `TextEncoding` / `DecodedText` / `TextEol` / `FileFormat` | `src/text-encoding.ts:11` / `:23` / `:38` / `:42` |
| `decodeTextBytes` / `unitWidth` / `isWideEncoding` / `lastLineBreakEnd` | `src/text-encoding.ts:240` / `:294` / `:312` / `:335` |
| `decodeTextAs` / `bomlessEncoding` / `encodeText` | `src/text-encoding.ts:366` / `:395` / `:491` |
| `detectEol` / `restoreEol` / `fileFormatOf` | `src/text-encoding.ts:513` / `:527` / `:539` |
| `MAX_EDITABLE_BYTES` / `PAGE_BYTES` / `WRITE_BODY_GUARD_BYTES` / `MAX_EDITABLE_LABEL` | `src/editor-limits.ts:27` / `:39` / `:50` / `:76` |
| `ByteRange` / `byteRangeOf` / `streamFileToResponse` | `src/file-stream.ts:26` / `:44` / `:82` |
| `EXCLUDE_PATTERN_LIMIT` / `EXCLUDE_PATTERN_MAX_LENGTH` / `ExcludeTest` / `ExcludeMatcher` | `src/exclude-patterns.ts:19` / `:21` / `:24` / `:36` |
| `compileExcludePatterns` | `src/exclude-patterns.ts:115` |
| `DirectoryWatchEvent` / `DirectoryWatchers` / `createDirectoryWatchers` | `src/fs-watch.ts:34` / `:40` / `:67` |
| `FS_TREES_MAX_PATHS` | `src/fs-batch.ts:10` |
| `HtmlRouteRef` / `HtmlDecodeResult` / `HTML_ROUTE_PREFIX` | `src/html-route.ts:38` / `:45` / `:50` |
| `encodeHtmlUrl` / `decodeHtmlUrl` | `src/html-route.ts:53` / `:66` |
| `CHUNK_NAMES` / `createBundleRouteHandler` / `registerBundleRoute` | `src/bundle-route.ts:25` / `:73` / `:139` |
| `ARCHIVE_MAX_BUILDING` / `ARCHIVE_TTL_MS` / `ArchiveStatus` | `src/archive-route.ts:52` / `:54` / `:78` |
| `contentDispositionOf` / `respondArchiveDownload` / `ArchiveTasks` | `src/archive-route.ts:100` / `:143` / `:188` |
| `fileReadError` | `src/fs-read-error.ts:7` |
| `SidebarConfig` / `ResolvedSidebarConfig` / `resolveSidebarConfig` / `PrefsSchema` | `src/config.ts:31` / `:67` / `:79` / `:100` |
| `activeWorktreeRootOf` | `src/active-worktree.ts:504` |

## Appendix B — client types (mirror of the wire)

`src/client/api.ts`:

```ts
interface FsEntry { name: string; path: string; isDir: boolean; hidden: boolean; isSymlink: boolean; broken: boolean; compact?: boolean }
interface FsLevel { path: string; entries: FsEntry[]; truncated: boolean; error?: string }
class SidebarApiError extends Error { constructor(readonly code: string, message: string) }
```

`src/client/upload.ts`: `UploadItem { file: File; relativePath: string }`,
`UploadResult { relativePath: string; ok: boolean; path?: string; code?: string; error?: string }`.

`src/client/use-dir-watch.ts`: `FsWatchFrame { dir?: unknown; ok?: unknown }`,
`DirectoryWatchOptions { sessionId?: string; root?: string; dirs: readonly string[]; visible?: boolean; onStale: (dirs: readonly string[]) => void }`.
