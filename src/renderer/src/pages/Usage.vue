<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
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
  pollTimer = setInterval(refresh, 30_000)
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
        <p class="muted">
          扫描 <b>{{ status?.files_scanned ?? 0 }}</b> 个文件 ·
          opencode 消息 <b>{{ status?.opencode_messages ?? 0 }}</b> 条 ·
          上次扫描 {{ status?.last_scan_at ? relativeTime(status.last_scan_at) : '从未' }}
        </p>
      </div>
      <div class="actions">
        <button :disabled="loading" @click="refresh">{{ loading ? '刷新中…' : '刷新' }}</button>
        <button class="primary" :disabled="loading" @click="rescan">重新扫描</button>
      </div>
    </header>

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
      <p class="muted">使用任意一个 agent 跑几次对话后，点"重新扫描"即可。</p>
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
</style>
