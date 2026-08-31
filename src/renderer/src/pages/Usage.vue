<script setup lang="ts">
/**
 * Token 用量 + 订阅监控
 *  - 顶部 Tabs：Token 用量 / 订阅监控
 *  - Token 用量：筛选条（平台/时间/粒度/模型）+ 4 KPI + 趋势图 + 平台分布 + 模型分布 + Top 会话
 *  - 订阅监控：Provider 全息卡片网格（虹彩箔 + 指针光晕 + 3D 倾斜，见 SubscriptionHoloCard.vue）
 *  - 图表通过 lib/chartTheme 跟随 data-theme 切换配色
 *  - 业务逻辑零修改（refresh / summary / timeline / sessions 等函数原样保留）
 */
import {
  ref,
  computed,
  onMounted,
  onUnmounted,
  watch,
  onBeforeUnmount
} from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Plus, RefreshCw, AlertTriangle } from 'lucide-vue-next'
import AddSubscriptionDialog from '@/components/AddSubscriptionDialog.vue'
import RecapPanel from '@/components/RecapPanel.vue'
import SubscriptionHoloCard from '@/components/SubscriptionHoloCard.vue'
import { useAppStore } from '@/stores/app'
import {
  fmtToken,
  fmtTokenShort,
  fmtCost,
  fmtCny,
  fmtRelative
} from '@/lib/format'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
  Button,
  Badge,
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
  Select,
  Separator,
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
  DialogRoot,
  DialogPortal,
  DialogOverlay,
  DialogContent,
  DialogHeader as DCHeader,
  DialogFooter as DCFooter,
  DialogTitle as DCTitle
} from '@/components/ui'
import {
  getChartTheme,
  watchTheme,
  buildAxisOptions,
  buildLegendOptions,
  buildTooltipOptions,
  type ChartTheme
} from '@/lib/chartTheme'
import { cn } from '@/lib/utils'
import type { Sub, ProviderMeta } from '@/types/subscription'
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

// 关闭图表入场动画：大数据图表动画毫无信息价值，却在首次进入时让
// 3 个 canvas 并行逐帧重绘（远程/虚拟显示器会话里 canvas 走软件光栅化，
// 动画期间能把窗口拖到"未响应"）；关掉后图表立即呈现，渲染成本趋零。
ChartJS.defaults.animation = false

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
  opencode_flavor: 'openchamber' | 'opencode'
  /** 检测到源文件被重写、触发整文件重建的次数 */
  rewrites: number
  last_rewrite: { file: string; rows: number; at: number } | null
  /** source_file 为空的历史行数 */
  legacy_rows: number
  /** 是否有扫描正在后台执行（rescan 异步化后判断「扫描中」/「完成」） */
  scanning?: boolean
}

const AGENT_LABEL_STATIC: Record<string, string> = {
  omp: 'OMP',
  zcode: 'ZCode',
  codex: 'Codex',
  claude: 'Claude',
  dsh: 'DSH (DeepSeek)',
  unknown: '未知'
}
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

type PresetRange = 'today' | '24h' | '7d' | '30d' | 'all'
type Granularity = 'hour' | 'day' | 'month'

const agent = ref<'all' | 'omp' | 'zcode' | 'opencode' | 'codex' | 'claude' | 'dsh'>(
  'all'
)
const model = ref<string>('all')
const models = ref<string[]>([])
const granularity = ref<Granularity>('hour')
const presetRange = ref<PresetRange>('today')

const summary = ref<Summary | null>(null)
const timeline = ref<TimelinePoint[]>([])
const sessions = ref<Session[]>([])
const status = ref<Status | null>(null)
const loading = ref(false)
const store = useAppStore()
let pollTimer: ReturnType<typeof setInterval> | null = null

function providerMetaOf(id: string): ProviderMeta | undefined {
  return providerMetas.value.find((p) => p.id === id)
}
const route = useRoute()
const router = useRouter()
const tab = ref<'usage' | 'recap' | 'subscriptions'>(
  route.query.tab === 'recap'
    ? 'recap'
    : route.query.tab === 'subscriptions'
      ? 'subscriptions'
      : 'usage'
)
// Tab 深链：#/usage?tab=recap —— web 镜像可直接分享定位
watch(tab, (v) => {
  void router.replace({
    query: { ...route.query, tab: v === 'usage' ? undefined : v }
  })
})
const subs = ref<Sub[]>([])
const providerMetas = ref<ProviderMeta[]>([])
const dialogOpen = ref(false)
const editingSub = ref<Sub | null>(null)
const refreshingIds = ref<Set<number>>(new Set())
const confirmDelete = ref<Sub | null>(null)
const confirmOpen = computed({
  get: () => !!confirmDelete.value,
  set: (v) => {
    if (!v) confirmDelete.value = null
  }
})

