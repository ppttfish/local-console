/**
 * 主进程入口 —— GUI 模式（带文件日志）
 *
 * 含：托盘常驻、9600 web、MCP、自动升级（GitHub Releases）
 */
import {
  app,
  BrowserWindow,
  shell,
  Tray,
  Menu,
  ipcMain,
  nativeImage,
  screen
} from 'electron'
import { join } from 'node:path'
import { appendFileSync, mkdirSync, existsSync } from 'node:fs'
import { updater } from './updater.js'
import { IpcChannels } from '../shared/ipc-channels.js'

// 单实例锁（必须在 app 初始化前调）
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
  process.exit(0)
} else {
  app.on('second-instance', () => showMainWindow())
}

// 统一各入口数据目录：Electron 打包版默认 userData 是 %APPDATA%\<productName>，
// 而 http-standalone / CLI 用 %LOCALAPPDATA%\local-console（见 http-standalone.ts resolveUserData）。
// 不对齐会导致安装版打开后服务配置与用量统计全空。必须在 ready 前设置。
app.setPath(
  'userData',
  join(process.env['LOCALAPPDATA'] || app.getPath('appData'), 'local-console')
)

const isDev = !app.isPackaged
let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let isQuitting = false
let userData = ''
let logsDir = ''
let logFile = ''

function slog(msg: string): void {
  if (!logFile) return
  try {
    appendFileSync(logFile, `[${new Date().toISOString()}] ${msg}\n`)
  } catch {
    // ignore
  }
}

process.on('uncaughtException', (err) => {
  slog(`UNCAUGHT: ${err.message}\n${err.stack}`)
})
process.on('unhandledRejection', (reason) => {
  slog(`UNHANDLED REJECTION: ${String(reason)}`)
})

// 业务模块
import { initDatabase, closeDatabase } from './services/db.js'
import { EventBus } from './services/event-bus.js'
import { ServiceManager } from './services/service-manager.js'
import { PortScanner } from './services/port-scanner.js'
import { LogStreamer } from './services/log-streamer.js'
import { PluginRegistry } from './plugins/registry.js'
import { registerIpcHandlers } from './ipc/index.js'
import { startMcpSubprocess } from './mcp/spawn.js'
import { startHttpServer } from './http-server.js'

export const bus = new EventBus()
export let serviceManager: ServiceManager
export let portScanner: PortScanner
export let logStreamer: LogStreamer
export let pluginRegistry: PluginRegistry

function showMainWindow(): void {
  if (!mainWindow) {
    void createMainWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

async function createMainWindow(): Promise<void> {
  slog('createMainWindow: start')
  const iconPath = isDev
    ? join(__dirname, '../../build/icon.ico')
    : join(process.resourcesPath, 'icon.ico')

  const opts: Electron.BrowserWindowConstructorOptions = {
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    icon: existsSync(iconPath) ? iconPath : undefined,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  }
  if (process.platform === 'win32') {
    // 多显示器时把窗口放到主屏，避免窗口跑到不可见坐标
    const display = screen.getPrimaryDisplay()
    opts.x = display.workArea.x + 50
    opts.y = display.workArea.y + 50
  }
  mainWindow = new BrowserWindow(opts)
  slog('createMainWindow: BrowserWindow created')

  mainWindow.on('ready-to-show', () => {
    slog('ready-to-show fired')
    mainWindow?.show()
  })
  mainWindow.on('show', () => slog('window shown'))
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      slog('window close -> hide to tray')
      e.preventDefault()
      mainWindow?.hide()
    } else {
      slog('window close (quitting)')
    }
  })
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('did-fail-load', (_e, code, desc) => {
    slog(`did-fail-load: ${code} ${desc}`)
  })
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    slog(`render-process-gone: ${JSON.stringify(details)}`)
  })

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    await mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    const outsideRenderer = join(__dirname, '../renderer/index.html')
    const insideAsr = join(process.resourcesPath, 'renderer/index.html')
    const indexFile = existsSync(outsideRenderer) ? outsideRenderer : insideAsr
    slog(`loadFile: ${indexFile} (exists=${existsSync(indexFile)})`)
    await mainWindow.loadFile(indexFile)
  }
  slog('createMainWindow: loadFile done')
}

