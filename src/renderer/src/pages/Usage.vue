<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import AddSubscriptionDialog from '../components/AddSubscriptionDialog.vue'
import type {
  QuotaSnapshot,
  QuotaWindow,
  Sub,
  ConfigField,
  ProviderMeta
} from '../types/subscription'
import { Line, Doughnut, Bar } from 'vue-chartjs'
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  ArcElement,
  Tooltip,
  Legend,
  Filler
} from 'chart.js'
import type { ChartData, ChartOptions } from 'chart.js'

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  ArcElement,
  Tooltip,
  Legend,
  Filler
)

interface Summary {
  total_tokens: number
  input_tokens: number
  output_tokens: number
  cached_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  cache_hit_ratio: number
  cost_usd: number
  calls: number
  by_agent: Array<{ agent: string; tokens: number; calls: number; cost: number }>
  by_model: Array<{
    model: string
    tokens: number
    calls: number
    cost: number
    cache_read: number
    cache_write: number
  }>
  by_day: Array<{ day: string; tokens: number; calls: number; cost: number }>
}
interface TimelinePoint {
  bucket: string
  tokens: number
  input: number
  output: number
  cache_read: number
  cache_write: number
  cost: number
  calls: number
}
interface Session {
  session_id: string
  agent: string
  first_at: number
  last_at: number
  calls: number
  tokens: number
  cost: number
  model: string | null
}
interface Status {
  files_scanned: number
  rows_inserted: number
  last_scan_at: number
  by_agent: Record<string, number>
  opencode_messages: number
  dsh_sessions: number
  /** opencode.db 的实际写入者：OpenChamber 与原生 OpenCode 共用数据目录，按本机安装特征判断 */
  opencode_flavor: 'openchamber' | 'opencode'
}

const AGENT_LABEL_STATIC: Record<string, string> = {
  omp: 'OMP',
  zcode: 'ZCode',
  codex: 'Codex',
  claude: 'Claude',
  dsh: 'DSH (DeepSeek)',
  unknown: '未知'
}
/** opencode 口径显示名随本机探测结果切换（OpenChamber 复用 opencode 数据目录） */
const agentLabels = computed<Record<string, string>>(() => ({
  ...AGENT_LABEL_STATIC,
  opencode:
    status.value?.opencode_flavor === 'openchamber' ? 'OpenChamber' : 'OpenCode'
}))
const opencodeLabel = computed(
  () => agentLabels.value['opencode'] ?? 'OpenCode'
)
const AGENT_COLOR: Record<string, string> = {
  omp: '#0ea5e9',
  zcode: '#10b981',
  opencode: '#f59e0b',
  codex: '#8b5cf6',
  claude: '#ef4444',
  dsh: '#14b8a6',
  unknown: '#94a3b8'
}

// 美元 → 人民币固定汇率（可改成动态拉；v3 简单点）
const CNY_RATE = 7.16

type PresetRange = 'today' | '24h' | '7d' | '30d' | 'all'
type Granularity = 'hour' | 'day' | 'month'

const agent = ref<'all' | 'omp' | 'zcode' | 'opencode' | 'codex' | 'claude' | 'dsh'>(
  'all'
)
const model = ref<string>('')
const models = ref<string[]>([])
const granularity = ref<Granularity>('hour')
const presetRange = ref<PresetRange>('today')

const summary = ref<Summary | null>(null)
const timeline = ref<TimelinePoint[]>([])
const sessions = ref<Session[]>([])
const status = ref<Status | null>(null)
const loading = ref(false)
let pollTimer: ReturnType<typeof setInterval> | null = null

function providerMetaOf(id: string): ProviderMeta | undefined {
  return providerMetas.value.find((p) => p.id === id)
}
function subStatus(s: Sub): 'active' | 'stale' | 'error' {
  if (s.lastError) return 'error'
  if (!s.lastRefreshAt) return 'stale'
  return Date.now() - s.lastRefreshAt <= 10 * 60 * 1000 ? 'active' : 'stale'
}

/** 状态文案明确指向"数据同步"，与配额余量区分开 */
const SUB_STATUS_TEXT: Record<'active' | 'stale' | 'error', string> = {
  active: '同步正常',
  stale: '未更新',
  error: '获取失败'
}
function subStatusText(s: Sub): string {
  return SUB_STATUS_TEXT[subStatus(s)]
}

function quotaTone(pct: number | null | undefined): 'ok' | 'warn' | 'danger' {
  const p = pct ?? 0
  if (p >= 90) return 'danger'
  if (p >= 70) return 'warn'
  return 'ok'
}

/**
 * 主展示窗口：用量最高的非空窗口。
 * 大百分比与重置倒计时都以它为口径；明细列表里用「最高」标签标出，
 * 避免用户看不出右上角百分比指的是哪个窗口。
 */
function primaryWindow(s: Sub): QuotaWindow | null {
  let best: QuotaWindow | null = null
  for (const w of s.lastSnapshot?.windows ?? []) {
    if (typeof w.usedPct !== 'number') continue
    if (!best || (w.usedPct as number) > (best.usedPct as number)) best = w
  }
  return best
}

/** 卡片主百分比：多窗取主窗口；无窗口（generic 等）退回整体 usedPct */
function primaryPct(s: Sub): number | null {
  const snap = s.lastSnapshot
  if (!snap) return null
  const pw = primaryWindow(s)
  if (pw) return pw.usedPct
  return typeof snap.usedPct === 'number' ? snap.usedPct : null
}

/** 主百分比对应的重置时间：主窗口 → 整体 windowEnd → 任一有值的窗口 */
function primaryResetAt(s: Sub): number | null {
  const snap = s.lastSnapshot
  if (!snap) return null
  const pw = primaryWindow(s)
  if (pw?.resetAt) return pw.resetAt
  if (snap.windowEnd) return snap.windowEnd
  const anyWithReset = (snap.windows ?? []).find((w) => w.resetAt)
  return anyWithReset?.resetAt ?? null
}

