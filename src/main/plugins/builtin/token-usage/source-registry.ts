/**
 * Agent 数据源注册表 —— 数据驱动
 *
 * 增删一个 agent：只改这个文件 + parsers.ts 加一个 parser
 * 不用动 scanner.ts / storage.ts
 */
import { join } from 'node:path'
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import type { Platform } from './storage.js'
import type { LineParser } from './parsers.js'

/** 单个 agent 数据源配置 */
export interface Source {
  /** agent 名（DB agent 字段） */
  agent: Platform
  /** 人类可读的名字 */
  displayName: string
  /** 简短描述 */
  description: string
  /** 类型 */
  type: 'jsonl' | 'sqlite'
  /** 子路径（相对 home），目录存在才算"渠道存在" */
  homeSubpath: string
  /** 路径 glob（相对上面目录），支持 ** 通配多级 */
  pathGlob: string
  /** 文件名匹配（正则），过滤掉非日志文件 */
  filePattern?: RegExp
  /** jsonl 类型：用哪个 parser */
  parser?: 'omp' | 'zcode' | 'codex' | 'claude'
  /** sqlite 类型：SQL + 字段映射 */
  sqlite?: {
    /** 相对 homeSubpath 的 db 文件路径 */
    dbPath: string
    /** 取消息的 SQL */
    query: string
    /** 行 → UsageRow 转换器（异步：可能需要 JSON.parse） */
    extract: (row: SqlRow) => OMPUsageShape | null
  }
}

interface SqlRow {
  id: string
  session_id: string
  time_created: number
  data: string
}

interface OMPUsageShape {
  model: string
  provider: string
  input: number
  output: number
  cache_read: number
  cache_write: number
  cost: number
  at: number
}

/** 全局 agent 列表 —— 增删一个 agent 只改这里 */
export const SOURCES: Source[] = [
  {
    agent: 'omp',
    displayName: 'OMP (OpenChamber)',
    description: 'OpenChamber 客户端',
    type: 'jsonl',
    homeSubpath: '.omp',
    pathGlob: 'agent/sessions/**/*.jsonl',
    filePattern: /\.jsonl$/,
    parser: 'omp'
  },
  {
    agent: 'zcode',
    displayName: 'ZCode',
    description: 'ZCode CLI',
    type: 'jsonl',
    homeSubpath: '.zcode',
    pathGlob: 'cli/rollout/*.jsonl',
    filePattern: /^model-io-sess_/,
    parser: 'zcode'
  },
  {
    agent: 'codex',
    displayName: 'Codex',
    description: 'OpenAI Codex CLI',
    type: 'jsonl',
    homeSubpath: '.codex',
    pathGlob: 'sessions/**/*.jsonl',
    filePattern: /^rollout-/,
    parser: 'codex'
  },
  {
    agent: 'claude',
    displayName: 'Claude Code',
    description: 'Anthropic Claude Code CLI',
    type: 'jsonl',
    homeSubpath: '.claude',
    pathGlob: 'projects/**/*.jsonl',
    filePattern: /\.jsonl$/,
    parser: 'claude'
  },
  {
    agent: 'opencode',
    displayName: 'OpenCode',
    description: 'OpenCode CLI',
    type: 'sqlite',
    homeSubpath: '.local/share/opencode',
    pathGlob: '',
    sqlite: {
      dbPath: 'opencode.db',
      query: `SELECT id, session_id, time_created, data
              FROM message
              WHERE data LIKE '%assistant%' AND data LIKE '%tokens%'`,
      extract: (row) => {
        // 行级解析挪到 scanner 调用 extractRow 之前
        // 这里返回标记，实际在 scanner 里做
        return null
      }
    }
  }
  // 以后加新 agent：复制一份，改 agent/displayName/pathGlob/parser 即可
]

/** 检测一个 source 是否在本机存在（homeSubpath 目录存在） */
export function isSourceAvailable(s: Source): boolean {
  const fullPath = join(homedir(), s.homeSubpath)
  return existsSync(fullPath)
}

/** 列出本机已发现的 agent（homeSubpath 存在） */
export function listDiscoveredSources(): Source[] {
  return SOURCES.filter(isSourceAvailable)
}

/** 列出潜在的未识别 agent —— home 下有 xxx 目录但不在 SOURCES 中 */
export function listUnknownAgents(): { name: string; path: string }[] {
  // 不通用化（避免太复杂），列几个常见候选
  const home = homedir()
  const candidates = [
    '.deepseek-harness',
    '.cursor-harness',
    '.windsurf',
    '.aider',
    '.cody',
    '.continue',
    '.kiro',
    '.trae',
    '.qoder',
    '.roo',
    '.cline',
    '.gemini-cli',
    '.kilocode',
    '.qwen-coder',
    '.doubao-cli',
    '.yuanbao',
    '.glm-cli',
    '.minimax-cli'
  ]
  const out: { name: string; path: string }[] = []
  for (const c of candidates) {
    const p = join(home, c)
    try {
      if (existsSync(p) && statSync(p).isDirectory()) {
        out.push({ name: c, path: p })
      }
    } catch {
      // ignore
    }
  }
  return out
}