function buildTray(): void {
  try {
    const iconPath = isDev
      ? join(__dirname, '../../build/icon.ico')
      : join(process.resourcesPath, 'icon.ico')
    let trayIcon: Electron.NativeImage | undefined
    if (existsSync(iconPath)) {
      trayIcon = nativeImage.createFromPath(iconPath)
      if (trayIcon.isEmpty()) trayIcon = undefined
    }
    tray = new Tray(trayIcon ?? iconPath)
    const menu = Menu.buildFromTemplate([
      {
        label: '显示主窗口',
        click: () => showMainWindow()
      },
      { type: 'separator' },
      {
        label: '打开 Web 版 (127.0.0.1:9600)',
        click: () => shell.openExternal('http://127.0.0.1:9600')
      },
      {
        label: '打开数据目录',
        click: () => shell.openPath(userData)
      },
      {
        label: '打开日志目录',
        click: () => shell.openPath(logsDir)
      },
      { type: 'separator' },
      {
        label: '检查更新',
        click: async () => {
          const r = await updater.checkInteractive()
          if (r.status === 'dev-skip') {
            slog('tray: check update skipped (dev)')
          } else if (r.status === 'available') {
            slog(`tray: update available v${r.version}`)
          } else {
            slog(`tray: check result=${r.status} err=${r.error ?? '-'}`)
          }
        }
      },
      {
        label: '开机自启',
        type: 'checkbox',
        checked: app.getLoginItemSettings().openAtLogin,
        click: (item) => {
          app.setLoginItemSettings({
            openAtLogin: item.checked,
            openAsHidden: true
          })
        }
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          slog('tray: exit clicked')
          isQuitting = true
          app.quit()
        }
      }
    ])
    tray.setToolTip('小福鱼')
    tray.setContextMenu(menu)
    tray.on('double-click', () => showMainWindow())
    slog('tray created')
  } catch (e) {
    slog(`buildTray error: ${(e as Error).message}`)
  }
}

