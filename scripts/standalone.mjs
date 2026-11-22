import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

// The prototype also opens from disk without a local server.
const dir = resolve('dist')
const html = await readFile(resolve(dir, 'index.html'), 'utf8')
const jsTag = html.match(/<script\b[^>]*src="([^"]+)"[^>]*><\/script>/)
const cssTag = html.match(/<link\b[^>]*rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/)
if (!jsTag || !cssTag) throw new Error('Expected one application bundle and stylesheet')
const js = await readFile(resolve(dir, jsTag[1]), 'utf8')
const css = await readFile(resolve(dir, cssTag[1]), 'utf8')
const packed = html
  .replace(jsTag[0], '')
  .replace(cssTag[0], () => '<style>' + css + '</style>')
  .replace(
    '</body>',
    () => '<script type="module">' + js.replace(/<\/script/gi, '<\\/script') + '</script></body>',
  )
await writeFile(resolve(dir, 'index.html'), packed)
