/**
 * 自动升级模块 —— 走 GitHub Releases + electron-updater
 *
 * 关键点：
 *  - dev 模式不打，prod 模式才查
 *  - 默认每小时后台检查一次
 *  - 检查到新版后用独立 BrowserWindow 弹窗
 *  - portable 包走 quitAndInstall() 重启新版本
 *  - publish 失败要降级（不要让 UI 卡住）
 */
import { app, BrowserWindow, ipcMain } from 'electron'
import { autoUpdater, type UpdateInfo } from 'electron-updater'
import { join } from 'node:path'
import { existsSync, writeFileSync, readFileSync } from 'node:fs'

function slog(msg: string): void {
  const logFile = join(app.getPath('userData'), 'startup.log')
  try {
    const line = `[${new Date().toISOString()}] [updater] ${msg}\n`
    if (existsSync(logFile)) writeFileSync(logFile, line, { flag: 'a' })
  } catch {
    // ignore
  }
}

interface LastCheckRecord {
  at: number
  result: 'updated' | 'no-update' | 'error' | 'dev-skip'
  newVersion?: string
  error?: string
}

function lastCheckFile(): string {
  return join(app.getPath('userData'), 'last-update-check.json')
}

function readLastCheck(): LastCheckRecord | null {
  try {
    if (!existsSync(lastCheckFile())) return null
    return JSON.parse(readFileSync(lastCheckFile(), 'utf8'))
  } catch {
    return null
  }
}

function writeLastCheck(rec: LastCheckRecord): void {
  try {
    writeFileSync(lastCheckFile(), JSON.stringify(rec))
  } catch {
    // ignore
  }
}

/** HTML 实体转义 —— release notes 来自 GitHub，需防注入 */
function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string)
  )
}

class Updater {
  private promptWindow: BrowserWindow | null = null
  private downloading = false
  private downloaded = false
  private pendingInfo: UpdateInfo | null = null

  /** 初始化 + 设事件钩子（必须在 app ready 后调） */
  init(): void {
    if (!app.isReady()) {
      app.whenReady().then(() => this.init())
      return
    }

    if (!app.isPackaged) {
      slog('init skipped: dev mode')
      return
    }

    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.logger = {
      info: (m: unknown) => slog(`info: ${String(m)}`),
      warn: (m: unknown) => slog(`warn: ${String(m)}`),
      error: (m: unknown) => slog(`error: ${String(m)}`),
      debug: (_m: unknown) => {}
    } as unknown as Console

    autoUpdater.on('update-available', (info) => {
      slog(`update-available: ${info.version}`)
      this.pendingInfo = info
      this.showPrompt(info)
    })
    autoUpdater.on('update-not-available', () => {
      slog('update-not-available')
      writeLastCheck({ at: Date.now(), result: 'no-update' })
    })
    autoUpdater.on('download-progress', (p) => {
      this.sendToPrompt({ type: 'progress', percent: p.percent })
    })
    autoUpdater.on('update-downloaded', (info) => {
      slog(`update-downloaded: ${info.version}`)
      this.downloaded = true
      this.sendToPrompt({ type: 'downloaded', version: info.version })
    })
    autoUpdater.on('error', (err) => {
      slog(`error: ${err.message}`)
      writeLastCheck({ at: Date.now(), result: 'error', error: err.message })
      this.sendToPrompt({ type: 'error', message: err.message })
    })

    // 后台定时检查
    setTimeout(() => this.checkSilent(), 30_000)
    setInterval(() => this.checkSilent(), 60 * 60_000)

    this.registerIpc()
  }

  private async checkSilent(): Promise<void> {
    if (!app.isPackaged || this.downloading) return
    try {
      await autoUpdater.checkForUpdates()
    } catch (e) {
      slog(`checkSilent error: ${(e as Error).message}`)
    }
  }

  /** 用户主动检查 —— IPC 触发 */
  async checkInteractive(): Promise<{
    status: 'no-update' | 'available' | 'dev-skip' | 'error'
    version?: string
    error?: string
  }> {
    if (!app.isPackaged) {
      writeLastCheck({ at: Date.now(), result: 'dev-skip' })
      return { status: 'dev-skip' }
    }
    try {
      const result = await autoUpdater.checkForUpdates()
      if (!result) return { status: 'error', error: 'no result' }
      if (result.updateInfo && result.updateInfo.version !== app.getVersion()) {
        return { status: 'available', version: result.updateInfo.version }
      }
      return { status: 'no-update' }
    } catch (e) {
      return { status: 'error', error: (e as Error).message }
    }
  }

  private showPrompt(info: UpdateInfo): void {
    if (this.promptWindow && !this.promptWindow.isDestroyed()) {
      this.promptWindow.focus()
      return
    }

    const win = new BrowserWindow({
      width: 460,
      height: 300,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      title: '小福鱼 — 发现新版本',
      autoHideMenuBar: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: join(__dirname, '../preload/index.cjs')
      }
    })

