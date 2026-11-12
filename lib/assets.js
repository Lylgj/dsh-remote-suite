// Static assets for the browser half (the terminal emulator).
//
// The client bundle may only `require('react')` and the primitives package, so
// xterm is loaded the way the Host's own terminal plugin loads it: a `<script>`
// from a same-origin route this plugin serves. The files live in assets/ and are
// served flat — no subdirectories, no traversal.

import { promises as fsp } from 'node:fs'
import { extname, join } from 'node:path'

const CONTENT_TYPES = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
}

/** Reject anything that is not a single plain file name. */
function isPlainName(name) {
  return typeof name === 'string' && name !== '' && !name.includes('/') && !name.includes('\\') && !name.includes('..')
}

/**
 * Serve one asset out of `root`.
 *
 * @returns true when the file existed and the response was written
 */
export async function serveAsset(root, name, res) {
  if (!isPlainName(name)) return false
  try {
    const data = await fsp.readFile(join(root, name))
    res.writeHead(200, {
      'content-type': CONTENT_TYPES[extname(name)] || 'application/octet-stream',
      'cache-control': 'public, max-age=300',
      'x-content-type-options': 'nosniff',
    })
    res.end(data)
    return true
  } catch {
    return false
  }
}
