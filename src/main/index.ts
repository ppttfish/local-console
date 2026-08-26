/**
 * 主进程入口 —— GUI 模式（带文件日志）
 *  - 单实例锁
 *  - 托盘菜单（关窗最小化到托盘）
 *  - 9600 HTTP server（GUI 共享数据）
 *  - 开机自启
 */
import {
  app,
  BrowserWindow,
  shell,
  Tray,
  Menu,
  ipcMain,
  nativeImage
} from 'electron'
import { join } from 'node:path'
import { appendFileSync, mkdirSync, existsSync } from 'node:fs'

// 单实例锁（必须在 app 初始化前调）
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
  process.exit(0)
}
app.on('second-instance', () => {
  // 第二实例：聚焦已有窗口（变量在下方声明）
  showMainWindow()
})

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
import { ServiceManager } from './services/service-manager.js'
import { PortScanner } from './services/port-scanner.js'
import { LogStreamer } from './services/log-streamer.js'
import { EventBus } from './services/event-bus.js'
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
  const icon = existsSync(iconPath)
    ? nativeImage.createFromPath(iconPath)
    : undefined

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    title: '本地总台',
    backgroundColor: '#0f172a',
    show: false,
    autoHideMenuBar: true,
    icon: icon && !icon.isEmpty() ? icon : undefined,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
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
    shell.openExternal(url)
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
    const outsideRenderer = join(process.resourcesPath, 'renderer', 'index.html')
    const insideAsr = join(__dirname, '../renderer/index.html')
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
    tray.setToolTip('本地总台')
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
    ;(serviceManager as unknown) = new ServiceManager(bus, {
      userData,
      logsDir
    })
    ;(portScanner as unknown) = new PortScanner(bus)
    ;(logStreamer as unknown) = new LogStreamer(bus, logsDir)
    ;(pluginRegistry as unknown) = new PluginRegistry(bus, app.getVersion())
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
  try {
    const rendererDir = isDev
      ? join(__dirname, '../renderer')
      : join(process.resourcesPath, 'renderer')
    await startHttpServer({ userData, port: 9600, rendererDir })
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

  slog('all init done')
})

app.on('window-all-closed', () => {
  // 托盘模式下不退出
})

app.on('before-quit', async () => {
  isQuitting = true
  try {
    if (serviceManager && typeof serviceManager.stopAll === 'function') {
      await serviceManager.stopAll()
    }
    if (portScanner && typeof portScanner.stop === 'function') {
      await portScanner.stop()
    }
    if (logStreamer && typeof logStreamer.stop === 'function') {
      await logStreamer.stop()
    }
  } catch (e) {
    slog(`before-quit error: ${(e as Error).message}`)
  }
  closeDatabase()
})
