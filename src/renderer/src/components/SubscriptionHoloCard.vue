<script setup lang="ts">
/**
 * 订阅监控 · 全息卡片（Holo Card）
 *
 * 视觉构成（自下而上 5 层，均为 pointer-events:none 的绝对定位层）：
 *   1. holo-base  玻璃底：跟随指针的 accent 径向光 + 斜向渐变
 *   2. holo-foil  虹彩箔：conic-gradient 彩虹 + 模糊，随指针偏移、随时间缓慢旋转
 *   3. holo-grid  HUD 细网格：accent 细线，顶部径向遮罩淡出
 *   4. holo-glare 高光：跟随指针的白色镜面反光
 *   5. holo-ring  渐变描边：conic 彩虹 + mask 挖空，只留 1px 边
 *   6. holo-sheen 掠光：hover 时一道斜向白光扫过
 *
 * 交互：指针驱动 --mx/--my/--rot-x/--rot-y，卡片 3D 轻微倾斜，内容层 translateZ 产生景深；
 *      prefers-reduced-motion 下关闭倾斜与所有动画。
 *
 * 业务逻辑沿用原订阅卡片的口径（quotaTone / primaryWindow / primaryPct / 重置倒计时等）。
 */
import { computed, ref, onBeforeUnmount } from 'vue'
import { RotateCw, Pencil, Trash2 } from 'lucide-vue-next'
import { Button, Badge } from '@/components/ui'
import { fmtToken, fmtRelative } from '@/lib/format'
import type {
  Sub,
  ProviderMeta,
  QuotaWindow,
  QuotaSnapshot
} from '@/types/subscription'

const props = defineProps<{
  sub: Sub
  meta?: ProviderMeta
  refreshing?: boolean
}>()
const emit = defineEmits<{
  refresh: [Sub]
  edit: [Sub]
  delete: [Sub]
}>()

/* ---------------- 配额口径（与原卡片一致） ---------------- */

type Tone = 'ok' | 'warn' | 'danger' | 'unknown'

function quotaTone(pct: number | null | undefined): Tone {
  if (typeof pct !== 'number') return 'unknown'
  if (pct >= 90) return 'danger'
  if (pct >= 70) return 'warn'
  return 'ok'
}

const TONE_VAR: Record<Tone, string> = {
  ok: 'var(--success)',
  warn: 'var(--warning)',
  danger: 'var(--destructive)',
  unknown: 'var(--muted-foreground)'
}
function toneVar(t: Tone): string {
  return TONE_VAR[t]
}

function subStatus(s: Sub): 'active' | 'stale' | 'error' {
  if (s.lastError) return 'error'
  if (!s.lastRefreshAt) return 'stale'
  return Date.now() - s.lastRefreshAt <= 10 * 60 * 1000 ? 'active' : 'stale'
}

const STATUS_TEXT: Record<'active' | 'stale' | 'error', string> = {
  active: '同步正常',
  stale: '未更新',
  error: '获取失败'
}

function hasQuotaData(s: Sub): boolean {
  const snap = s.lastSnapshot
  if (!snap) return false
  return (snap.windows?.length ?? 0) > 0 || typeof snap.usedPct === 'number'
}

function primaryWindow(s: Sub): QuotaWindow | null {
  let best: QuotaWindow | null = null
  for (const w of s.lastSnapshot?.windows ?? []) {
    if (typeof w.usedPct !== 'number') continue
    if (!best || (w.usedPct as number) > (best.usedPct as number)) best = w
  }
  return best
}

function primaryPct(s: Sub): number | null {
  const snap = s.lastSnapshot
  if (!snap) return null
  const pw = primaryWindow(s)
  if (pw) return pw.usedPct
  return typeof snap.usedPct === 'number' ? snap.usedPct : null
}

function primaryResetAt(s: Sub): number | null {
  const snap = s.lastSnapshot
  if (!snap) return null
  const pw = primaryWindow(s)
  if (pw?.resetAt) return pw.resetAt
  if (snap.windowEnd) return snap.windowEnd
  return (snap.windows ?? []).find((w) => w.resetAt)?.resetAt ?? null
}

function primaryTitle(s: Sub): string {
  const wins = s.lastSnapshot?.windows ?? []
  if (wins.length === 0) return '总体额度'
  if (wins.length === 1) return `${wins[0].label} 窗口`
  const pw = primaryWindow(s)
  return pw ? `${pw.label} 窗口 · 用量最高` : '各窗口用量'
}

