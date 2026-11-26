import {
  app,
  BrowserWindow,
  Menu,
  Tray,
  ipcMain,
  powerMonitor,
  safeStorage,
  dialog,
  session,
  shell,
  nativeImage,
} from 'electron'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Monitor, displayState } from './monitor.mjs'
import { saveProfitSource } from './profit.mjs'
import { configureHttp } from './http.mjs'
import { exportConfig, importConfig, readConfigFile, writeConfigFile } from './config-transfer.mjs'

const appLabel = app.isPackaged ? 'QuotaDesk' : 'QuotaDesk 开发版'
app.name = appLabel
if (!app.isPackaged && !app.commandLine.hasSwitch('user-data-dir')) {
  app.setPath('userData', join(app.getPath('appData'), 'QuotaDesk-dev'))
}
app.setAppUserModelId(app.isPackaged ? 'cn.quotadesk.monitor' : 'cn.quotadesk.monitor.dev')
const here = dirname(fileURLToPath(import.meta.url)),
  watched = !app.isPackaged && !!process.send && !!process.env.QUOTADESK_DEV_UI,
  index = watched ? process.env.QUOTADESK_DEV_UI : join(here, '../desktop-ui/index.html')
let window,
  tray,
  monitor,
  timer,
  quitting = false,
  pendingExit,
  activeRequests = 0,
  showOnReady = !(watched && app.commandLine.hasSwitch('quotadesk-start-hidden'))