    win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(this.buildPromptHtml(info)))
    win.on('closed', () => {
      this.promptWindow = null
    })
    this.promptWindow = win
  }

  private buildPromptHtml(info: UpdateInfo): string {
    const cur = app.getVersion()
    const rel = info.releaseNotes
      ? typeof info.releaseNotes === 'string'
        ? info.releaseNotes
        : info.releaseNotes.map((n) => n.note).join('\n\n')
      : ''
    const safeRel = escapeHtml(rel)
    return `<!doctype html>
<html><head><meta charset="utf-8"><title>更新</title>
<style>
  body{font-family:-apple-system,Segoe UI,sans-serif;margin:0;padding:20px;background:#1e1e1e;color:#e6e6e6;font-size:14px}
  h2{margin:0 0 8px;font-size:16px}
  .ver{color:#9cdcfe;margin-bottom:16px}
  .ver b{color:#ce9178}
  .notes{background:#252526;border:1px solid #3c3c3c;border-radius:4px;padding:10px;max-height:120px;overflow:auto;font-size:12px;white-space:pre-wrap;color:#cccccc}
  .row{margin-top:18px;display:flex;gap:8px;justify-content:flex-end}
  button{padding:6px 16px;border:none;border-radius:3px;cursor:pointer;font-size:13px}
  .primary{background:#0e7490;color:#fff}
  .primary:hover{background:#0891b2}
  .secondary{background:#3c3c3c;color:#e6e6e6}
  .secondary:hover{background:#4a4a4a}
  .progress{margin-top:14px;height:6px;background:#3c3c3c;border-radius:3px;overflow:hidden}
  .progress-bar{height:100%;background:#0e7490;width:0;transition:width .2s}
  .status{margin-top:8px;font-size:12px;color:#9cdcfe;min-height:18px}
  .err{color:#f48771}
</style></head><body>
<h2>发现新版本</h2>
<div class="ver">当前 <b>${cur}</b> → 新 <b>${info.version}</b></div>
${rel ? `<div class="notes">${safeRel}</div>` : ''}
<div id="progress" style="display:none">
  <div class="progress"><div class="progress-bar" id="bar"></div></div>
  <div class="status" id="status">准备下载...</div>
</div>
<div class="row" id="row">
  <button class="secondary" onclick="skip()">稍后</button>
  <button class="primary" id="okBtn" onclick="download()">立即下载</button>
</div>
<script>
  const { ipcRenderer } = require('electron');
  let downloading = false;
  let downloaded = false;
  ipcRenderer.on('updater:event', (_, ev) => {
    if (ev.type === 'progress') {
      document.getElementById('bar').style.width = ev.percent.toFixed(1) + '%';
      document.getElementById('status').textContent = '下载中 ' + ev.percent.toFixed(1) + '%';
    } else if (ev.type === 'downloaded') {
      downloaded = true;
      document.getElementById('status').textContent = '下载完成，准备安装...';
      document.getElementById('row').innerHTML =
        '<button class="secondary" onclick="skip()">稍后</button>' +
        '<button class="primary" onclick="install()">立即重启并升级</button>';
    } else if (ev.type === 'error') {
      document.getElementById('status').innerHTML = '<span class="err">' + ev.message + '</span>';
    }
  });
  function download() {
    if (downloading) return;
    downloading = true;
    document.getElementById('progress').style.display = 'block';
    document.getElementById('okBtn').disabled = true;
    ipcRenderer.send('updater:user-action', 'download');
  }
  function install() { ipcRenderer.send('updater:user-action', 'install'); }
  function skip() { window.close(); }
</script>
</body></html>`
  }

  private sendToPrompt(ev: unknown): void {
    if (this.promptWindow && !this.promptWindow.isDestroyed()) {
      this.promptWindow.webContents.send('updater:event', ev)
    }
  }

  private registerIpc(): void {
    ipcMain.handle('app:check-update', async () => this.checkInteractive())
    ipcMain.handle('app:get-update-status', () => ({
      currentVersion: app.getVersion(),
      lastCheck: readLastCheck(),
      downloaded: this.downloaded,
      pendingVersion: this.pendingInfo?.version
    }))
    ipcMain.on('updater:user-action', async (_e, action: string) => {
      if (action === 'download' && this.pendingInfo) {
        this.downloading = true
        try {
          await autoUpdater.downloadUpdate()
        } catch (e) {
          slog(`download error: ${(e as Error).message}`)
          this.sendToPrompt({ type: 'error', message: (e as Error).message })
          this.downloading = false
        }
      } else if (action === 'install') {
        this.promptWindow?.close()
        setImmediate(() => {
          autoUpdater.quitAndInstall()
        })
      }
    })
  }
}

export const updater = new Updater()