function fmtDur(ms: number): string {
  const totalMin = Math.floor(Math.abs(ms) / 60000)
  const d = Math.floor(totalMin / 1440)
  const h = Math.floor((totalMin % 1440) / 60)
  const m = totalMin % 60
  if (d > 0) return h > 0 ? `${d}天${h}小时` : `${d}天`
  if (h > 0) return m > 0 ? `${h}小时${m}分` : `${h}小时`
  return `${Math.max(1, m)}分钟`
}

function fmtResetIn(ts: number | null | undefined): string {
  if (!ts) return ''
  const diff = ts - Date.now()
  if (!Number.isFinite(diff)) return ''
  if (diff <= 0) return '即将重置'
  return `${fmtDur(diff)}后重置`
}

function barWidth(pct: number | null | undefined): string {
  if (typeof pct !== 'number' || pct <= 0) return '0%'
  return Math.min(100, Math.max(2, pct)) + '%'
}

function quotaSublineLeft(snap: QuotaSnapshot): string | null {
  if (typeof snap.used === 'number') {
    const lim = typeof snap.limit === 'number' ? snap.limit : null
    return lim
      ? `已用 ${fmtToken(snap.used)} / ${fmtToken(lim)}`
      : `已用 ${fmtToken(snap.used)}`
  }
  if (snap.planLabel) return `套餐 ${snap.planLabel}`
  return null
}

/* ---------------- 派生显示值 ---------------- */

const status = computed(() => subStatus(props.sub))
const refreshing = computed(() => !!props.refreshing)
const hasData = computed(() => hasQuotaData(props.sub))

const pct = computed(() => primaryPct(props.sub))
const tone = computed<Tone>(() => quotaTone(pct.value))
const toneColor = computed(() => toneVar(tone.value))
const pctText = computed(() =>
  pct.value === null ? '—' : pct.value.toFixed(1) + '%'
)
const resetText = computed(() => fmtResetIn(primaryResetAt(props.sub)))
const windows = computed(() => props.sub.lastSnapshot?.windows ?? [])
const subline = computed(() =>
  props.sub.lastSnapshot ? quotaSublineLeft(props.sub.lastSnapshot) : null
)
const accent = computed(() => props.meta?.color || '#64748b')

/* ---------------- 指针驱动的全息交互 ---------------- */

const root = ref<HTMLElement | null>(null)
let raf = 0
let pending: { x: number; y: number } | null = null

function apply(x: number, y: number) {
  const el = root.value
  if (!el) return
  el.style.setProperty('--mx', (x * 100).toFixed(2) + '%')
  el.style.setProperty('--my', (y * 100).toFixed(2) + '%')
  // 与 vanilla-tilt 同向：指针在哪边，哪边就朝观察者压过来
  el.style.setProperty('--rot-y', ((x - 0.5) * 9).toFixed(2) + 'deg')
  el.style.setProperty('--rot-x', ((0.5 - y) * 7).toFixed(2) + 'deg')
}

function onPointerMove(e: PointerEvent) {
  const el = root.value
  if (!el) return
  const r = el.getBoundingClientRect()
  pending = {
    x: (e.clientX - r.left) / r.width,
    y: (e.clientY - r.top) / r.height
  }
  if (raf) return
  raf = requestAnimationFrame(() => {
    raf = 0
    const p = pending
    pending = null
    if (p) apply(p.x, p.y)
  })
}

function onPointerLeave() {
  pending = null
  if (raf) {
    cancelAnimationFrame(raf)
    raf = 0
  }
  const el = root.value
  if (!el) return
  el.style.setProperty('--mx', '50%')
  el.style.setProperty('--my', '0%')
  el.style.setProperty('--rot-x', '0deg')
  el.style.setProperty('--rot-y', '0deg')
}

onBeforeUnmount(() => {
  if (raf) cancelAnimationFrame(raf)
})
</script>