function show() {
  showOnReady = true
  if (!window || window.isDestroyed()) createWindow()
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
}
function createWindow() {
  window = new BrowserWindow({
    width: 1300,
    height: 880,
    minWidth: 760,
    minHeight: 550,
    title: appLabel + ' · 费用监控',
    show: false,
    backgroundColor: '#191b2a',
    icon: join(here, 'assets/icon.ico'),
    webPreferences: {
      preload: join(here, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
      devTools: !app.isPackaged,
    },
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  if (!app.isPackaged) window.on('page-title-updated', (event) => event.preventDefault())
  window.webContents.on('will-navigate', (e) => e.preventDefault())
  window.once('ready-to-show', () => { if (showOnReady) window.show() })
  window.on('close', (e) => {
    if (!quitting) {
      e.preventDefault()
      window.hide()
    }
  })
  window.on('closed', () => {
    window = null
  })
  window.loadFile(index).catch(() => dialog.showErrorBox('QuotaDesk', '无法打开应用界面。'))
}
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  if (watched) {
    // Finish already-started queries and deliveries before replacing the main process.
    const exitWhenIdle = async (reason) => {
      const waiting = pendingExit !== undefined
      if (reason === 'quit' || !waiting) pendingExit = reason
      if (waiting) return
      clearInterval(timer)
      while (activeRequests || monitor?.sending || monitor?.sendingFlashduty || monitor?.flights.size || monitor?.profitFlight)
        await new Promise((done) => setTimeout(done, 100))
      quitting = true
      app.exit(pendingExit === 'quit' ? 0 : window?.isVisible() ? 75 : 76)
    }
    process.on('message', (command) => {
      if (command === 'reload' && !pendingExit && window && !window.isDestroyed())
        window.webContents.reloadIgnoringCache()
      if (command === 'restart' || command === 'quit') void exitWhenIdle(command)
    })
    process.on('disconnect', () => { void exitWhenIdle('quit') })
  }
  app.on('second-instance', () => {
    if (app.isReady()) show()
  })
  app.on('before-quit', () => {
    quitting = true
    clearInterval(timer)
  })
  app
    .whenReady()
    .then(async () => {
      Menu.setApplicationMenu(null)
      session.defaultSession.setPermissionRequestHandler((_wc, _perm, respond) => respond(false))
      monitor = new Monitor(
        join(app.getPath('userData'), 'quotadesk.sqlite'),
        safeStorage,
        (state) => {
          if (window && !window.isDestroyed()) window.webContents.send('desk:changed', displayState(state))
          tray?.setToolTip(
            appLabel + ' · ' + state.sites.filter((s) => !s.paused).length + ' 个站点监控中',
          )
        },
      )
      await configureHttp(session, () => monitor.state.followSystemProxy)
      const configFilters = [{ name: 'QuotaDesk 加密配置', extensions: ['qdconfig'] }]
      const actions = {
        state: () => displayState(monitor.state),
        saveProfitSource: (x) => saveProfitSource(monitor, x),
        exportConfig: async ({ password }) => {
          const choice = await dialog.showSaveDialog(window, {
            title: '导出配置', filters: configFilters,
            defaultPath: join(app.getPath('documents'), 'QuotaDesk-' + new Date().toLocaleDateString('sv-SE') + '.qdconfig'),
          })
          if (choice.canceled) return null
          const { bytes, count } = await exportConfig(monitor, password)
          await writeConfigFile(choice.filePath, bytes)
          return { count }
        },
        importConfig: async ({ password, applyPreferences }) => {
          const choice = await dialog.showOpenDialog(window, {
            title: '导入配置', filters: configFilters, properties: ['openFile'],
          })
          if (choice.canceled) return null
          return importConfig(monitor, await readConfigFile(choice.filePaths[0]), password, applyPreferences)
        },
        openSite: ({ id }) => {
          const site = monitor.state.sites.find((s) => s.id === id)
          if (!site) throw Error('站点不存在。')
          const url = new URL(site.origin)
          if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
            throw Error('站点网址无效。')
          return shell.openExternal(site.provider === 'custom' ? url.origin : url.href)
        },
        probe: (x) => monitor.probe(x),
        saveSite: (x) => monitor.saveSite(x),
        updateSite: (x) => monitor.updateSite(x),
        setAutoUsd: (x) => monitor.setAutoUsd(x),
        refresh: (x) => (x?.id ? monitor.refreshSite(x.id) : monitor.sweep(true)),
        preferences: (x) => monitor.preferences(x),
        saveMail: (x) => monitor.configure(x),
        testMail: (x) => monitor.configure(x, true),
        saveFlashduty: (x) => monitor.configureFlashduty(x),
        testFlashduty: (x) => monitor.configureFlashduty(x, true),
        retryFlashduty: (x) => monitor.retryFlashduty(x.id),
        retry: (x) => monitor.retry(x.id),
      }
      for (const [name, handler] of Object.entries(actions)) {
        ipcMain.handle('desk:' + name, async (event, arg) => {
          if (
            event.sender !== window?.webContents ||
            event.senderFrame !== event.sender.mainFrame ||
            event.senderFrame.url !== pathToFileURL(index).href
          )
            return { ok: false, error: '无效的窗口请求。' }
          if (pendingExit) return { ok: false, error: '开发版正在重新加载。' }
          activeRequests++
          try {
            return { ok: true, value: await handler(arg) }
          } catch (error) {
            return { ok: false, error: error.message || '操作失败，请重试。' }
          } finally {
            activeRequests--
          }
        })
      }
      tray = new Tray(nativeImage.createFromPath(join(here, 'assets/icon.ico')))
      tray.setToolTip(appLabel + ' · 余额监控')
      tray.setContextMenu(
        Menu.buildFromTemplate([
          { label: '打开 ' + appLabel, click: show },
          { label: '立即查询', click: () => { if (!pendingExit) monitor.sweep(true).catch(report) } },
          { type: 'separator' },
          { label: '退出并停止监控', click: () => app.quit() },
        ]),
      )
      tray.on('click', show)
      createWindow()
      const tick = () => { if (!pendingExit) monitor.sweep().catch(report) }
      timer = setInterval(tick, 15000)
      powerMonitor.on('resume', tick)
      tick()
    })
    .catch((error) => {
      dialog.showErrorBox('QuotaDesk 启动失败', error.message)
      app.quit()
    })
}
function report(error) {
  console.error('Monitor:', error.name)
}