async function refreshSubs() {
  try {
    const [list, metas] = await Promise.all([
      window.lcp.subList(),
      window.lcp.subProviders()
    ])
    subs.value = list as Sub[]
    providerMetas.value = metas as ProviderMeta[]
  } catch {
    // 静默
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
  model: model.value === 'all' ? undefined : model.value || undefined,
  from: from.value,
  to: undefined
}))

// 请求序号：筛选 / 粒度 / 轮询 / rescan 会并发触发 refresh，
// 只让最后一次发出的请求写回数据，防止快速切换筛选时旧响应覆盖新数据
let reqSeq = 0
async function refresh() {
  const seq = ++reqSeq
  loading.value = true
  try {
    const [s, t, ss, m, st] = await Promise.all([
      window.lcp.usageSummary(filter.value),
      window.lcp.usageTimeline({
        filter: filter.value,
        granularity: granularity.value
      }),
      window.lcp.usageSessions({ filter: filter.value, limit: 50 }),
      window.lcp.usageModels(),
      window.lcp.usageStatus()
    ])
    if (seq !== reqSeq) return
    summary.value = s as Summary
    timeline.value = (t as { timeline: TimelinePoint[] }).timeline ?? (t as TimelinePoint[])
    sessions.value = ss as Session[]
    models.value = m as string[]
    status.value = st as Status
  } finally {
    // 过期响应不关 loading：此时更新的那次请求还在飞行中，由它负责收尾
    if (seq === reqSeq) loading.value = false
  }
}

const rescanning = ref(false)
const RESCAN_POLL_MS = 1500
const RESCAN_TIMEOUT_MS = 5 * 60 * 1000
async function rescan() {
  if (rescanning.value) return
  rescanning.value = true
  try {
    // 异步触发：POST 立即返回 { started }，后台全量重建约 20-25s
    const before = (await window.lcp.usageStatus()) as Status
    const beforeAt = before?.last_scan_at ?? 0
    await window.lcp.usageRescan()
    // 轮询 status 直到「没有扫描在跑 且 上次扫描时间比触发时新」，再拉数据
    const deadline = Date.now() + RESCAN_TIMEOUT_MS
    let done = false
    while (Date.now() < deadline) {
      const st = (await window.lcp.usageStatus()) as Status
      if (!st?.scanning && (st?.last_scan_at ?? 0) > beforeAt) {
        done = true
        break
      }
      await new Promise((r) => setTimeout(r, RESCAN_POLL_MS))
    }
    if (!done) throw new Error('扫描超时（5 分钟）')
    await refresh()
    store.notify('success', '重新扫描完成')
  } catch (e) {
    // 失败必须可见，否则按钮像「没反应」
    store.notify('error', `重新扫描失败：${(e as Error)?.message ?? String(e)}`)
  } finally {
    rescanning.value = false
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
  stopThemeWatch?.()
})

// filter 是 computed，每次依赖变化返回新对象，引用比较即可感知变化，无需 deep
watch(filter, refresh)
watch(granularity, refresh)

// ===== Charts =====