<template>
  <div
    ref="root"
    class="holo-card group"
    :style="{ '--accent': accent, '--tone': toneColor }"
    @pointermove="onPointerMove"
    @pointerleave="onPointerLeave"
  >
    <!-- 全息图层 -->
    <div class="holo-layers" aria-hidden="true">
      <div class="holo-base" />
      <div class="holo-grid" />
      <div class="holo-foil" />
      <div class="holo-glare" />
      <div class="holo-ring" />
      <div class="holo-sheen" />
    </div>

    <!-- 内容（translateZ 制造景深） -->
    <div class="holo-content">
      <!-- 头部：Provider 标识 + 状态 + 悬浮操作 -->
      <header class="flex items-start gap-3">
        <div class="holo-avatar">
          <span>{{ meta?.short || '?' }}</span>
        </div>
        <div class="min-w-0 flex-1 pr-[86px]">
          <div
            class="truncate text-[14px] leading-tight font-semibold tracking-tight"
            :title="sub.displayName"
          >
            {{ sub.displayName }}
          </div>
          <div class="mt-1.5 flex min-w-0 items-center gap-1.5">
            <span
              :class="[
                'holo-chip shrink-0',
                status === 'active' && 'is-active',
                status === 'stale' && 'is-stale',
                status === 'error' && 'is-error'
              ]"
            >
              <i
                :class="['holo-dot', refreshing && 'animate-pulse']"
              />
              {{ refreshing ? '刷新中…' : STATUS_TEXT[status] }}
            </span>
            <span
              v-if="meta"
              class="truncate text-[11px] text-muted-foreground"
              :title="meta.label"
            >
              {{ meta.label }}
            </span>
          </div>
        </div>

        <div
          class="absolute top-3 right-3 flex items-center gap-0.5 opacity-0 transition-opacity duration-200 group-hover:opacity-100 group-focus-within:opacity-100"
        >
          <Button
            variant="ghost"
            size="icon"
            class="holo-action size-7"
            :disabled="refreshing || !sub.enabled"
            title="立即刷新"
            @click="emit('refresh', sub)"
          >
            <RotateCw :class="['size-3.5', refreshing && 'animate-spin']" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            class="holo-action size-7"
            title="编辑"
            @click="emit('edit', sub)"
          >
            <Pencil class="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            class="holo-action size-7 is-danger"
            title="删除"
            @click="emit('delete', sub)"
          >
            <Trash2 class="size-3.5" />
          </Button>
        </div>
      </header>

      <div class="holo-line" />

      <!-- 主体：主百分比 -->
      <template v-if="hasData">
        <div class="mt-3.5 flex items-end justify-between gap-3">
          <span class="holo-num tabular-nums">{{ pctText }}</span>
          <span
            v-if="resetText"
            class="pb-1.5 text-[11px] whitespace-nowrap text-muted-foreground tabular-nums"
          >
            {{ resetText }}
          </span>
        </div>

        <div class="mt-1 truncate text-[11px] text-muted-foreground">
          {{ primaryTitle(sub) }}
        </div>

        <div class="holo-bar mt-2.5">
          <div
            class="holo-bar-fill"
            :style="{ width: barWidth(pct) }"
          />
        </div>

        <div
          v-if="subline || typeof sub.lastSnapshot?.remaining === 'number'"
          class="mt-2 flex items-baseline justify-between gap-2 text-[11.5px] text-muted-foreground"
        >
          <span class="truncate">{{ subline ?? '' }}</span>
          <span
            v-if="typeof sub.lastSnapshot?.remaining === 'number'"
            class="shrink-0 tabular-nums text-success"
          >
            剩余 {{ fmtToken(sub.lastSnapshot.remaining) }}
          </span>
        </div>

        <!-- 各窗口明细 -->
        <div
          v-if="windows.length >= 2"
          class="mt-3 flex flex-col gap-2 border-t border-dashed border-border/70 pt-2.5"
        >
          <div class="text-[10px] tracking-[0.14em] text-muted-foreground uppercase">
            各窗口明细
          </div>
          <div
            v-for="w in windows"
            :key="w.label"
            class="grid grid-cols-[minmax(58px,auto)_1fr_38px_auto] items-center gap-2.5 text-[11.5px]"
          >
            <span
              :class="[
                'flex items-center gap-1 truncate',
                w === primaryWindow(sub)
                  ? 'font-semibold text-foreground'
                  : 'text-muted-foreground'
              ]"
              :title="w.label"
            >
              {{ w.label }}
              <Badge
                v-if="w === primaryWindow(sub)"
                variant="default"
                class="px-1 py-0 text-[9px]"
              >
                最高
              </Badge>
            </span>
            <div
              class="holo-bar h-[5px]"
              :style="{ '--tone': toneVar(quotaTone(w.usedPct)) }"
            >
              <div
                class="holo-bar-fill"
                :style="{ width: barWidth(w.usedPct) }"
              />
            </div>
            <span
              class="text-right font-semibold tabular-nums"
              :style="{ color: toneVar(quotaTone(w.usedPct)) }"
            >
              {{ w.usedPct === null ? '—' : Math.round(w.usedPct) + '%' }}
            </span>
            <span class="text-right text-[10.5px] text-muted-foreground tabular-nums">
              {{ fmtResetIn(w.resetAt) }}
            </span>
          </div>
        </div>
      </template>

      <!-- 无数据占位 -->
      <div v-else class="mt-3.5">
        <div class="holo-num is-empty tabular-nums">—</div>
        <div class="mt-1 text-[11px] text-muted-foreground">
          配额状态未知 · 点击「刷新」立即获取
        </div>
        <div class="holo-bar mt-2.5">
          <div class="holo-bar-fill" style="width: 0%" />
        </div>
      </div>

      <!-- 错误提示 -->
      <div v-if="sub.lastError" class="holo-error">
        {{ sub.lastError }}
      </div>

      <footer
        class="mt-auto flex items-center justify-between gap-2 border-t border-dashed border-border/70 pt-2.5 text-[11px] text-muted-foreground"
      >
        <span>上次刷新 {{ fmtRelative(sub.lastRefreshAt) }}</span>
        <Badge v-if="!sub.enabled" variant="warning">已停用</Badge>
      </footer>
    </div>
  </div>
