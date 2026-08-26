<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import AddSubscriptionDialog from '../components/AddSubscriptionDialog.vue'
import type {
  QuotaSnapshot,
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
}

const AGENT_LABEL: Record<string, string> = {
  omp: 'OMP (OpenChamber)',
  zcode: 'ZCode',
  opencode: 'OpenCode',
  codex: 'Codex',
  claude: 'Claude',
  unknown: '未知'
}
const AGENT_COLOR: Record<string, string> = {
  omp: '#0ea5e9',
  zcode: '#10b981',
  opencode: '#f59e0b',
  codex: '#8b5cf6',
  claude: '#ef4444',
  unknown: '#94a3b8'
}

// 美元 → 人民币固定汇率（可改成动态拉；v3 简单点）
const CNY_RATE = 7.16

type PresetRange = 'today' | '24h' | '7d' | '30d' | 'all'
type Granularity = 'hour' | 'day' | 'month'

const agent = ref<'all' | 'omp' | 'zcode' | 'opencode' | 'codex' | 'claude'>(
  'all'
)
const model = ref<string>('')
const granularity = ref<Granularity>('hour')
const presetRange = ref<PresetRange>('today')

const summary = ref<Summary | null>(null)
const timeline = ref<TimelinePoint[]>([])
const sessions = ref<Session[]>([])
const models = ref<string[]>([])
const status = ref<Status | null>(null)
const loading = ref(false)
let pollTimer: ReturnType<typeof setInterval> | null = null

const tab = ref<'usage' | 'subscriptions'>('usage')
const subs = ref<Sub[]>([])
const providerMetas = ref<ProviderMeta[]>([])
const dialogOpen = ref(false)
const editingSub = ref<Sub | null>(null)
const refreshingIds = ref<Set<number>>(new Set())

function providerMetaOf(id: string): ProviderMeta | undefined {
  return providerMetas.value.find((p) => p.id === id)
}

function subStatus(s: Sub): 'active' | 'stale' | 'error' {
  if (s.lastError) return 'error'
  if (!s.lastRefreshAt) return 'stale'
  return Date.now() - s.lastRefreshAt <= 10 * 60 * 1000 ? 'active' : 'stale'
}

function quotaTone(pct: number): 'ok' | 'warn' | 'danger' {
  if (pct >= 90) return 'danger'
  if (pct >= 70) return 'warn'
  return 'ok'
}