function num(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

// 主题实例：theme 被 withThemeColors 的各 computed options 引用，
// 主题切换时 options 重算，由 vue-chartjs 内部 watcher 驱动图表换色
const theme = ref<ChartTheme>(getChartTheme())
let stopThemeWatch: (() => void) | null = null

function withThemeColors(baseOptions: ChartOptions): ChartOptions {
  const t = theme.value
  if (baseOptions.scales) {
    for (const k of Object.keys(baseOptions.scales)) {
      const s = (baseOptions.scales as Record<string, Record<string, unknown>>)[k]!
      s.ticks = { ...(s.ticks as object), ...buildAxisOptions(t).ticks }
      s.grid = { ...(s.grid as object), ...buildAxisOptions(t).grid }
      s.border = { ...(s.border as object), ...buildAxisOptions(t).border }
    }
  }
  if (baseOptions.plugins?.legend) {
    Object.assign(baseOptions.plugins.legend, buildLegendOptions(t))
  }
  if (baseOptions.plugins?.tooltip) {
    Object.assign(baseOptions.plugins.tooltip, buildTooltipOptions(t))
  }
  return baseOptions
}

const lineChartData = computed<ChartData<'line'>>(() => {
  const t = theme.value
  const datasets: ChartData<'line'>['datasets'] = [
    {
      label: 'Token 用量',
      data: timeline.value.map((p) => p.tokens),
      borderColor: t.primary,
      backgroundColor: t.primary + '26',
      fill: true,
      tension: 0.3,
      yAxisID: 'y'
    }
  ]
  // 全 0 成本时不画成本线，避免 y1 轴出现 ±$1 的对称噪音
  if ((summary.value?.cost_usd ?? 0) > 0) {
    datasets.push({
      label: '成本 (USD)',
      data: timeline.value.map((p) => p.cost),
      borderColor: t.warning,
      backgroundColor: t.warning + '0d',
      borderDash: [4, 4],
      fill: false,
      tension: 0.3,
      yAxisID: 'y1'
    })
  }
  return { labels: timeline.value.map((p) => p.bucket), datasets }
})

const hasCostSeries = computed(() => (summary.value?.cost_usd ?? 0) > 0)

const lineChartOptions = computed<ChartOptions<'line'>>(
  () =>
    withThemeColors({
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
        ...(hasCostSeries.value
          ? {
              y1: {
                type: 'linear' as const,
                position: 'right' as const,
                title: { display: true, text: 'USD' },
                grid: { drawOnChartArea: false },
                ticks: { callback: (v) => '$' + num(v).toFixed(2) }
              }
            }
          : {})
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
    }) as ChartOptions<'line'>
)

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

const platformTab = ref<'rank' | 'cost'>('rank')
const rankRows = computed(() =>
  [...(summary.value?.by_agent ?? [])].sort((a, b) => b.tokens - a.tokens)
)
const rankMaxTokens = computed(() =>
  Math.max(1, ...rankRows.value.map((r) => r.tokens))
)

const agentDoughnutOptions = computed<ChartOptions<'doughnut'>>(
  () =>
    withThemeColors({
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
    }) as ChartOptions<'doughnut'>
)

const modelBar = computed<ChartData<'bar'>>(() => {
  const t = theme.value
  const top = (summary.value?.by_model ?? []).slice(0, 10)
  return {
    labels: top.map((r) => r.model),
    datasets: [
      {
        label: 'Token',
        data: top.map((r) => r.tokens),
        backgroundColor: t.primary
      },
      {
        label: '缓存命中',
        data: top.map((r) => r.cache_read),
        backgroundColor: t.success
      }
    ]
  }
})

const modelBarOptions = computed<ChartOptions<'bar'>>(
  () =>
    withThemeColors({
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
            label: (ctx) =>
              `${ctx.dataset.label}: ${fmtToken(num(ctx.parsed.x))}`
          }
        }
      }
    }) as ChartOptions<'bar'>
)

// 启动主题监听
onMounted(() => {
  stopThemeWatch = watchTheme(() => {
    theme.value = getChartTheme()
  })
})
onBeforeUnmount(() => {
  stopThemeWatch?.()
})

// ===== utils（中国人习惯） =====
// fmtToken / fmtTokenShort / fmtCost / fmtCny 已抽到 @/lib/format 共享

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

const rangeLabel = computed(() => presetLabels[presetRange.value])
const granularityLabel = computed(() =>
  granularity.value === 'hour' ? '小时' : granularity.value === 'day' ? '日' : '月'
)

// 平台筛选项
const agentOptions = computed(() => [
  { value: 'all', label: '全部' },
  { value: 'omp', label: 'OMP' },
  { value: 'zcode', label: 'ZCode' },
  { value: 'opencode', label: opencodeLabel.value },
  { value: 'codex', label: 'Codex' },
  { value: 'claude', label: 'Claude' },
  { value: 'dsh', label: 'DSH' }
])

const rangeOptions = computed(() => [
  { value: 'today', label: '今天' },
  { value: '24h', label: '24h' },
  { value: '7d', label: '7 天' },
  { value: '30d', label: '30 天' },
  { value: 'all', label: '全部' }
])