</template>

<style scoped>
/* 让 --foil-rot 能被 CSS 动画插值（Chromium 支持；不支持时退化为静态角度） */
@property --foil-rot {
  syntax: '<angle>';
  initial-value: 0deg;
  inherits: false;
}

.holo-card {
  --mx: 50%;
  --my: 0%;
  --rot-x: 0deg;
  --rot-y: 0deg;
  --accent: #64748b;
  --tone: var(--muted-foreground);

  position: relative;
  isolation: isolate;
  border-radius: 16px;
  /* 自身 3D：perspective() 写在 transform 里（perspective 属性只作用于子元素，管不到自己） */
  perspective: 900px;
  transform-style: preserve-3d;
  transform: perspective(900px) rotateX(var(--rot-x)) rotateY(var(--rot-y))
    scale(var(--holo-scale, 1));
  transition:
    transform 0.35s cubic-bezier(0.22, 1, 0.36, 1),
    box-shadow 0.35s ease;
  box-shadow:
    0 1px 2px rgb(0 0 0 / 0.06),
    0 10px 24px -14px rgb(0 0 0 / 0.28);
}

.holo-card:hover {
  --holo-scale: 1.014;
  box-shadow:
    0 2px 4px rgb(0 0 0 / 0.06),
    0 26px 50px -22px color-mix(in srgb, var(--accent) 55%, transparent),
    0 0 0 1px color-mix(in srgb, var(--accent) 22%, transparent);
}

.holo-layers {
  position: absolute;
  inset: 0;
  border-radius: inherit;
  overflow: hidden;
  pointer-events: none;
}

.holo-layers > * {
  position: absolute;
  inset: 0;
  border-radius: inherit;
  pointer-events: none;
}

/* 1. 玻璃底 + 跟随指针的 accent 光晕 */
.holo-base {
  background:
    radial-gradient(
      120% 100% at var(--mx) var(--my),
      color-mix(in srgb, var(--accent) 26%, transparent),
      transparent 62%
    ),
    linear-gradient(
      160deg,
      color-mix(in srgb, var(--accent) 13%, var(--card)),
      var(--card) 58%
    );
}