const tab = ref<'usage' | 'subscriptions'>('usage')
const subs = ref<Sub[]>([])
const providerMetas = ref<ProviderMeta[]>([])
const dialogOpen = ref(false)
const editingSub = ref<Sub | null>(null)
const refreshingIds = ref<Set<number>>(new Set())
const confirmDelete = ref<Sub | null>(null)

/** 配额区块是否有可展示的数据（多窗、单窗或整体百分比均可） */
function hasQuotaData(s: Sub): boolean {
  const snap = s.lastSnapshot
  if (!snap) return false
  return (snap.windows?.length ?? 0) > 0 || typeof snap.usedPct === 'number'
}

/** 主区块标题：说明大百分比的口径，避免"不知道 97% 指什么" */
function primaryTitle(s: Sub): string {
  const wins = s.lastSnapshot?.windows ?? []
  if (wins.length === 0) return '总体额度'
  if (wins.length === 1) return `${wins[0].label} 窗口`
  const pw = primaryWindow(s)
  return pw ? `${pw.label} 窗口 · 用量最高` : '各窗口用量'
}

function pctText(p: number | null): string {
  return p === null ? '—' : p.toFixed(1) + '%'
}

/** 进度条宽度；小占比给最小可见宽度，避免只剩一个看不见的点 */
function barWidth(pct: number | null | undefined, minPx = 0): string {
  if (typeof pct !== 'number' || pct <= 0) return '0%'
  return Math.min(100, Math.max(minPx, pct)) + '%'
}

/** 主区块副行左侧：优先"已用/总量"，其次套餐名（多窗模型） */
function quotaSublineLeft(s: Sub): string | null {
  const snap = s.lastSnapshot
  if (!snap) return null
  if (typeof snap.used === 'number') {
    const lim = typeof snap.limit === 'number' ? snap.limit : null
    return lim
      ? `已用 ${fmtToken(snap.used)} / ${fmtToken(lim)}`
      : `已用 ${fmtToken(snap.used)}`
  }
  if (snap.planLabel) return `套餐 ${snap.planLabel}`
  return null
}

/** 紧凑时长：2小时28分 / 45分钟 / 3天8小时 */
function fmtDur(ms: number): string {
  const totalMin = Math.floor(Math.abs(ms) / 60000)
  const d = Math.floor(totalMin / 1440)
  const h = Math.floor((totalMin % 1440) / 60)
  const m = totalMin % 60
  if (d > 0) return h > 0 ? `${d}天${h}小时` : `${d}天`
  if (h > 0) return m > 0 ? `${h}小时${m}分` : `${h}小时`
  return `${Math.max(1, m)}分钟`
}

/** 重置倒计时：统一带"后重置"，已过期显示"即将重置"（等下次刷新纠正） */
function fmtResetIn(ts: number | null | undefined): string {
  if (!ts) return ''
  const diff = ts - Date.now()
  if (!Number.isFinite(diff)) return ''
  if (diff <= 0) return '即将重置'
  return `${fmtDur(diff)}后重置`
}

async function refreshSubs() {
  try {
    const [list, metas] = await Promise.all([
      window.lcp.subList(),
      window.lcp.subProviders()
    ])
    subs.value = list as Sub[]
    providerMetas.value = metas as ProviderMeta[]
  } catch {
    // 静默：主进程未启动订阅模块时（旧版本）不阻塞页面
  }
}

function openAddDialog() {
  editingSub.value = null
  dialogOpen.value = true
}

function openEditDialog(s: Sub) {
  editingSub.value = s
  dialogOpen.value = true
}

async function onSubSaved() {
  dialogOpen.value = false
  await refreshSubs()
}

function askDelete(s: Sub) {
  confirmDelete.value = s
}

async function confirmDeleteNow() {
  if (!confirmDelete.value) return
  const id = confirmDelete.value.id
  confirmDelete.value = null
  await window.lcp.subDelete(id)
  await refreshSubs()
}

async function refreshOneSub(s: Sub) {
  if (!s.enabled) return
  refreshingIds.value.add(s.id)
  try {
    await window.lcp.subRefresh(s.id)
    await refreshSubs()
  } finally {
    refreshingIds.value.delete(s.id)
  }
}

const presetLabels: Record<PresetRange, string> = {
  today: '今天',
  '24h': '最近 24 小时',
  '7d': '近 7 天',
  '30d': '近 30 天',
  all: '全部'
}

// "今天" 0 点起；其它按秒数回溯
const from = computed(() => {
  if (presetRange.value === 'all') return undefined
  const now = new Date()
  if (presetRange.value === 'today') {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    return d.getTime()
  }
  const hours =
    presetRange.value === '24h'
      ? 24
      : presetRange.value === '7d'
        ? 7 * 24
        : 30 * 24
  return now.getTime() - hours * 3600 * 1000
})

// 粒度智能默认：今天 → 小时；7d/30d → 日；all → 月
const defaultGranularityFor = (p: PresetRange): Granularity => {
  if (p === 'today') return 'hour'
  if (p === '24h') return 'hour'
  if (p === '7d') return 'day'
  if (p === '30d') return 'day'
  return 'month'
}
watch(presetRange, (v) => {
  granularity.value = defaultGranularityFor(v)
})

const filter = computed(() => ({
  agent: agent.value,
  model: model.value || undefined,
  from: from.value,
  to: undefined
}))

async function refresh() {
  loading.value = true
  try {
    const [s, t, ss, m, st] = await Promise.all([
      window.lcp.usageSummary(filter.value),
      window.lcp.usageTimeline({ filter: filter.value, granularity: granularity.value }),
      window.lcp.usageSessions({ filter: filter.value, limit: 50 }),
      window.lcp.usageModels(),
      window.lcp.usageStatus()
    ])
    summary.value = s as Summary
    timeline.value = (t as { timeline: TimelinePoint[] }).timeline ?? (t as TimelinePoint[])
    sessions.value = ss as Session[]
    models.value = m as string[]
    status.value = st as Status
  } finally {
    loading.value = false
  }
}