const granularityOptions = computed(() => [
  { value: 'hour', label: '小时' },
  { value: 'day', label: '日' },
  { value: 'month', label: '月' }
])

const modelOptions = computed(() => [
  // SelectItem 不允许空字符串 value（会被当作"清空选择"），用 'all' 哨兵表示全部
  { value: 'all', label: '全部模型' },
  ...models.value.map((m) => ({ value: m, label: m }))
])
</script>

<template>
  <div class="flex flex-col gap-5 p-8">
    <header class="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 class="text-2xl font-semibold tracking-tight">Agent Token 用量</h1>
        <p v-if="tab === 'usage'" class="mt-1 text-sm text-muted-foreground">
          扫描 <b>{{ status?.files_scanned ?? 0 }}</b> 个文件 ·
          {{ opencodeLabel }} 消息
          <b>{{ status?.opencode_messages ?? 0 }}</b> 条 · DSH 会话
          <b>{{ status?.dsh_sessions ?? 0 }}</b> 个 · 上次扫描
          {{ fmtRelative(status?.last_scan_at) }}
        </p>
        <!-- 老数据没有 source_file 标记，文件被重写时只能靠 agent+session_id 兜底回收。
             提示用户重扫一次，把兜底换成精确删除。 -->
        <p
          v-if="tab === 'usage' && (status?.legacy_rows ?? 0) > 0"
          class="mt-1 flex items-center gap-1.5 text-xs text-warning"
        >
          <AlertTriangle class="size-3.5 shrink-0" />
          有 {{ status?.legacy_rows }} 条历史记录未标记来源文件，建议点「重新扫描」一次，
          之后文件被重写时才能精确重建（重扫会清掉源文件已删除的旧会话）。
        </p>
        <p v-else-if="tab === 'subscriptions'" class="mt-1 text-sm text-muted-foreground">
          监控已订阅的 AI 服务商配额 · 每 5 分钟自动刷新
        </p>
      </div>
      <div class="flex items-center gap-2">
        <template v-if="tab === 'usage'">
          <Button :disabled="loading || rescanning" variant="outline" @click="refresh">
            <RefreshCw :class="['size-4', loading && 'animate-spin']" />
            刷新
          </Button>
          <Button :disabled="loading || rescanning" @click="rescan">
            <RefreshCw :class="['size-4', rescanning && 'animate-spin']" />
            {{ rescanning ? '扫描中…' : '重新扫描' }}
          </Button>
        </template>
        <template v-else-if="tab === 'subscriptions'">
          <Button variant="outline" @click="refreshSubs">刷新列表</Button>
          <Button @click="openAddDialog">
            <Plus class="size-4" />
            添加 Provider
          </Button>
        </template>
      </div>
    </header>

    <Tabs v-model="tab" default-value="usage">
      <TabsList>
        <TabsTrigger value="usage">Token 用量</TabsTrigger>
        <TabsTrigger value="recap">回顾</TabsTrigger>
        <TabsTrigger value="subscriptions">
          订阅监控
          <Badge v-if="subs.length" variant="default" class="ml-1 px-1.5 text-[10px]">
            {{ subs.length }}
          </Badge>
        </TabsTrigger>
      </TabsList>

      <TabsContent value="usage" class="flex flex-col gap-4">
        <!-- 筛选条 -->
        <Card class="p-4">
          <div class="flex flex-wrap items-end gap-x-5 gap-y-3">
            <div class="flex flex-col gap-1.5">
              <Label>平台</Label>
              <Select v-model="agent" :items="agentOptions" class="w-32" />
            </div>
            <div class="flex flex-col gap-1.5">
              <Label>时间</Label>
              <Select v-model="presetRange" :items="rangeOptions" class="w-32" />
            </div>
            <div class="flex flex-col gap-1.5">
              <Label>粒度</Label>
              <Select
                v-model="granularity"
                :items="granularityOptions"
                class="w-24"
              />
            </div>
            <div class="flex flex-col gap-1.5">
              <Label>模型</Label>
              <Select v-model="model" :items="modelOptions" class="w-40" />
            </div>
          </div>
        </Card>

        <!-- KPI -->
        <div v-if="summary" class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Card class="p-4">
            <div class="text-xs text-muted-foreground">总 Token</div>
            <div class="mt-0.5 text-2xl font-semibold tabular-nums text-primary">
              {{ fmtToken(summary.total_tokens) }}
            </div>
            <div class="mt-1 text-[11px] text-muted-foreground">
              入 {{ fmtToken(summary.input_tokens) }} · 出
              {{ fmtToken(summary.output_tokens) }} · 缓存
              {{ fmtToken(summary.cached_tokens) }}
            </div>
          </Card>
          <Card class="p-4">
            <div class="text-xs text-muted-foreground">总成本</div>
            <div class="mt-0.5 text-2xl font-semibold tabular-nums text-warning">
              {{ fmtCost(summary.cost_usd) }}
            </div>
            <div class="mt-1 text-[11px] text-muted-foreground">
              {{ fmtCny(summary.cost_usd) }} · 平均
              {{ fmtCost(summary.cost_usd / Math.max(1, summary.calls)) }} / 次
            </div>
          </Card>
          <Card class="p-4">
            <div class="text-xs text-muted-foreground">调用次数</div>
            <div class="mt-0.5 text-2xl font-semibold tabular-nums">
              {{ summary.calls.toLocaleString() }}
            </div>
            <div class="mt-1 text-[11px] text-muted-foreground">
              平均
              {{ fmtToken(Math.round(summary.total_tokens / Math.max(1, summary.calls))) }} / 次
            </div>
          </Card>
          <Card class="p-4">
            <div class="text-xs text-muted-foreground">缓存命中</div>
            <div class="mt-0.5 text-2xl font-semibold tabular-nums text-success">
              {{ summary.cache_hit_ratio.toFixed(1) }}%
            </div>
            <div class="mt-1 text-[11px] text-muted-foreground">
              读 {{ fmtToken(summary.cache_read_tokens) }} · 写
              {{ fmtToken(summary.cache_write_tokens) }}
            </div>
          </Card>
        </div>

        <!-- 趋势图 -->
        <Card v-if="timeline.length" class="p-4">
          <div class="mb-2 flex items-center justify-between">
            <CardTitle>趋势 · 按{{ granularityLabel }}（{{ rangeLabel }}）</CardTitle>
          </div>
          <div class="h-72">
            <Line
              :data="lineChartData"
              :options="lineChartOptions"
            />
          </div>
        </Card>

        <!-- 平台分布 / 模型分布 -->
        <div v-if="summary" class="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <Card class="p-4">
            <div class="mb-2 flex items-center justify-between">
              <CardTitle>
                {{
                  platformTab === 'rank' ? '用量排行 · 按平台' : '成本占比 · 按平台'
                }}
              </CardTitle>
              <div class="flex items-center gap-1 rounded-md bg-muted p-0.5 text-[11px]">
                <button
                  :class="[
                    'rounded px-2 py-0.5 transition-colors',
                    platformTab === 'rank' ? 'bg-card shadow-sm' : 'text-muted-foreground'
                  ]"
                  @click="platformTab = 'rank'"
                >
                  用量排行
                </button>
                <button
                  :class="[
                    'rounded px-2 py-0.5 transition-colors',
                    platformTab === 'cost' ? 'bg-card shadow-sm' : 'text-muted-foreground'
                  ]"
                  @click="platformTab = 'cost'"
                >
                  成本占比
                </button>
              </div>
            </div>
            <div v-if="platformTab === 'cost'" class="h-60">
              <Doughnut
                :data="agentDoughnut"
                :options="agentDoughnutOptions"
              />
            </div>
            <div v-else-if="rankRows.length" class="flex h-60 flex-col justify-center gap-2.5">
              <div
                v-for="(r, i) in rankRows"
                :key="r.agent"
                class="grid grid-cols-[20px_8px_minmax(80px,auto)_1fr_auto_auto] items-center gap-2 text-xs"
              >
                <span class="text-right tabular-nums text-muted-foreground">{{ i + 1 }}</span>
                <span
                  class="size-2 rounded-full"
                  :style="{ background: AGENT_COLOR[r.agent] || '#888' }"
                />
                <span class="truncate">{{ agentLabels[r.agent] ?? r.agent }}</span>
                <div class="h-2 overflow-hidden rounded-full bg-muted">
                  <div
                    class="h-full rounded-full"
                    :style="{
                      width: Math.max(2, (r.tokens / rankMaxTokens) * 100) + '%',
                      background: AGENT_COLOR[r.agent] || '#94a3b8'
                    }"
                  />
                </div>
                <span class="min-w-[44px] text-right tabular-nums">
                  {{ fmtToken(r.tokens) }}
                </span>
                <span class="min-w-[52px] text-right text-muted-foreground tabular-nums">
                  {{ fmtCost(r.cost) }}
                </span>
              </div>
            </div>
            <p v-else class="py-8 text-center text-sm text-muted-foreground">
              暂无数据
            </p>
          </Card>
          <Card class="p-4">
            <CardTitle class="mb-2">Token 分布 · 按模型 TOP 10</CardTitle>
            <div class="h-60">
              <Bar
                :data="modelBar"
                :options="modelBarOptions"
              />
            </div>
          </Card>
        </div>

        <!-- 按平台表 / 按模型表 -->
        <div v-if="summary" class="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <Card>
            <CardHeader class="pb-3">
              <CardTitle>按平台</CardTitle>
            </CardHeader>
            <CardContent class="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>平台</TableHead>
                    <TableHead class="text-right">Token</TableHead>
                    <TableHead class="text-right">调用</TableHead>
                    <TableHead class="text-right">成本</TableHead>
                    <TableHead class="text-right">折合</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow
                    v-for="r in summary.by_agent"
                    :key="r.agent"
                  >
                    <TableCell>
                      <div class="flex items-center gap-2">
                        <span
                          class="size-2 shrink-0 rounded-full"
                          :style="{ background: AGENT_COLOR[r.agent] || '#888' }"
                        />
                        {{ agentLabels[r.agent] ?? r.agent }}
                      </div>
                    </TableCell>
                    <TableCell class="text-right tabular-nums">
                      {{ fmtToken(r.tokens) }}
                    </TableCell>
                    <TableCell class="text-right tabular-nums">
                      {{ r.calls.toLocaleString() }}
                    </TableCell>
                    <TableCell class="text-right tabular-nums text-warning">
                      {{ fmtCost(r.cost) }}
                    </TableCell>
                    <TableCell class="text-right text-xs text-muted-foreground">
                      {{ fmtCny(r.cost) }}
                    </TableCell>
                  </TableRow>
                  <TableRow v-if="summary.by_agent.length === 0">
                    <TableCell colspan="5" class="py-6 text-center text-muted-foreground">
                      暂无数据
                    </TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <Card>
            <CardHeader class="pb-3">
              <CardTitle>按模型</CardTitle>
            </CardHeader>
            <CardContent class="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>模型</TableHead>
                    <TableHead class="text-right">Token</TableHead>
                    <TableHead class="text-right">调用</TableHead>
                    <TableHead class="text-right">成本</TableHead>
                    <TableHead class="text-right">折合</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow
                    v-for="r in summary.by_model"
                    :key="r.model"
                  >
                    <TableCell>
                      <code class="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">
                        {{ r.model }}
                      </code>
                    </TableCell>
                    <TableCell class="text-right tabular-nums">
                      {{ fmtToken(r.tokens) }}
                    </TableCell>
                    <TableCell class="text-right tabular-nums">
                      {{ r.calls.toLocaleString() }}
                    </TableCell>
                    <TableCell class="text-right tabular-nums text-warning">
                      {{ fmtCost(r.cost) }}
                    </TableCell>
                    <TableCell class="text-right text-xs text-muted-foreground">
                      {{ fmtCny(r.cost) }}
                    </TableCell>
                  </TableRow>
                  <TableRow v-if="summary.by_model.length === 0">
                    <TableCell colspan="5" class="py-6 text-center text-muted-foreground">
                      暂无数据
                    </TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </div>

        <!-- Top 会话表 -->
        <Card v-if="sessions.length">
          <CardHeader class="pb-3">
            <CardTitle>Top 会话 · 按成本排序 · {{ sessions.length }} 条</CardTitle>
          </CardHeader>
          <CardContent class="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>会话</TableHead>
                  <TableHead>平台</TableHead>
                  <TableHead>模型</TableHead>
                  <TableHead class="text-right">调用</TableHead>
                  <TableHead class="text-right">Token</TableHead>
                  <TableHead class="text-right">成本</TableHead>
                  <TableHead class="text-right">折合</TableHead>
                  <TableHead>最后活跃</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow
                  v-for="s in sessions"
                  :key="s.session_id"
                >
                  <TableCell>
                    <code class="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">
                      {{ s.session_id.slice(0, 22) }}
                    </code>
                  </TableCell>
                  <TableCell>
                    <div class="flex items-center gap-2">
                      <span
                        class="size-2 shrink-0 rounded-full"
                        :style="{ background: AGENT_COLOR[s.agent] || '#888' }"
                      />
                      {{ agentLabels[s.agent] ?? s.agent }}
                    </div>
                  </TableCell>
                  <TableCell>
                    <code class="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">
                      {{ s.model || '—' }}
                    </code>
                  </TableCell>
                  <TableCell class="text-right tabular-nums">
                    {{ s.calls.toLocaleString() }}
                  </TableCell>
                  <TableCell class="text-right tabular-nums">
                    {{ fmtToken(s.tokens) }}
                  </TableCell>
                  <TableCell class="text-right tabular-nums text-warning">
                    {{ fmtCost(s.cost) }}
                  </TableCell>
                  <TableCell class="text-right text-xs text-muted-foreground">
                    {{ fmtCny(s.cost) }}
                  </TableCell>
                  <TableCell class="text-xs text-muted-foreground">
                    {{ fmtTime(s.last_at) }}
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card v-if="!summary || (summary.calls === 0 && !loading)" class="p-8 text-center">
          <CardTitle>暂无数据</CardTitle>
          <CardDescription class="mt-2 text-left text-xs">
            本工具会扫描以下目录的会话日志：<br />
            · <code>~/.omp/agent/sessions/</code> (OMP)<br />
            · <code>~/.zcode/cli/rollout/</code><br />
            · <code>~/.codex/sessions/</code><br />
            · <code>~/.claude/projects/</code><br />
            · <code>~/.local/share/opencode/opencode.db</code>
            (OpenCode / OpenChamber)<br />
            · <code>~/.dsh/sessions/</code> (DSH)
          </CardDescription>
        </Card>
      </TabsContent>

      <TabsContent value="recap" class="flex flex-col gap-4">
        <RecapPanel />
      </TabsContent>

      <TabsContent value="subscriptions" class="flex flex-col gap-4">
        <Card v-if="subs.length === 0" class="p-8 text-center">
          <CardTitle>还没有添加 Provider</CardTitle>
          <CardDescription class="mt-2">
            支持 Anthropic / OpenAI / MiniMax / Kimi / Z.AI 自动拉取，<br />
            或用「通用」类型手动维护任意服务商的配额。
          </CardDescription>
          <Button class="mt-4" @click="openAddDialog">
            <Plus class="size-4" />
            添加第一个 Provider
          </Button>
        </Card>

        <!-- 全息卡片网格：gap 稍大，避免卡片倾斜/发光时互相遮挡 -->
        <div v-else class="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3">
          <SubscriptionHoloCard
            v-for="s in subs"
            :key="s.id"
            :sub="s"
            :meta="providerMetaOf(s.provider)"
            :refreshing="refreshingIds.has(s.id)"
            @refresh="refreshOneSub"
            @edit="openEditDialog"
            @delete="askDelete"
          />
        </div>
      </TabsContent>
    </Tabs>

    <AddSubscriptionDialog
      v-if="dialogOpen"
      :editing="editingSub"
      @close="dialogOpen = false"
      @saved="onSubSaved"
    />

    <!-- 删除确认 -->
    <DialogRoot v-model:open="confirmOpen">
      <DialogPortal>
        <DialogOverlay />
        <DialogContent class="max-w-[440px]">
          <DCHeader>
            <DCTitle>删除订阅？</DCTitle>
          </DCHeader>
          <div class="flex flex-col gap-2 text-sm">
            <div class="font-medium">{{ confirmDelete?.displayName }}</div>
            <p class="text-xs text-muted-foreground">
              删除后不会影响你在 Provider 的登录态，仅清除本机监控记录。
            </p>
          </div>
          <DCFooter>
            <Button variant="outline" @click="confirmDelete = null">取消</Button>
            <Button variant="destructive" @click="confirmDeleteNow">
              确认删除
            </Button>
          </DCFooter>
        </DialogContent>
      </DialogPortal>
    </DialogRoot>
  </div>
</template>