/* 2. HUD 细网格 */
.holo-grid {
  background-image:
    linear-gradient(
      to right,
      color-mix(in srgb, var(--accent) 26%, transparent) 1px,
      transparent 1px
    ),
    linear-gradient(
      to bottom,
      color-mix(in srgb, var(--accent) 26%, transparent) 1px,
      transparent 1px
    );
  background-size: 24px 24px;
  mask-image: radial-gradient(120% 80% at 50% 0%, #000 10%, transparent 72%);
  opacity: 0.35;
}

/* 3. 虹彩箔：随指针偏移 + 缓慢自转 */
.holo-foil {
  background: conic-gradient(
    from calc(var(--foil-rot) + 40deg) at var(--mx) var(--my),
    #ff2d95,
    #7c3aed,
    #06b6d4,
    #10b981,
    #f59e0b,
    #ff2d95
  );
  filter: blur(26px) saturate(190%);
  mix-blend-mode: soft-light;
  opacity: 0.5;
  /* 20s 转一圈，但用 steps 切成 48 帧：慢速自转下肉眼几乎看不出跳帧，
     却把「模糊 conic-gradient 每帧重绘」降到约 2.4 次/秒，多张卡片同屏也不掉帧 */
  animation: holo-spin 20s steps(48) infinite;
}

:root[data-theme='dark'] .holo-foil {
  mix-blend-mode: color-dodge;
  opacity: 0.26;
}

@keyframes holo-spin {
  to {
    --foil-rot: 360deg;
  }
}

/* 4. 镜面高光 */
.holo-glare {
  background: radial-gradient(
    farthest-corner circle at var(--mx) var(--my),
    rgb(255 255 255 / 0.7),
    rgb(255 255 255 / 0.12) 32%,
    transparent 52%
  );
  mix-blend-mode: overlay;
  opacity: 0.35;
  transition: opacity 0.3s ease;
}

.holo-card:hover .holo-glare {
  opacity: 0.75;
}

/* 5. 渐变描边（mask 挖空只留 1px） */
.holo-ring {
  padding: 1px;
  background: conic-gradient(
    from var(--foil-rot) at var(--mx) var(--my),
    color-mix(in srgb, var(--accent) 85%, transparent),
    #7c3aed,
    #06b6d4,
    var(--accent),
    color-mix(in srgb, var(--accent) 85%, transparent)
  );
  -webkit-mask:
    linear-gradient(#000 0 0) content-box,
    linear-gradient(#000 0 0);
  -webkit-mask-composite: xor;
  mask:
    linear-gradient(#000 0 0) content-box,
    linear-gradient(#000 0 0);
  mask-composite: exclude;
  opacity: 0.45;
  transition: opacity 0.3s ease;
}

.holo-card:hover .holo-ring {
  opacity: 1;
}

/* 6. 掠光：hover 时扫过一道白光 */
.holo-sheen {
  background: linear-gradient(
    105deg,
    transparent 34%,
    rgb(255 255 255 / 0.55) 47%,
    transparent 60%
  );
  transform: translateX(-130%);
  opacity: 0;
}

.holo-card:hover .holo-sheen {
  opacity: 1;
  animation: holo-sweep 1.05s cubic-bezier(0.22, 1, 0.36, 1) forwards;
}

@keyframes holo-sweep {
  from {
    transform: translateX(-130%);
  }
  to {
    transform: translateX(130%);
  }
}

/* 内容层：抬高产生景深 */
.holo-content {
  position: relative;
  display: flex;
  min-height: 224px;
  flex-direction: column;
  gap: 0;
  padding: 16px;
  transform: translateZ(26px);
  transform-style: preserve-3d;
}

/* Provider 头像：accent 渐变 + 内高光 + 外发光 */
.holo-avatar {
  position: relative;
  display: flex;
  size: 38px;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  border-radius: 11px;
  background: linear-gradient(
    145deg,
    var(--accent),
    color-mix(in srgb, var(--accent) 45%, #7c3aed)
  );
  box-shadow:
    0 6px 16px -6px var(--accent),
    inset 0 1px 0 rgb(255 255 255 / 0.45);
  color: #fff;
  font-size: 14px;
  font-weight: 700;
  letter-spacing: 0.02em;
  text-shadow: 0 1px 2px rgb(0 0 0 / 0.28);
}

.holo-avatar::before {
  content: '';
  position: absolute;
  inset: 0 0 50% 0;
  background: linear-gradient(
    180deg,
    rgb(255 255 255 / 0.42),
    rgb(255 255 255 / 0)
  );
}

.holo-avatar span {
  position: relative;
}

/* 状态胶囊 */
.holo-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border-radius: 9999px;
  border: 1px solid color-mix(in srgb, var(--foreground) 12%, transparent);
  background: color-mix(in srgb, var(--card) 45%, transparent);
  padding: 1px 8px 1px 6px;
  font-size: 10.5px;
  line-height: 16px;
  color: var(--muted-foreground);
  backdrop-filter: blur(6px);
}

.holo-chip.is-active {
  color: var(--success);
  border-color: color-mix(in srgb, var(--success) 35%, transparent);
}
.holo-chip.is-stale {
  color: var(--warning);
  border-color: color-mix(in srgb, var(--warning) 35%, transparent);
}
.holo-chip.is-error {
  color: var(--destructive);
  border-color: color-mix(in srgb, var(--destructive) 40%, transparent);
}

.holo-dot {
  size: 6px;
  border-radius: 9999px;
  background: currentColor;
  box-shadow: 0 0 0 3px color-mix(in srgb, currentColor 22%, transparent);
}

/* 虹彩分隔线 */
.holo-line {
  margin-top: 13px;
  height: 1px;
  border-radius: 9999px;
  background: linear-gradient(
    90deg,
    transparent,
    color-mix(in srgb, var(--accent) 70%, transparent) 18%,
    #a855f7 42%,
    #06b6d4 68%,
    transparent
  );
  opacity: 0.55;
}

/* 主数字：渐变文字 + 同色泛光 */
.holo-num {
  font-size: 34px;
  font-weight: 700;
  line-height: 1.05;
  letter-spacing: -0.02em;
  background: linear-gradient(
    172deg,
    var(--tone),
    color-mix(in srgb, var(--tone) 52%, var(--card))
  );
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  filter: drop-shadow(
    0 3px 12px color-mix(in srgb, var(--tone) 38%, transparent)
  );
}

.holo-num.is-empty {
  --tone: var(--muted-foreground);
  opacity: 0.55;
}

/* 进度条 */
.holo-bar {
  position: relative;
  height: 8px;
  width: 100%;
  overflow: hidden;
  border-radius: 9999px;
  background: color-mix(in srgb, var(--foreground) 10%, transparent);
  box-shadow: inset 0 1px 2px rgb(0 0 0 / 0.18);
}

.holo-bar-fill {
  position: relative;
  height: 100%;
  overflow: hidden;
  border-radius: 9999px;
  background: linear-gradient(
    90deg,
    color-mix(in srgb, var(--tone) 92%, #000 8%),
    var(--tone) 52%,
    color-mix(in srgb, var(--tone) 62%, #fff 38%)
  );
  box-shadow: 0 0 12px -2px var(--tone);
  transition: width 0.5s cubic-bezier(0.22, 1, 0.36, 1);
}

/* 流动斜纹 */
.holo-bar-fill::after {
  content: '';
  position: absolute;
  inset: 0;
  background: repeating-linear-gradient(
    115deg,
    transparent 0 9px,
    rgb(255 255 255 / 0.3) 9px 15px
  );
  animation: holo-stripes 1.3s linear infinite;
}

@keyframes holo-stripes {
  to {
    background-position: 24px 0;
  }
}

/* 高亮头部 */
.holo-bar-fill::before {
  content: '';
  position: absolute;
  top: 50%;
  right: 0;
  size: 7px;
  translate: 0 -50%;
  border-radius: 9999px;
  background: #fff;
  opacity: 0.85;
  box-shadow: 0 0 8px 2px var(--tone);
}

/* 错误条 */
.holo-error {
  margin-top: 10px;
  border-radius: 8px;
  border: 1px solid color-mix(in srgb, var(--destructive) 42%, transparent);
  background: color-mix(in srgb, var(--destructive) 12%, transparent);
  padding: 6px 8px;
  font-size: 11px;
  line-height: 1.5;
  color: var(--destructive);
}

/* 悬浮操作按钮 */
.holo-action {
  border-radius: 8px;
  color: var(--muted-foreground);
  backdrop-filter: blur(6px);
}

.holo-action:hover {
  background: color-mix(in srgb, var(--card) 70%, transparent);
  color: var(--foreground);
}

.holo-action.is-danger:hover {
  color: var(--destructive);
}

/* 尊重系统减弱动效：关掉倾斜与所有装饰动画 */
@media (prefers-reduced-motion: reduce) {
  .holo-card {
    transform: none;
    transition: box-shadow 0.2s ease;
  }
  .holo-content {
    transform: none;
  }
  .holo-foil,
  .holo-bar-fill::after,
  .holo-sheen {
    animation: none;
  }
  .holo-sheen {
    opacity: 0;
  }
}
</style>