/** 剩余时间 → "2h 15m 后" / "3 天后" */
function fmtCountdown(ts: number): string {
  const diff = ts - Date.now()
  if (!Number.isFinite(diff)) return '—'
  if (diff <= 0) return '已过期'
  const m = Math.floor(diff / 60000)
  if (m < 60) return `${m} 分钟后`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h} 小时 ${m % 60} 分后`
  return `${Math.floor(h / 24)} 天后`
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

async function removeSub(s: Sub) {
  await window.lcp.subDelete(s.id)
  await refreshSubs()
}

async function refreshOneSub(s: Sub) {
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
    labels: rows.map((r) => AGENT_LABEL[r.agent] ?? r.agent),
    datasets: [
      {
        data: rows.map((r) => r.cost),
        backgroundColor: rows.map((r) => AGENT_COLOR[r.agent] ?? '#94a3b8'),
        borderWidth: 0
      }
    ]
  }
})

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
          opencode 消息 <b>{{ status?.opencode_messages ?? 0 }}</b> 条 ·
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
          <div class="sub-head">
            <div class="sub-name">
              <span
                class="sub-logo"
                :style="{ background: providerMetaOf(s.provider)?.color || '#64748b' }"
              >{{ providerMetaOf(s.provider)?.short || '?' }}</span>
              <span>
                {{ s.displayName }}
                <small class="muted">{{ providerMetaOf(s.provider)?.label || s.provider }}</small>
              </span>
            </div>
            <div class="sub-actions">
              <button title="立即刷新" @click="refreshOneSub(s)">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><polyline points="21 3 21 9 15 9"/></svg>
              </button>
              <button title="编辑" @click="openEditDialog(s)">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
              </button>
              <button class="danger" title="删除" @click="removeSub(s)">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
              </button>
            </div>
          </div>

          <div class="sub-status-row">
            <span class="sub-status-tag" :class="subStatus(s)">
              {{ subStatus(s) === 'active' ? '正常' : subStatus(s) === 'stale' ? '未同步' : '异常' }}
            </span>
            <span
              v-if="refreshingIds.has(s.id)"
              class="muted"
              style="font-size: 11px"
            >刷新中…</span>
          </div>

          <template v-if="s.lastSnapshot">
            <div class="sub-numbers">
              <div class="sub-used">
                已用 <strong>{{ fmtToken(s.lastSnapshot.used) }}</strong> / {{ fmtToken(s.lastSnapshot.limit) }}
              </div>
              <div class="big-pct" :class="quotaTone(s.lastSnapshot.usedPct)">
                {{ s.lastSnapshot.usedPct.toFixed(1) }}%
              </div>
            </div>
            <div class="quota-bar">
              <div
                class="quota-fill"
                :class="quotaTone(s.lastSnapshot.usedPct)"
                :style="{ width: Math.min(100, s.lastSnapshot.usedPct) + '%' }"
              />
            </div>
            <div class="sub-meta">
              <span>剩余 {{ fmtToken(s.lastSnapshot.remaining) }}</span>
              <span v-if="s.lastSnapshot.windowEnd">
                下次重置 {{ fmtCountdown(s.lastSnapshot.windowEnd) }}
              </span>
            </div>
          </template>

          <div v-else class="quota-bar" style="margin-top: 8px">
            <div class="quota-fill unknown" />
          </div>

          <div v-if="s.lastError" class="sub-error">{{ s.lastError }}</div>
          <div class="sub-meta" style="margin-top: 8px">
            <span>上次刷新 {{ s.lastRefreshAt ? relativeTime(s.lastRefreshAt) : '从未' }}</span>
            <span v-if="!s.enabled" class="warn">已停用</span>
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
          <button :class="{ active: agent === 'opencode' }" @click="agent = 'opencode'">OpenCode</button>
          <button :class="{ active: agent === 'codex' }" @click="agent = 'codex'">Codex</button>
          <button :class="{ active: agent === 'claude' }" @click="agent = 'claude'">Claude</button>
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
        <h3>成本占比 · 按平台</h3>
        <div class="chart-wrap small">
          <Doughnut :data="agentDoughnut" :options="agentDoughnutOptions" />
        </div>
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
                {{ AGENT_LABEL[r.agent] ?? r.agent }}
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
              {{ AGENT_LABEL[s.agent] ?? s.agent }}
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
        · <code>~/.omp/agent/sessions/</code> (OpenChamber)<br>
        · <code>~/.zcode/cli/rollout/</code><br>
        · <code>~/.codex/sessions/</code><br>
        · <code>~/.claude/projects/</code><br>
        · <code>~/.local/share/opencode/opencode.db</code> (SQLite)
      </p>
    </div>
    </template>

    <AddSubscriptionDialog
      v-if="dialogOpen"
      :editing="editingSub"
      @close="dialogOpen = false"
      @saved="onSubSaved"
    />
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
.sub-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 12px;
}
.sub-card {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 14px 16px;
  position: relative;
  box-shadow: var(--shadow);
  transition:
    transform 0.15s,
    box-shadow 0.15s;
}
.sub-card:hover {
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
}
.sub-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  margin-bottom: 8px;
}
.sub-name {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 600;
}
.sub-name small {
  display: block;
  font-size: 11px;
  font-weight: 400;
}
.sub-logo {
  width: 26px;
  height: 26px;
  border-radius: 7px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  font-weight: 700;
  color: #fff;
  flex-shrink: 0;
}
.sub-actions {
  display: flex;
  gap: 2px;
}
.sub-actions button {
  background: transparent;
  border: none;
  color: var(--muted);
  width: 26px;
  height: 26px;
  border-radius: 5px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}
.sub-actions button:hover {
  background: var(--hover);
  color: var(--text);
}
.sub-actions button.danger:hover {
  color: var(--danger);
}
.sub-status-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.sub-status-tag {
  font-size: 10.5px;
  padding: 2px 7px;
  border-radius: 999px;
  font-weight: 500;
}
.sub-status-tag.active {
  background: rgba(16, 185, 129, 0.12);
  color: var(--success);
}
.sub-status-tag.stale {
  background: rgba(245, 158, 11, 0.12);
  color: var(--warn);
}
.sub-status-tag.error {
  background: rgba(239, 68, 68, 0.12);
  color: var(--danger);
}
.sub-numbers {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin: 6px 0 8px;
}
.sub-used {
  font-size: 12px;
  color: var(--muted);
}
.sub-used strong {
  color: var(--text);
  font-size: 14px;
  font-variant-numeric: tabular-nums;
}
.big-pct {
  font-size: 22px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.5px;
}
.big-pct.ok,
.quota-fill.ok {
  color: var(--success);
}
.big-pct.warn,
.quota-fill.warn {
  color: var(--warn);
}
.big-pct.danger,
.quota-fill.danger {
  color: var(--danger);
}
.quota-bar {
  height: 8px;
  background: var(--bg-soft);
  border-radius: 4px;
  overflow: hidden;
  position: relative;
}
.quota-fill {
  height: 100%;
  border-radius: 4px;
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
    var(--accent-soft),
    var(--accent-soft) 6px,
    transparent 6px,
    transparent 12px
  );
}
.sub-meta {
  display: flex;
  justify-content: space-between;
  margin-top: 10px;
  font-size: 11px;
  color: var(--muted);
}
.sub-error {
  margin-top: 6px;
  padding: 6px 8px;
  background: rgba(239, 68, 68, 0.08);
  color: var(--danger);
  font-size: 11px;
  border-radius: 4px;
  word-break: break-all;
}
</style>