app.whenReady().then(async () => {
  // 1. 路径（必须在 whenReady 后）
  userData = app.getPath('userData')
  logsDir = join(userData, 'logs')
  if (!existsSync(userData)) mkdirSync(userData, { recursive: true })
  if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true })
  logFile = join(userData, 'startup.log')
  slog('=== main process boot ===')
  slog(`userData=${userData}`)
  slog(`isPackaged=${app.isPackaged}`)

  // 2. 单实例在拿到锁后，初始化共享模块
  try {
    serviceManager = new ServiceManager(bus, { userData, logsDir })
    portScanner = new PortScanner(bus)
    logStreamer = new LogStreamer(bus, logsDir)
    pluginRegistry = new PluginRegistry(bus, app.getVersion())
    slog('shared instances created')
  } catch (e) {
    slog(`shared instance error: ${(e as Error).message}`)
  }

  // 3. 业务
  try {
    initDatabase(userData)
    await logStreamer.start()
    await portScanner.start()
    await serviceManager.start()
    await pluginRegistry.loadAll()
    registerIpcHandlers(serviceManager, portScanner, logStreamer, () => mainWindow)
    slog('business init done')
  } catch (e) {
    slog(`business init error: ${(e as Error).message}\n${(e as Error).stack}`)
  }

  // 4. 托盘（先于窗口，让用户能恢复）
  buildTray()

  // 5. 窗口（最重要）
  try {
    await createMainWindow()
  } catch (e) {
    slog(`createMainWindow error: ${(e as Error).message}\n${(e as Error).stack}`)
  }

  // 6. 9600 HTTP server（容错）
  //    共享主进程已有的 ServiceManager / PortScanner / LogStreamer：
  //    各建一套的话 Web 端启停的服务在桌面端状态里看不见（两个独立的 procs Map）
  try {
    const rendererDir = isDev
      ? join(__dirname, '../renderer')
      : join(process.resourcesPath, 'renderer')
    await startHttpServer({
      userData,
      port: 9600,
      rendererDir,
      svc: serviceManager,
      portScanner,
      logStreamer
    })
    slog('http server started on 9600')
  } catch (e) {
    slog(`http server error: ${(e as Error).message}`)
  }

  // 7. MCP 子进程（容错）
  try {
    startMcpSubprocess()
    slog('mcp subproc spawned')
  } catch (e) {
    slog(`mcp error: ${(e as Error).message}`)
  }

  // 8. 额外 IPC
  ipcMain.handle('app:toggle-autostart', (_e, enable: boolean) => {
    app.setLoginItemSettings({ openAtLogin: enable, openAsHidden: true })
    return app.getLoginItemSettings().openAtLogin
  })
  ipcMain.handle('app:get-autostart', () =>
    app.getLoginItemSettings().openAtLogin
  )
  ipcMain.handle('app:show', () => {
    showMainWindow()
    return true
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createMainWindow()
  })

  // 9. 事件推送：主进程主动把状态变化发给渲染端
  //    preload 早就暴露了 onStateChanged / onServiceLog，但之前没人发，
  //    渲染端只能靠 2 秒一次的全量轮询。这里节流后推送，轮询降到兜底频率。
  bridgeBusToRenderer()

  // 10. 自动升级
  try {
    updater.init()
    slog('updater initialized')
  } catch (e) {
    slog(`updater init error: ${(e as Error).message}`)
  }

  slog('all init done')
})

/**
 * 把主进程事件总线接到渲染端。
 * 状态类事件（服务启停 / 端口变化）合并节流后整体推一次快照；
 * 日志流按条推，不节流（本来就是流式的）。
 */
function bridgeBusToRenderer(): void {
  let pending = false
  const SCHEDULE_MS = 400
  const flush = (): void => {
    const win = mainWindow
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
    try {
      win.webContents.send(
        IpcChannels.EventStateChanged,
        serviceManager.snapshotState()
      )
    } catch (e) {
      slog(`push state error: ${(e as Error).message}`)
    }
  }
  const schedule = (): void => {
    if (pending) return
    pending = true
    setTimeout(() => {
      pending = false
      flush()
    }, SCHEDULE_MS)
  }

  bus.on_event('state:changed', schedule)
  bus.on_event('port:changed', schedule)
  bus.on_event('service:status', schedule)
  bus.on_event('alert', schedule)

  bus.on_event('service:log', (ev) => {
    const win = mainWindow
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
    try {
      win.webContents.send(IpcChannels.EventServiceLog, {
        id: ev.service_id,
        text: ev.text
      })
    } catch {
      // 窗口已关闭时忽略
    }
  })
}

app.on('window-all-closed', () => {
  // 托盘模式下不退出
})

let quitCleaned = false
app.on('before-quit', (e) => {
  if (quitCleaned) return
  // 拦下第一次退出，把托管子进程收干净再真正退出。
  // 之前只 closeDatabase()，子进程完全靠"父进程没了系统顺手收"，
  // Windows 上并不保证，退出后常留下一堆孤儿服务继续占着端口。
  e.preventDefault()
  quitCleaned = true
  isQuitting = true
  void (async () => {
    try {
      await serviceManager?.stopAll()
    } catch (e) {
      slog(`stopAll error: ${(e as Error).message}`)
    }
    try {
      closeDatabase()
    } catch (e) {
      slog(`before-quit error: ${(e as Error).message}`)
    }
    app.quit()
  })()
})
