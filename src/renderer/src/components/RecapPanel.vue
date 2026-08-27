<script setup lang="ts">
/**
 * 回顾（Wrapped）面板 —— 全时段叙事页
 *  - 数据：window.lcp.usageRecap()（Electron IPC / web fetch 双通道）
 *  - 结构：Hero 四卡 → 本命模型 + 作息分布 → 成就徽章墙 → 12 周热力图
 *  - 成就规则在 lib/achievements.ts，本组件只做渲染
 */
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import {
  Card,
  CardTitle,
  CardDescription,
  Skeleton
} from '@/components/ui'
import { Line, Doughnut, Bar } from 'vue-chartjs'
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  ArcElement,
  Tooltip,
  Legend
} from 'chart.js'
import type { ChartData, ChartOptions } from 'chart.js'
import type { UsageRecap } from '@shared/types'
import { getChartTheme, watchTheme, type ChartTheme } from '@/lib/chartTheme'
import { ACHIEVEMENTS, personaLine } from '@/lib/achievements'
import { fmtToken, fmtTokenShort, fmtCost, fmtCny, fmtDate } from '@/lib/format'

ChartJS.register(
  CategoryScale,
  LinearScale,
  BarElement,
  ArcElement,
  Tooltip,
  Legend
)

const recap = ref<UsageRecap | null>(null)
const loading = ref(true)
const failed = ref(false)

async function load() {
  loading.value = true
  failed.value = false
  try {
    recap.value = (await window.lcp.usageRecap()) as UsageRecap
  } catch {
    failed.value = true
  } finally {
    loading.value = false
  }
}
onMounted(load)

// ===== 主题 =====
const theme = ref<ChartTheme>(getChartTheme())
let stopThemeWatch: (() => void) | null = null
onMounted(() => {
  stopThemeWatch = watchTheme(() => {
    theme.value = getChartTheme()
  })
})
onBeforeUnmount(() => stopThemeWatch?.())

// ===== 本命模型环形 =====
const shareDoughnut = computed<ChartData<'doughnut'>>(() => {
  const share = recap.value?.top_model?.share ?? 0
  const t = theme.value
  return {
    labels: ['本命', '其他'],
    datasets: [
      {
        data: [share, Math.max(0, 100 - share)],
        backgroundColor: [t.primary, t.border],
        borderWidth: 0,
        cutout: '74%'
      }
    ]
  }
})

const doughnutOptions = computed<ChartOptions<'doughnut'>>(
  () =>
    ({
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { enabled: false } }
    }) as ChartOptions<'doughnut'>
)

// ===== 作息分布 =====
const hourChart = computed<ChartData<'bar'>>(() => {
  const t = theme.value
  const h = recap.value?.hour_histogram ?? new Array(24).fill(0)
  const max = Math.max(...h)
  return {
    labels: h.map((_, i) => String(i)),
    datasets: [
      {
        label: '调用次数',
        data: h,
        backgroundColor: h.map((n) =>
          n === max && max > 0 ? t.warning : t.primary
        ),
        borderRadius: 3
      }
    ]
  }
})

const hourChartOptions = computed<ChartOptions<'bar'>>(
  () =>
    ({
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { ticks: { font: { size: 9 } }, grid: { display: false } },
        y: {
          ticks: { font: { size: 9 }, callback: (v) => fmtTokenShort(Number(v)) },
          grid: { color: 'transparent' }
        }
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => `${fmtToken(Number(ctx.parsed.y))} 次调用`
          }
        }
      }
    }) as ChartOptions<'bar'>
)

// ===== 成就 =====
const achievementRows = computed(() => {
  const r = recap.value
  if (!r) return []
  return ACHIEVEMENTS.map((a) => ({
    ...a,
    unlocked: a.reached(r),
    valueText: a.value(r),
    progress: a.progress(r)
  }))
})
const unlockedCount = computed(
  () => achievementRows.value.filter((a) => a.unlocked).length
)

// ===== 12 周热力图 =====
interface HeatCell {
  date: string
  tokens: number
  level: number
}
const HEAT_LEVELS = [
  'bg-muted',
  'bg-primary/25',
  'bg-primary/45',
  'bg-primary/70',
  'bg-primary'
]
const heat = computed(() => {
  const r = recap.value
  if (!r || r.days.length === 0) return null
  const byDate = new Map(r.days.map((d) => [d.date, d.tokens]))
  const max = Math.max(1, ...r.days.map((d) => d.tokens))

  const today = new Date()
  const end = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  const start = new Date(end)
  start.setDate(start.getDate() - 83)
  // 对齐到周一，让每列都是完整一周
  const dow = (start.getDay() + 6) % 7
  start.setDate(start.getDate() - dow)

  const pad = (x: number) => String(x).padStart(2, '0')
  const cells: HeatCell[] = []
  const cursor = new Date(start)
  while (cursor.getTime() <= end.getTime()) {
    const key = `${cursor.getFullYear()}-${pad(cursor.getMonth() + 1)}-${pad(cursor.getDate())}`
    const tokens = byDate.get(key) ?? 0
    const level =
      tokens === 0 ? 0 : Math.min(4, Math.ceil((tokens / max) * 4))
    cells.push({ date: key, tokens, level })
    cursor.setDate(cursor.getDate() + 1)
  }
  return { cells, max }
})