async function rescan() {
  loading.value = true
  try {
    await window.lcp.usageRescan()
    await refresh()
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  refresh()
  refreshSubs()
  pollTimer = setInterval(() => {
    void refresh()
    void refreshSubs()
  }, 30_000)
})
onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer)
})

watch(filter, refresh, { deep: true })
watch(granularity, refresh)

// ===== Charts =====

function num(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

const lineChartData = computed<ChartData<'line'>>(() => ({
  labels: timeline.value.map((p) => p.bucket),
  datasets: [
    {
      label: 'Token 用量',
      data: timeline.value.map((p) => p.tokens),
      borderColor: '#0ea5e9',
      backgroundColor: 'rgba(14, 165, 233, 0.15)',
      fill: true,
      tension: 0.3,
      yAxisID: 'y'
    },
    {
      label: '成本 (USD)',
      data: timeline.value.map((p) => p.cost),
      borderColor: '#f59e0b',
      backgroundColor: 'rgba(245, 158, 11, 0.05)',
      borderDash: [4, 4],
      fill: false,
      tension: 0.3,
      yAxisID: 'y1'
    }
  ]
}))

const lineChartOptions: ChartOptions<'line'> = {
  responsive: true,
  maintainAspectRatio: false,
  interaction: { mode: 'index', intersect: false },
  scales: {
    y: {
      type: 'linear',
      position: 'left',
      title: { display: true, text: 'Token' },
      ticks: { callback: (v) => fmtTokenShort(num(v)) }
    },
    y1: {
      type: 'linear',
      position: 'right',
      title: { display: true, text: 'USD' },
      grid: { drawOnChartArea: false },
      ticks: { callback: (v) => '$' + num(v).toFixed(2) }
    }
  },
  plugins: {
    legend: { position: 'top' },
    tooltip: {
      callbacks: {
        label: (ctx) => {
          const y = num(ctx.parsed.y)
          const isUsd = ctx.dataset.yAxisID === 'y1'
          return `${ctx.dataset.label}: ${isUsd ? '$' + y.toFixed(4) : fmtToken(y)}`
        }
      }
    }
  }
}

const agentDoughnut = computed<ChartData<'doughnut'>>(() => {
  const rows = summary.value?.by_agent ?? []
  return {
    labels: rows.map((r) => agentLabels.value[r.agent] ?? r.agent),
    datasets: [
      {
        data: rows.map((r) => r.cost),
        backgroundColor: rows.map((r) => AGENT_COLOR[r.agent] ?? '#94a3b8'),
        borderWidth: 0
      }
    ]
  }
})

// ===== 平台卡片 tab：用量排行（默认）/ 成本占比 =====
const platformTab = ref<'rank' | 'cost'>('rank')
const rankRows = computed(() =>
  [...(summary.value?.by_agent ?? [])].sort((a, b) => b.tokens - a.tokens)
)
const rankMaxTokens = computed(() =>
  Math.max(1, ...rankRows.value.map((r) => r.tokens))
)

const agentDoughnutOptions: ChartOptions<'doughnut'> = {
  responsive: true,
  maintainAspectRatio: false,
  plugins: {
    legend: { position: 'right' },
    tooltip: {
      callbacks: {
        label: (ctx) => {
          const v = num(ctx.parsed)
          const total = (ctx.dataset.data as number[]).reduce(
            (a, b) => a + num(b),
            0
          )
          const pct = total > 0 ? ((v / total) * 100).toFixed(1) : '0'
          return `${ctx.label}: $${v.toFixed(2)} (${pct}%)`
        }
      }
    }
  }
}

const modelBar = computed<ChartData<'bar'>>(() => {
  const top = (summary.value?.by_model ?? []).slice(0, 10)
  return {
    labels: top.map((r) => r.model),
    datasets: [
      { label: 'Token', data: top.map((r) => r.tokens), backgroundColor: '#0ea5e9' },
      { label: '缓存命中', data: top.map((r) => r.cache_read), backgroundColor: '#10b981' }
    ]
  }
})

const modelBarOptions: ChartOptions<'bar'> = {
  responsive: true,
  maintainAspectRatio: false,
  indexAxis: 'y',
  scales: {
    x: {
      stacked: false,
      ticks: { callback: (v) => fmtTokenShort(num(v)) }
    },
    y: { stacked: false }
  },
  plugins: {
    legend: { position: 'top' },
    tooltip: {
      callbacks: {
        label: (ctx) => `${ctx.dataset.label}: ${fmtToken(num(ctx.parsed.x))}`
      }
    }
  }
}

// ===== utils（中国人习惯） =====

/**
 * 千 / 万 / 亿 / 万亿
 * 1058.96M  →  10.59亿
 * 1_500_000  →  150万
 * 999        →  999
 * 0.85       →  0.85
 */
function fmtToken(n: number): string {
  if (n === 0) return '0'
  const abs = Math.abs(n)
  if (abs >= 1_000_000_000_000) return (n / 1_000_000_000_000).toFixed(2) + '万亿'
  if (abs >= 100_000_000) return (n / 100_000_000).toFixed(2) + '亿'
  if (abs >= 10_000) return (n / 10_000).toFixed(2) + '万'
  if (abs >= 1_000) return (n / 1_000).toFixed(1) + '千'
  return String(Math.round(n))
}

/** 短格式用于坐标轴（更紧凑） */
function fmtTokenShort(n: number): string {
  const abs = Math.abs(n)
  if (abs >= 100_000_000) return (n / 100_000_000).toFixed(1) + '亿'
  if (abs >= 10_000) return (n / 10_000).toFixed(0) + '万'
  if (abs >= 1_000) return (n / 1_000).toFixed(0) + 'k'
  return String(Math.round(n))
}

/** 成本：原样 $ + 约人民币 */
function fmtCost(v: number): string {
  if (v === 0) return '$0.00'
  if (v >= 1000) return '$' + (v / 1000).toFixed(2) + 'k'
  if (v >= 1) return '$' + v.toFixed(2)
  return '$' + v.toFixed(4)
}

function fmtCny(v: number): string {
  if (v === 0) return '免费'
  return '约¥' + (v * CNY_RATE).toFixed(2)
}

/** 日期：YYYY-MM-DD HH:mm */
function fmtTime(ts: number): string {
  if (!ts) return '—'
  const d = new Date(ts)
  const pad = (x: number) => String(x).padStart(2, '0')
  return (
    d.getFullYear() +
    '-' +
    pad(d.getMonth() + 1) +
    '-' +
    pad(d.getDate()) +
    ' ' +
    pad(d.getHours()) +
    ':' +
    pad(d.getMinutes())
  )
}

function relativeTime(ts: number): string {
  if (!ts) return '从未'
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 60) return s + ' 秒前'
  if (s < 3600) return Math.floor(s / 60) + ' 分钟前'
  if (s < 86400) return Math.floor(s / 3600) + ' 小时前'
  return Math.floor(s / 86400) + ' 天前'
}

