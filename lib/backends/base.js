// Backend contract shared by every target kind.
//
// A backend is the ONLY thing the tool layer talks to. Nothing above this seam
// knows whether the path is a Windows drive, a 9p share or an SFTP session.
//
//   exec({ command, workdir?, timeoutMs?, stdin? })
//     -> { stdout, stderr, exitCode, timedOut, truncated }
//   read({ path, maxBytes? })            -> string (utf8)
//   write({ path, data })                -> { bytes }
//   stat({ path })                       -> { type, size, mtimeMs, mode? }
//   list({ path, limit? })               -> { entries: [{ name, type, size }] }
//   home()                               -> string (expanded `~`), optional
//   probe()                              -> env facts, optional
//   dispose()
//
// Implementations must throw on failure; nothing here swallows errors.

export const MAX_OUTPUT_BYTES = 64 * 1024

export function truncate(text, maxBytes = MAX_OUTPUT_BYTES) {
  if (typeof text !== 'string') return { text: '', truncated: false }
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return { text, truncated: false }
  // Cut on a character boundary so the marker never lands inside a code point.
  let out = text.slice(0, maxBytes)
  let bytes = Buffer.byteLength(out, 'utf8')
  while (bytes > maxBytes) {
    out = out.slice(0, -1)
    bytes = Buffer.byteLength(out, 'utf8')
  }
  return { text: out, truncated: true }
}
