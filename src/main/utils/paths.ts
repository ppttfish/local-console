import { app } from 'electron'
import { join } from 'node:path'

export function getDataDir(): string {
  return app.getPath('userData')
}

export function getLogDir(): string {
  return join(getDataDir(), 'logs')
}