const rangeLabel = computed(() => presetLabels[presetRange.value])
const granularityLabel = computed(() =>
  granularity.value === 'hour' ? '小时' : granularity.value === 'day' ? '日' : '月'
)
</script>

<template>
  <div class="usage">
    <header class="page-header">
      <div>
        <h1>Agent Token 用量</h1>
        <p class="muted" v-if="tab === 'usage'">
          扫描 <b>{{ status?.files_scanned ?? 0 }}</b> 个文件 ·
          {{ opencodeLabel }} 消息 <b>{{ status?.opencode_messages ?? 0 }}</b> 条 ·
          DSH 会话 <b>{{ status?.dsh_sessions ?? 0 }}</b> 个 ·
          上次扫描 {{ status?.last_scan_at ? relativeTime(status.last_scan_at) : '从未' }}
        </p>
        <p class="muted" v-else>
          监控已订阅的 AI 服务商配额 · 每 5 分钟自动刷新
        </p>
      </div>
      <div class="actions">
        <template v-if="tab === 'usage'">
          <button :disabled="loading" @click="refresh">{{ loading ? '刷新中…' : '刷新' }}</button>
          <button class="primary" :disabled="loading" @click="rescan">重新扫描</button>
        </template>
        <template v-else>
          <button @click="refreshSubs">刷新列表</button>
          <button class="primary" @click="openAddDialog">+ 添加 Provider</button>
        </template>
      </div>
    </header>

    <div class="tabs">
      <button :class="{ active: tab === 'usage' }" @click="tab = 'usage'">Token 用量</button>
      <button :class="{ active: tab === 'subscriptions' }" @click="tab = 'subscriptions'">
        订阅监控
        <span v-if="subs.length" class="tab-badge">{{ subs.length }}</span>
      </button>
    </div>

    <template v-if="tab === 'subscriptions'">
      <!-- 订阅监控面板 -->
      <div v-if="subs.length === 0" class="card empty">
        <h3>还没有添加 Provider</h3>
        <p class="muted">
          支持 Anthropic / OpenAI / MiniMax / Kimi / Z.AI 自动拉取，<br>
          或用「通用」类型手动维护任意服务商的配额。
        </p>
        <button class="primary" style="margin-top: 10px" @click="openAddDialog">+ 添加第一个 Provider</button>
      </div>

      <div v-else class="sub-grid">
        <div v-for="s in subs" :key="s.id" class="sub-card">
          <!-- 头部：logo + 名称/状态 + 轻量操作 -->
          <div class="sub-head">
            <span
              class="sub-logo"
              :style="{ background: providerMetaOf(s.provider)?.color || '#64748b' }"
            >{{ providerMetaOf(s.provider)?.short || '?' }}</span>
            <div class="sub-title">
              <div class="sub-name" :title="s.displayName">{{ s.displayName }}</div>
              <div class="sub-subtitle">
                <span
                  class="status-dot"
                  :class="[subStatus(s), { refreshing: refreshingIds.has(s.id) }]"
                />
                <span>{{ refreshingIds.has(s.id) ? '刷新中…' : subStatusText(s) }}</span>
                <template v-if="providerMetaOf(s.provider)">
                  <span>·</span>
                  <span
                    class="provider-label"
                    :title="providerMetaOf(s.provider)?.label"
                  >{{ providerMetaOf(s.provider)?.label }}</span>
                </template>
              </div>
            </div>
            <div class="sub-actions">
              <button
                class="act"
                :disabled="refreshingIds.has(s.id)"
                title="立即刷新"
                @click="refreshOneSub(s)"
              >
                <svg
                  :class="{ spinning: refreshingIds.has(s.id) }"
                  width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"
                ><path d="M21 12a9 9 0 1 1-2.64-6.36"/><polyline points="21 3 21 9 15 9"/></svg>
                <span>{{ refreshingIds.has(s.id) ? '刷新中' : '刷新' }}</span>
              </button>
              <button class="act" title="编辑" @click="openEditDialog(s)">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
                <span>编辑</span>
              </button>
              <button class="act danger" title="删除" @click="askDelete(s)">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                <span>删除</span>
              </button>
            </div>
          </div>

          <template v-if="s.lastSnapshot && hasQuotaData(s)">
            <!-- 主配额：明确口径（哪个窗口）+ 重置时间 -->
            <div class="quota-main">
              <div class="quota-top-row">
                <span class="quota-title">{{ primaryTitle(s) }}</span>
                <span v-if="primaryResetAt(s)" class="quota-reset">{{ fmtResetIn(primaryResetAt(s)) }}</span>
              </div>
              <div class="big-pct" :class="quotaTone(primaryPct(s))">
                {{ pctText(primaryPct(s)) }}
              </div>
              <div class="quota-bar">
                <div
                  class="quota-fill"
                  :class="quotaTone(primaryPct(s))"
                  :style="{ width: barWidth(primaryPct(s)) }"
                />
              </div>
              <div
                v-if="quotaSublineLeft(s) || typeof s.lastSnapshot.remaining === 'number'"
                class="quota-subline"
              >
                <span>{{ quotaSublineLeft(s) ?? '' }}</span>
                <span
                  v-if="typeof s.lastSnapshot.remaining === 'number'"
                  class="quota-remaining"
                >剩余 {{ fmtToken(s.lastSnapshot.remaining) }}</span>
              </div>
            </div>

            <!-- 多窗口明细（单窗已在主区展示，不再重复） -->
            <div v-if="(s.lastSnapshot.windows?.length ?? 0) >= 2" class="win-list">
              <div class="win-caption">各窗口明细</div>
              <div
                v-for="w in s.lastSnapshot.windows"
                :key="w.label"
                class="win-row"
                :class="{ 'is-primary': w === primaryWindow(s) }"
              >
                <span class="win-label">
                  {{ w.label }}
                  <span v-if="w === primaryWindow(s)" class="win-max">最高</span>
                </span>
                <span class="win-bar">
                  <span
                    class="win-fill"
                    :class="quotaTone(w.usedPct)"
                    :style="{ width: barWidth(w.usedPct, 3) }"
                  />
                </span>
                <span class="win-pct" :class="quotaTone(w.usedPct)">
                  {{ w.usedPct === null ? '—' : Math.round(w.usedPct) + '%' }}
                </span>
                <span class="win-reset">{{ fmtResetIn(w.resetAt) }}</span>
              </div>
            </div>
          </template>

          <div v-else class="quota-main">
            <div class="quota-top-row">
              <span class="quota-title">配额状态未知</span>
            </div>
            <div class="big-pct unknown">—</div>
            <div class="quota-bar">
              <div class="quota-fill unknown" />
            </div>
            <div class="quota-subline">暂无数据 · 点击「刷新」按钮立即获取</div>
          </div>

          <div v-if="s.lastError" class="sub-error">{{ s.lastError }}</div>

          <div class="sub-foot">
            <span>上次刷新 {{ s.lastRefreshAt ? relativeTime(s.lastRefreshAt) : '从未' }}</span>
            <span v-if="!s.enabled" class="off">已停用</span>
          </div>
        </div>
      </div>
    </template>

    <template v-else>
      <!-- Token 用量（原有内容） -->
    <div class="filters card">
      <div class="filter">
        <label>平台</label>
        <div class="seg">
          <button :class="{ active: agent === 'all' }" @click="agent = 'all'">全部</button>
          <button :class="{ active: agent === 'omp' }" @click="agent = 'omp'">OMP</button>
          <button :class="{ active: agent === 'zcode' }" @click="agent = 'zcode'">ZCode</button>
          <button :class="{ active: agent === 'opencode' }" @click="agent = 'opencode'">{{ opencodeLabel }}</button>
          <button :class="{ active: agent === 'codex' }" @click="agent = 'codex'">Codex</button>
          <button :class="{ active: agent === 'claude' }" @click="agent = 'claude'">Claude</button>
          <button :class="{ active: agent === 'dsh' }" @click="agent = 'dsh'">DSH</button>
        </div>
      </div>
      <div class="filter">
        <label>时间</label>
        <div class="seg">
          <button :class="{ active: presetRange === 'today' }" @click="presetRange = 'today'">今天</button>
          <button :class="{ active: presetRange === '24h' }" @click="presetRange = '24h'">24h</button>
          <button :class="{ active: presetRange === '7d' }" @click="presetRange = '7d'">7 天</button>
          <button :class="{ active: presetRange === '30d' }" @click="presetRange = '30d'">30 天</button>
          <button :class="{ active: presetRange === 'all' }" @click="presetRange = 'all'">全部</button>
        </div>
      </div>
      <div class="filter">
        <label>粒度</label>
        <div class="seg">
          <button :class="{ active: granularity === 'hour' }" @click="granularity = 'hour'">小时</button>
          <button :class="{ active: granularity === 'day' }" @click="granularity = 'day'">日</button>
          <button :class="{ active: granularity === 'month' }" @click="granularity = 'month'">月</button>
        </div>
      </div>
      <div class="filter">
        <label>模型</label>
        <select v-model="model">
          <option value="">全部模型</option>
          <option v-for="m in models" :key="m" :value="m">{{ m }}</option>
        </select>
      </div>
    </div>

    <div class="kpis" v-if="summary">
      <div class="card kpi">
        <div class="kpi-label">总 Token</div>
        <div class="kpi-val primary">{{ fmtToken(summary.total_tokens) }}</div>
        <div class="kpi-sub">
          入 {{ fmtToken(summary.input_tokens) }} · 出 {{ fmtToken(summary.output_tokens) }} ·
          缓存 {{ fmtToken(summary.cached_tokens) }}
        </div>
      </div>
      <div class="card kpi">
        <div class="kpi-label">总成本</div>
        <div class="kpi-val warn">{{ fmtCost(summary.cost_usd) }}</div>
        <div class="kpi-sub">
          {{ fmtCny(summary.cost_usd) }} · 平均 {{ fmtCost(summary.cost_usd / Math.max(1, summary.calls)) }} / 次
        </div>
      </div>
      <div class="card kpi">
        <div class="kpi-label">调用次数</div>
        <div class="kpi-val">{{ summary.calls.toLocaleString() }}</div>
        <div class="kpi-sub">
          平均 {{ fmtToken(Math.round(summary.total_tokens / Math.max(1, summary.calls))) }} / 次
        </div>
      </div>
      <div class="card kpi">
        <div class="kpi-label">缓存命中</div>
        <div class="kpi-val success">{{ summary.cache_hit_ratio.toFixed(1) }}%</div>
        <div class="kpi-sub">
          读 {{ fmtToken(summary.cache_read_tokens) }} · 写 {{ fmtToken(summary.cache_write_tokens) }}
        </div>
      </div>
    </div>

    <div class="card chart-card" v-if="timeline.length">
      <h3>趋势 · 按{{ granularityLabel }}（{{ rangeLabel }}）</h3>
      <div class="chart-wrap">
        <Line :data="lineChartData" :options="lineChartOptions" />
      </div>
    </div>

    <div class="row-2" v-if="summary">
      <div class="card">
        <div class="card-head">
          <h3>{{ platformTab === 'rank' ? '用量排行 · 按平台' : '成本占比 · 按平台' }}</h3>
          <div class="seg seg-mini">
            <button :class="{ active: platformTab === 'rank' }" @click="platformTab = 'rank'">用量排行</button>
            <button :class="{ active: platformTab === 'cost' }" @click="platformTab = 'cost'">成本占比</button>
          </div>
        </div>
        <div class="chart-wrap small" v-if="platformTab === 'cost'">
          <Doughnut :data="agentDoughnut" :options="agentDoughnutOptions" />
        </div>
        <div class="rank-list" v-else-if="rankRows.length">
          <div class="rank-item" v-for="(r, i) in rankRows" :key="r.agent">
            <span class="rank-no">{{ i + 1 }}</span>
            <span class="dot" :style="{ background: AGENT_COLOR[r.agent] || '#888' }" />
            <span class="rank-name">{{ agentLabels[r.agent] ?? r.agent }}</span>
            <div class="rank-bar">
              <div
                class="rank-bar-fill"
                :style="{
                  width: Math.max(2, (r.tokens / rankMaxTokens) * 100) + '%',
                  background: AGENT_COLOR[r.agent] || '#94a3b8'
                }"
              />
            </div>
            <span class="rank-val">{{ fmtToken(r.tokens) }}</span>
            <span class="rank-cost">{{ fmtCost(r.cost) }}</span>
          </div>
        </div>
        <p v-else class="muted center">暂无数据</p>
      </div>
      <div class="card">
        <h3>Token 分布 · 按模型 TOP 10</h3>
        <div class="chart-wrap">
          <Bar :data="modelBar" :options="modelBarOptions" />
        </div>
      </div>
    </div>

    <div class="row-2" v-if="summary">
      <div class="card">
        <h3>按平台</h3>
        <table class="t">
          <thead>
            <tr>
              <th>平台</th>
              <th class="num">Token</th>
              <th class="num">调用</th>
              <th class="num">成本 (USD)</th>
              <th class="num">折合</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in summary.by_agent" :key="r.agent">
              <td>
                <span class="dot" :style="{ background: AGENT_COLOR[r.agent] || '#888' }" />
                {{ agentLabels[r.agent] ?? r.agent }}
              </td>
              <td class="num">{{ fmtToken(r.tokens) }}</td>
              <td class="num">{{ r.calls.toLocaleString() }}</td>
              <td class="num warn">{{ fmtCost(r.cost) }}</td>
              <td class="num cny">{{ fmtCny(r.cost) }}</td>
            </tr>
            <tr v-if="summary.by_agent.length === 0">
              <td colspan="5" class="muted center">暂无数据</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="card">
        <h3>按模型</h3>
        <table class="t">
          <thead>
            <tr>
              <th>模型</th>
              <th class="num">Token</th>
              <th class="num">调用</th>
              <th class="num">成本 (USD)</th>
              <th class="num">折合</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in summary.by_model" :key="r.model">
              <td><code>{{ r.model }}</code></td>
              <td class="num">{{ fmtToken(r.tokens) }}</td>
              <td class="num">{{ r.calls.toLocaleString() }}</td>
              <td class="num warn">{{ fmtCost(r.cost) }}</td>
              <td class="num cny">{{ fmtCny(r.cost) }}</td>
            </tr>
            <tr v-if="summary.by_model.length === 0">
              <td colspan="5" class="muted center">暂无数据</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="card" v-if="sessions.length">
      <h3>Top 会话 · 按成本排序 · {{ sessions.length }} 条</h3>
      <table class="t">
        <thead>
          <tr>
            <th>会话</th>
            <th>平台</th>
            <th>模型</th>
            <th class="num">调用</th>
            <th class="num">Token</th>
            <th class="num">成本 (USD)</th>
            <th class="num">折合</th>
            <th>最后活跃</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="s in sessions" :key="s.session_id">
            <td><code>{{ s.session_id.slice(0, 22) }}</code></td>
            <td>
              <span class="dot" :style="{ background: AGENT_COLOR[s.agent] || '#888' }" />
              {{ agentLabels[s.agent] ?? s.agent }}
            </td>
            <td><code>{{ s.model || '—' }}</code></td>
            <td class="num">{{ s.calls.toLocaleString() }}</td>
            <td class="num">{{ fmtToken(s.tokens) }}</td>
            <td class="num warn">{{ fmtCost(s.cost) }}</td>
            <td class="num cny">{{ fmtCny(s.cost) }}</td>
            <td class="muted">{{ fmtTime(s.last_at) }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="!summary || (summary.calls === 0 && !loading)" class="card empty">
      <h3>暂无数据</h3>
      <p class="muted">
        本工具会扫描以下目录的会话日志：<br>
        · <code>~/.omp/agent/sessions/</code> (OMP)<br>
        · <code>~/.zcode/cli/rollout/</code><br>
        · <code>~/.codex/sessions/</code><br>
        · <code>~/.claude/projects/</code><br>
        · <code>~/.local/share/opencode/opencode.db</code> (OpenCode / OpenChamber)<br>
        · <code>~/.dsh/sessions/</code> (DSH)
      </p>
    </div>
    </template>

    <AddSubscriptionDialog
      v-if="dialogOpen"
      :editing="editingSub"
      @close="dialogOpen = false"
      @saved="onSubSaved"
    />

    <!-- 删除确认 -->
    <div v-if="confirmDelete" class="confirm-overlay" @click.self="confirmDelete = null">
      <div class="confirm-dialog">
        <h3>删除订阅？</h3>
        <p class="muted" style="margin: 0 0 6px">
          {{ confirmDelete.displayName }}
        </p>
        <p class="muted" style="margin: 0; font-size: 12px">
          删除后不会影响你在 Provider 的登录态，仅清除本机监控记录。
        </p>
        <div class="confirm-row">
          <button @click="confirmDelete = null">取消</button>
          <button class="danger" @click="confirmDeleteNow">确认删除</button>
        </div>
      </div>
    </div>
  </div>
</template>


<style scoped>
.usage {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.page-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
}
.page-header h1 {
  margin: 0;
  font-size: 22px;
}
.page-header p {
  margin: 4px 0 0;
  font-size: 12px;
}
.actions {
  display: flex;
  gap: 8px;
}
.filters {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
  align-items: flex-end;
  padding: 14px 16px;
}
.filter {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.filter label {
  font-size: 11px;
  color: var(--muted);
  text-transform: uppercase;
}
.seg {
  display: inline-flex;
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow: hidden;
}
.seg button {
  border: none;
  border-radius: 0;
  background: transparent;
  padding: 5px 10px;
  font-size: 12px;
}
.seg button:hover {
  background: var(--hover);
}
.seg button.active {
  background: var(--accent);
  color: white;
}
.kpis {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
}
.kpi-label {
  font-size: 12px;
  color: var(--muted);
}
.kpi-val {
  font-size: 28px;
  font-weight: 600;
  margin: 4px 0;
  font-variant-numeric: tabular-nums;
}
.kpi-val.primary {
  color: var(--accent);
}
.kpi-val.warn {
  color: #f59e0b;
}
.kpi-val.success {
  color: var(--success);
}
.kpi-sub {
  font-size: 11px;
  color: var(--muted);
}
.chart-card {
  padding: 14px 16px;
}
.chart-card h3,
.row-2 h3,
.card h3 {
  margin: 0 0 8px;
  font-size: 13px;
}
.chart-wrap {
  height: 280px;
  position: relative;
}
.chart-wrap.small {
  height: 240px;
}
.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 8px;
}
.card-head h3 {
  margin: 0;
}
.seg-mini button {
  padding: 3px 8px;
  font-size: 11px;
}
.rank-list {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 10px;
  height: 240px;
}
.rank-item {
  display: grid;
  grid-template-columns: 18px 10px minmax(72px, auto) 1fr auto auto;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}
.rank-no {
  color: var(--muted);
  font-variant-numeric: tabular-nums;
  text-align: right;
}
.rank-name {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.rank-bar {
  height: 8px;
  border-radius: 4px;
  background: var(--hover);
  overflow: hidden;
}
.rank-bar-fill {
  height: 100%;
  border-radius: 4px;
}
.rank-val {
  font-variant-numeric: tabular-nums;
  min-width: 44px;
  text-align: right;
}
.rank-cost {
  color: var(--muted);
  font-variant-numeric: tabular-nums;
  min-width: 52px;
  text-align: right;
}
.row-2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.t {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
.t th,
.t td {
  padding: 5px 8px;
  text-align: left;
  border-bottom: 1px solid var(--border);
}
.t th {
  color: var(--muted);
  font-weight: 500;
  font-size: 11px;
  text-transform: uppercase;
}
.t td.num,
.t th.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.num {
  font-family: 'Geist Mono', 'PingFang SC', Consolas, monospace;
  font-size: 11.5px;
}
.warn {
  color: #f59e0b;
}
.success {
  color: var(--success);
}
.center {
  text-align: center;
}
.dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-right: 6px;
  vertical-align: middle;
}
code {
  font-family: 'Geist Mono', Consolas, monospace;
  font-size: 11px;
  background: var(--bg-soft);
  padding: 1px 5px;
  border-radius: 3px;
}
.cny {
  color: #94a3b8;
  font-size: 10.5px;
}
.empty {
  text-align: center;
  padding: 30px;
}
.empty code {
  background: var(--bg-soft);
  padding: 1px 6px;
  border-radius: 3px;
  font-size: 11.5px;
}
/* ===== 订阅监控 ===== */
.tabs {
  display: inline-flex;
  gap: 4px;
  padding: 3px;
  background: var(--bg-soft);
  border: 1px solid var(--border);
  border-radius: 8px;
  align-self: flex-start;
}
.tabs button {
  padding: 6px 14px;
  border: none;
  background: transparent;
  color: var(--muted);
  font-size: 12.5px;
  font-weight: 500;
  border-radius: 6px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
}
.tabs button.active {
  background: var(--card);
  color: var(--text);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06);
}
.tab-badge {
  display: inline-block;
  min-width: 18px;
  padding: 0 5px;
  height: 16px;
  line-height: 16px;
  background: var(--accent);
  color: #fff;
  border-radius: 8px;
  font-size: 10px;
  text-align: center;
}
/* ===== 订阅卡片 ===== */
.sub-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
  gap: 14px;
}
.sub-card {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 16px;
  box-shadow: var(--shadow);
  transition:
    transform 0.15s,
    box-shadow 0.15s;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.sub-card:hover {
  transform: translateY(-1px);
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.08);
}