const persona = computed(() => (recap.value ? personaLine(recap.value) : ''))
</script>

<template>
  <!-- 加载中 -->
  <div v-if="loading" class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
    <Skeleton v-for="i in 4" :key="i" class="h-24 rounded-xl" />
  </div>

  <!-- 失败 / 空数据 -->
  <Card v-else-if="failed || !recap || recap.totals.calls === 0" class="p-10 text-center">
    <CardTitle>{{ failed ? '回顾数据加载失败' : '还没有可回顾的数据' }}</CardTitle>
    <CardDescription class="mx-auto mt-2 max-w-md text-xs">
      {{
        failed
          ? '请确认本地服务已启动后点击重试。'
          : '先去用一会儿 agent，等 Token 用量页出现数据后，这里会自动长出你的故事。'
      }}
    </CardDescription>
    <button
      class="mx-auto mt-4 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground"
      @click="load"
    >
      重试
    </button>
  </Card>

  <div v-else class="flex flex-col gap-4">
    <!-- ===== Hero 四卡 ===== -->
    <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Card class="p-4">
        <div class="text-xs text-muted-foreground">累计 Token</div>
        <div class="mt-1 text-3xl font-bold tabular-nums tracking-tight text-primary">
          {{ fmtToken(recap.totals.total_tokens) }}
        </div>
        <div class="mt-1 text-[11px] text-muted-foreground">
          共 {{ recap.totals.calls.toLocaleString() }} 次调用
        </div>
      </Card>
      <Card class="p-4">
        <div class="text-xs text-muted-foreground">累计成本</div>
        <div class="mt-1 text-3xl font-bold tabular-nums tracking-tight text-warning">
          {{ fmtCost(recap.totals.cost_usd) }}
        </div>
        <div class="mt-1 text-[11px] text-muted-foreground">
          {{ fmtCny(recap.totals.cost_usd) }}
        </div>
      </Card>
      <Card class="p-4">
        <div class="text-xs text-muted-foreground">活跃天数</div>
        <div class="mt-1 text-3xl font-bold tabular-nums tracking-tight">
          {{ recap.active_days }}<span class="ml-0.5 text-sm font-medium text-muted-foreground">天</span>
        </div>
        <div class="mt-1 text-[11px] text-muted-foreground">
          当前连续 {{ recap.streak_days }} 天 · 最长 {{ recap.best_streak }} 天
        </div>
      </Card>
      <Card class="p-4">
        <div class="text-xs text-muted-foreground">高峰日</div>
        <div class="mt-1 text-2xl font-bold tabular-nums tracking-tight">
          {{ recap.peak_day?.day ?? '—' }}
        </div>
        <div
          v-if="recap.peak_day"
          class="mt-1 text-[11px] text-muted-foreground"
        >
          当天 {{ fmtToken(recap.peak_day.tokens) }} tokens ·
          {{ fmtCost(recap.peak_day.cost) }}
        </div>
      </Card>
    </div>

    <!-- ===== 本命模型 + 作息分布 ===== -->
    <div class="grid grid-cols-1 gap-3 lg:grid-cols-2">
      <Card class="p-5">
        <div class="flex items-baseline justify-between">
          <CardTitle>本命模型</CardTitle>
          <span
            v-if="recap.top_model"
            class="text-[11px] text-muted-foreground"
          >
            初识于 {{ fmtDate(recap.first_at) }}
          </span>
        </div>
        <div v-if="recap.top_model" class="mt-4 flex items-center gap-5">
          <div class="relative size-36 shrink-0">
            <Doughnut :data="shareDoughnut" :options="doughnutOptions" />
            <div
              class="pointer-events-none absolute inset-0 flex flex-col items-center justify-center"
            >
              <span class="text-2xl font-bold tabular-nums">
                {{ recap.top_model.share.toFixed(0) }}%
              </span>
              <span class="text-[10px] text-muted-foreground">占比</span>
            </div>
          </div>
          <div class="min-w-0 flex-1">
            <code
              class="block truncate rounded bg-muted px-2 py-1 font-mono text-[13px] font-semibold"
              :title="recap.top_model.model"
            >
              {{ recap.top_model.model }}
            </code>
            <p class="mt-2 text-xs leading-relaxed text-muted-foreground">
              你 {{ recap.top_model.share.toFixed(0) }}% 的对话都给了它。
            </p>
            <div class="mt-3 grid grid-cols-3 gap-2 text-center">
              <div class="rounded-lg bg-muted/60 px-1 py-2">
                <div class="text-sm font-semibold tabular-nums">
                  {{ fmtToken(recap.top_model.tokens) }}
                </div>
                <div class="text-[10px] text-muted-foreground">tokens</div>
              </div>
              <div class="rounded-lg bg-muted/60 px-1 py-2">
                <div class="text-sm font-semibold tabular-nums">
                  {{ recap.top_model.calls.toLocaleString() }}
                </div>
                <div class="text-[10px] text-muted-foreground">调用</div>
              </div>
              <div class="rounded-lg bg-muted/60 px-1 py-2">
                <div class="text-sm font-semibold tabular-nums text-success">
                  {{ recap.top_model.cache_hit_ratio.toFixed(0) }}%
                </div>
                <div class="text-[10px] text-muted-foreground">缓存命中</div>
              </div>
            </div>
          </div>
        </div>
        <p v-else class="mt-6 text-sm text-muted-foreground">暂无模型数据</p>
      </Card>

      <Card class="p-5">
        <div class="flex items-baseline justify-between">
          <CardTitle>作息分布</CardTitle>
          <span class="text-[11px] text-muted-foreground">{{ persona }}</span>
        </div>
        <div class="mt-4 h-44">
          <Bar :data="hourChart" :options="hourChartOptions" />
        </div>
        <p class="mt-2 text-[11px] text-muted-foreground">
          全时段按小时（UTC+8）的调用次数分布 · 橙色为最活跃时段
        </p>
      </Card>
    </div>

    <!-- ===== 成就徽章墙 ===== -->
    <Card class="p-5">
      <div class="flex items-baseline justify-between">
        <CardTitle>成就</CardTitle>
        <span class="text-[11px] text-muted-foreground">
          已点亮 {{ unlockedCount }} / {{ achievementRows.length }}
        </span>
      </div>
      <div class="mt-4 grid grid-cols-2 gap-2.5 md:grid-cols-3 xl:grid-cols-5">
        <div
          v-for="a in achievementRows"
          :key="a.id"
          :class="[
            'flex flex-col gap-1.5 rounded-xl border p-3.5 transition-colors',
            a.unlocked
              ? 'border-primary/30 bg-primary/5'
              : 'border-border bg-muted/30 opacity-70'
          ]"
        >
          <div class="flex items-center gap-2">
            <span
              :class="[
                'text-xl leading-none',
                !a.unlocked && 'grayscale opacity-50'
              ]"
            >
              {{ a.icon }}
            </span>
            <span
              :class="[
                'text-[13px] font-semibold',
                a.unlocked ? 'text-foreground' : 'text-muted-foreground'
              ]"
            >
              {{ a.name }}
            </span>
          </div>
          <div class="min-h-[32px]">
            <template v-if="a.unlocked">
              <div class="text-xs font-medium text-primary">
                {{ a.valueText }}
              </div>
              <div class="mt-0.5 text-[10.5px] text-muted-foreground">
                {{ a.hint }}
              </div>
            </template>
            <template v-else-if="a.progress">
              <div class="text-[10.5px] text-muted-foreground">
                {{ a.progress.text }}
              </div>
              <div class="mt-1.5 h-1 overflow-hidden rounded-full bg-muted">
                <div
                  class="h-full rounded-full bg-primary/50"
                  :style="{ width: Math.max(3, a.progress.ratio * 100) + '%' }"
                />
              </div>
            </template>
            <div v-else class="text-[10.5px] text-muted-foreground">
              {{ a.hint }}
            </div>
          </div>
        </div>
      </div>
    </Card>

    <!-- ===== 12 周热力图 ===== -->
    <Card v-if="heat" class="p-5">
      <div class="flex items-baseline justify-between">
        <CardTitle>近 12 周</CardTitle>
        <div class="flex items-center gap-1 text-[10px] text-muted-foreground">
          少
          <span
            v-for="(cls, i) in HEAT_LEVELS"
            :key="i"
            :class="['size-2.5 rounded-[2px]', cls]"
          />
          多
        </div>
      </div>
      <div class="mt-4 overflow-x-auto pb-1">
        <div class="grid grid-flow-col grid-rows-7 gap-[3px]" style="width: max-content">
          <div
            v-for="cell in heat.cells"
            :key="cell.date"
            :class="['size-[13px] rounded-[3px]', HEAT_LEVELS[cell.level]]"
            :title="`${cell.date} · ${fmtToken(cell.tokens)} tokens`"
          />
        </div>
      </div>
      <p class="mt-2 text-[11px] text-muted-foreground">
        峰值 {{ fmtToken(heat.max) }} tokens/天 · 悬停查看每日明细
      </p>
    </Card>
  </div>
</template>
