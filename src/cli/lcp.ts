#!/usr/bin/env node
/**
 * lcp —— 本地总台的命令行客户端。
 * 让 agent 不走 MCP 也能直接调。
 */
import { join } from 'node:path'
import { existsSync, mkdirSync } from 'node:fs'
import { ServiceManager } from '../main/services/service-manager.js'
import { PortScanner } from '../main/services/port-scanner.js'
import { LogStreamer } from '../main/services/log-streamer.js'
import { EventBus } from '../main/services/event-bus.js'
import { initDatabase, closeDatabase, getService as dbGetService } from '../main/services/db.js'

const userData = resolveUserData()
if (!existsSync(userData)) mkdirSync(userData, { recursive: true })
const logsDir = join(userData, 'logs')
if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true })

function resolveUserData(): string {
  const base =
    process.env['LOCAL_CONSOLE_DATA_DIR'] ||
    process.env['LOCALAPPDATA'] ||
    process.env['APPDATA'] ||
    process.cwd()
  return join(base, 'local-console')
}

const [, , cmd, ...rest] = process.argv
if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
  printHelp()
  process.exit(0)
}

const bus = new EventBus()
initDatabase(userData)
const svc = new ServiceManager(bus, { userData, logsDir })
const port = new PortScanner(bus)
svc.setPortProvider(() => port.snapshot())
const log = new LogStreamer(bus, logsDir)
await svc.start()
await port.start()

try {
  await runCommand(cmd!, rest)
} catch (e) {
  console.error('错误：', e instanceof Error ? e.message : e)
  process.exit(1)
} finally {
  await port.stop()
  await svc.shutdown()
  closeDatabase()
}

async function runCommand(c: string, args: string[]): Promise<void> {
  switch (c) {
    case 'list':
    case 'ls': {
      const list = svc.list()
      if (list.length === 0) {
        console.log('（暂无服务）')
        return
      }
      console.log(
        ['ID', '状态', 'PID', '端口', '名称', '命令']
          .map((s) => s.padEnd(14))
          .join('')
      )
      console.log('-'.repeat(80))
      for (const s of list) {
        console.log(
          [
            s.id.padEnd(14),
            s.status.padEnd(14),
            String(s.pid ?? '-').padEnd(14),
            String(s.port ?? '-').padEnd(14),
            s.name.padEnd(14),
            s.command
          ].join('')
        )
      }
      return
    }
    case 'start':
    case 'stop':
    case 'restart': {
      const target = resolve(args[0])
      if (!target) die(`未找到服务：${args[0]}`)
      const r =
        c === 'start'
          ? await svc.startService(target.id, 'cli')
          : c === 'stop'
            ? await svc.stop(target.id, 'cli')
            : await svc.restart(target.id, 'cli')
      console.log(JSON.stringify(r, null, 2))
      return
    }
    case 'logs': {
      const target = resolve(args[0])
      if (!target) die(`未找到服务：${args[0]}`)
      const tailIdx = args.indexOf('--tail')
      const tail = tailIdx >= 0 ? parseInt(args[tailIdx + 1] ?? '200', 10) : 200
      const r = log.tail(target.id, tail)
      process.stdout.write(r.text)
      return
    }
    case 'ports': {
      await new Promise((r) => setTimeout(r, 300))
      const snap = port.snapshot()
      console.log(
        ['PORT', 'PID', 'NAME', 'APP'].map((s) => s.padEnd(14)).join('')
      )
      console.log('-'.repeat(60))
      for (const p of snap) {
        console.log(
          [
            String(p.port).padEnd(14),
            String(p.pid).padEnd(14),
            (p.process_name || '').padEnd(14),
            (p.app_name || '-').padEnd(14)
          ].join('')
        )
      }
      return
    }
    case 'add': {
      const [name, cwd, command] = args
      if (!name || !cwd || !command) die('用法：lcp add <name> <cwd> <command>')
      const portIdx = args.indexOf('--port')
      const p = portIdx >= 0 ? parseInt(args[portIdx + 1]!, 10) : null
      const kindIdx = args.indexOf('--kind')
      const kind =
        (args[kindIdx + 1] as 'service' | 'task' | undefined) ?? 'service'
      const s = svc.create({ name, cwd, command, port: p, kind })
      console.log('已添加：', JSON.stringify(s, null, 2))
      return
    }
    case 'delete':
    case 'rm': {
      const target = resolve(args[0])
      if (!target) die(`未找到服务：${args[0]}`)
      svc.delete(target.id)
      console.log(`已删除 ${target.name}`)
      return
    }
    default:
      printHelp()
  }
}

function resolve(key: string | undefined): { id: string; name: string } | null {
  if (!key) return null
  if (dbGetService(key)) return { id: key, name: dbGetService(key)!.name }
  const all = svc.list()
  const found = all.find((s) => s.name === key)
  return found ? { id: found.id, name: found.name } : null
}

function die(msg: string): never {
  console.error(msg)
  process.exit(1)
}

function printHelp(): void {
  console.log(`lcp —— 本地总台命令行客户端

用法：
  lcp list                          列出所有服务
  lcp start <id|name>               启动服务
  lcp stop <id|name>                停止服务
  lcp restart <id|name>             重启服务
  lcp logs <id|name> [--tail N]     查看最近 N 行日志
  lcp ports                         扫描本机监听端口
  lcp add <name> <cwd> <command>    添加服务
       [--port N] [--kind service|task]
  lcp delete <id|name>              删除服务
  lcp help                          显示此帮助
`)
}