/* —— 头部 —— */
.sub-head {
  display: flex;
  align-items: center;
  gap: 10px;
}
.sub-logo {
  width: 32px;
  height: 32px;
  border-radius: 9px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  font-weight: 700;
  color: #fff;
  flex-shrink: 0;
}
.sub-title {
  flex: 1 1 auto;
  min-width: 0;
}
.sub-name {
  font-size: 13.5px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sub-subtitle {
  display: flex;
  align-items: center;
  gap: 5px;
  margin-top: 2px;
  font-size: 11px;
  color: var(--muted);
  min-width: 0;
}
/* 状态短语不折行；宽度不够时只让 Provider 名截断 */
.sub-subtitle > span {
  white-space: nowrap;
}
.sub-subtitle .provider-label {
  flex-shrink: 1;
  min-width: 0;
  overflow: hidden;
}
.status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}
.status-dot.active {
  background: var(--success);
}
.status-dot.stale {
  background: var(--warn);
}
.status-dot.error {
  background: var(--danger);
}
.status-dot.refreshing {
  animation: dot-pulse 1s ease-in-out infinite;
}
@keyframes dot-pulse {
  50% {
    opacity: 0.3;
  }
}

/* —— 操作按钮：统一幽灵风格，删除仅在悬停时变红 —— */
.sub-actions {
  display: flex;
  flex: 0 0 auto;
  gap: 2px;
}
.sub-actions .act {
  background: transparent;
  border-color: transparent;
  color: var(--muted);
  height: 26px;
  padding: 0 8px;
  border-radius: 6px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11.5px;
  font-weight: 500;
  white-space: nowrap;
}
.sub-actions .act:hover:not(:disabled) {
  background: var(--hover);
  border-color: transparent;
  color: var(--text);
}
.sub-actions .act.danger:hover:not(:disabled) {
  background: rgba(239, 68, 68, 0.1);
  color: var(--danger);
}
.sub-actions .act:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.sub-actions .act svg {
  width: 12px;
  height: 12px;
}
.sub-actions .act svg.spinning {
  animation: act-spin 0.9s linear infinite;
}
@keyframes act-spin {
  to {
    transform: rotate(360deg);
  }
}

