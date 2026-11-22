import { spawn } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync, watch } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import electron from 'electron'
import { build } from 'vite'

const root = fileURLToPath(new URL('../', import.meta.url))
// Each launch builds privately, including when another launch only raises the tray window.
const outDir = mkdtempSync(join(tmpdir(), 'quotadesk-dev-ui-'))
const args = process.argv.slice(2)
const watchers = []
let child, debounce
let running = false, closing = false, uiDirty = true, nativeDirty = true, startHidden = false
let uiValid = false, nativeValid = false

function check(args) {
  return new Promise((done, fail) => {
    const command = spawn(process.execPath, args, { cwd: root, stdio: 'inherit', windowsHide: true })
    command.once('error', fail)
    command.once('exit', (code) => code === 0 ? done() : fail(Error('源码检查未通过')))
  })
}

function launch() {
  const extra = startHidden ? ['--quotadesk-start-hidden'] : []
  child = spawn(electron, ['.', ...args, ...extra], {
    cwd: root, stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    env: { ...process.env, QUOTADESK_DEV_UI: join(outDir, 'index.html') },
  })
  child.once('error', (error) => {
    console.error(error.message)
    shutdown(1)
  })
  child.once('exit', (code) => {
    child = undefined
    if (!closing && (code === 75 || code === 76)) {
      startHidden = code === 76
      launch()
    } else if (closing || code === 0) {
      shutdown()
    } else {
      console.error('[QuotaDesk] 开发版已停止，保存源码后将重新启动。')
    }
  })
}

async function refresh() {
  if (running || closing) return
  running = true
  const render = uiDirty || !uiValid, restart = nativeDirty || !nativeValid
  if (render) uiValid = false
  if (restart) nativeValid = false
  uiDirty = nativeDirty = false
  try {
    if (render) {
      await check([join(root, 'node_modules/typescript/bin/tsc'), '--noEmit'])
      await build({ root, build: { outDir, emptyOutDir: false }, logLevel: 'error' })
      uiValid = true
    }
    if (restart) {
      for (const file of readdirSync(join(root, 'desktop')).filter((f) => /\.(cjs|mjs|js)$/.test(f))) {
        await check(['--check', join(root, 'desktop', file)])
      }
      nativeValid = true
    }
    if (closing) return
    if (!child) launch()
    else if (child.connected) child.send(restart ? 'restart' : 'reload')
    console.log('[QuotaDesk]', restart ? '已加载开发版源码' : '界面已重新构建')
  } catch (error) {
    console.error('[QuotaDesk]', error.message, '保存修正后会自动重试。')
  } finally {
    running = false
    if (uiDirty || nativeDirty) schedule()
  }
}

function schedule() {
  clearTimeout(debounce)
  debounce = setTimeout(refresh, 220)
}

for (const folder of ['src', 'desktop', '.']) {
  watchers.push(watch(join(root, folder), { recursive: folder !== '.' }, (_event, name) => {
    if (folder === '.') {
      if (!['index.html', 'tsconfig.json', 'vite.config.ts', 'package.json'].includes(name)) return
      if (name === 'package.json') nativeDirty = true
      uiDirty = true
    } else if (folder === 'desktop') nativeDirty = true
    else uiDirty = true
    schedule()
  }))
}

function shutdown(code = 0) {
  closing = true
  clearTimeout(debounce)
  for (const watcher of watchers) watcher.close()
  if (child?.connected) child.send('quit')
  process.exitCode = code
}
process.on('SIGINT', () => shutdown())
process.on('SIGTERM', () => shutdown())
process.on('exit', () => {
  if (dirname(outDir) === resolve(tmpdir()) && basename(outDir).startsWith('quotadesk-dev-ui-'))
    rmSync(outDir, { recursive: true, force: true, maxRetries: 3 })
})
console.log('[QuotaDesk] 正在监听界面和桌面源码，关闭窗口后仍在托盘监控。')
await refresh()