/* —— 主配额区 —— */
.quota-top-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}
.quota-title {
  font-size: 11px;
  color: var(--muted);
  letter-spacing: 0.02em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.quota-reset {
  font-size: 11px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.big-pct {
  font-size: 30px;
  font-weight: 700;
  line-height: 1.2;
  margin: 2px 0 8px;
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.5px;
}
.big-pct.ok {
  color: var(--success);
}
.big-pct.warn {
  color: var(--warn);
}
.big-pct.danger {
  color: var(--danger);
}
.big-pct.unknown {
  color: var(--muted);
  opacity: 0.5;
}
.quota-bar {
  height: 9px;
  background: var(--panel);
  border-radius: 999px;
  box-shadow: inset 0 0 0 1px var(--border);
  overflow: hidden;
}
.quota-fill {
  height: 100%;
  border-radius: 999px;
  transition: width 0.3s;
}
.quota-fill.ok {
  background: linear-gradient(90deg, var(--success), #34d399);
}
.quota-fill.warn {
  background: linear-gradient(90deg, var(--warn), #fbbf24);
}
.quota-fill.danger {
  background: linear-gradient(90deg, var(--danger), #f87171);
}
.quota-fill.unknown {
  width: 100%;
  background: repeating-linear-gradient(
    45deg,
    var(--border),
    var(--border) 6px,
    transparent 6px,
    transparent 12px
  );
}
.quota-subline {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  margin-top: 7px;
  font-size: 11.5px;
  color: var(--muted);
}
.quota-remaining {
  color: var(--success);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

/* —— 多窗口明细：轨道必须可见，主窗口行有「最高」标记 —— */
.win-list {
  border-top: 1px dashed var(--border);
  padding-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.win-caption {
  font-size: 10.5px;
  color: var(--muted);
  letter-spacing: 0.06em;
}
.win-row {
  display: grid;
  grid-template-columns: minmax(64px, auto) 1fr 44px auto;
  align-items: center;
  gap: 10px;
  font-size: 11.5px;
}
.win-label {
  color: var(--muted);
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}
.win-row.is-primary .win-label {
  color: var(--text);
  font-weight: 600;
}
.win-max {
  font-size: 9.5px;
  line-height: 1;
  padding: 2px 5px;
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent);
  flex-shrink: 0;
}
.win-bar {
  display: block;
  height: 6px;
  background: var(--panel);
  border-radius: 999px;
  box-shadow: inset 0 0 0 1px var(--border);
  overflow: hidden;
}
.win-fill {
  display: block;
  height: 100%;
  border-radius: 999px;
  transition: width 0.3s;
}
.win-fill.ok {
  background: var(--success);
}
.win-fill.warn {
  background: var(--warn);
}
.win-fill.danger {
  background: var(--danger);
}
.win-pct {
  text-align: right;
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  color: var(--muted);
}
.win-pct.ok {
  color: var(--success);
}
.win-pct.warn {
  color: var(--warn);
}
.win-pct.danger {
  color: var(--danger);
}
.win-reset {
  font-size: 10.5px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

/* —— 底部信息：贴底对齐，多卡片高度不一时仍整齐 —— */
.sub-foot {
  margin-top: auto;
  border-top: 1px dashed var(--border);
  padding-top: 10px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 11px;
  color: var(--muted);
}
.sub-foot .off {
  color: var(--warn);
  flex-shrink: 0;
}
.confirm-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 110;
}
.confirm-dialog {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 18px 20px;
  min-width: 360px;
  max-width: 460px;
  box-shadow: 0 20px 50px rgba(0, 0, 0, 0.25);
}
.confirm-dialog h3 {
  margin: 0 0 8px;
  font-size: 15px;
}
.confirm-row {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 16px;
}
button.danger {
  background: var(--danger);
  color: #fff;
  border: 1px solid var(--danger);
}
button.danger:hover:not(:disabled) {
  filter: brightness(1.08);
  background: var(--danger);
}
.sub-error {
  padding: 7px 9px;
  background: rgba(239, 68, 68, 0.08);
  color: var(--danger);
  font-size: 11.5px;
  border-radius: 6px;
}
</style>
