<script setup lang="ts">
/**
 * 订阅监控 · 订阅卡片（简洁版）
 *
 * 之前全息卡片（3D 倾斜 + 虹彩箔 + 光晕 + 描边 + 扫光）在 GPU 弱加速环境
 * （远程/虚拟显示器）下首次合成会把窗口拖到“未响应”，且动画与文字清晰度互相打架，
 * 经确认整体降级为简单卡片：无 3D、无动画、无混合模式，信息架构与业务口径不变。
 *
 * 保留：Provider 头像（accent 渐变 38×38 正方形）、状态胶囊、主百分比（按 tone 着色）、
 *      进度条（tone 色）、各窗口明细、悬浮操作按钮。
 */
import { computed } from 'vue'
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
</script>

<template>
  <div class="sub-card group" :style="{ '--accent': accent, '--tone': toneColor }">
    <!-- 头部：Provider 标识 + 状态 + 悬浮操作 -->
    <header class="flex items-start gap-3">
      <div class="sub-avatar">
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
              'sub-chip shrink-0',
              status === 'active' && 'is-active',
              status === 'stale' && 'is-stale',
              status === 'error' && 'is-error'
            ]"
          >
            <i :class="['sub-dot', refreshing && 'animate-pulse']" />
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
          class="sub-action size-7"
          :disabled="refreshing || !sub.enabled"
          title="立即刷新"
          @click="emit('refresh', sub)"
        >
          <RotateCw :class="['size-3.5', refreshing && 'animate-spin']" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          class="sub-action size-7"
          title="编辑"
          @click="emit('edit', sub)"
        >
          <Pencil class="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          class="sub-action size-7 is-danger"
          title="删除"
          @click="emit('delete', sub)"
        >
          <Trash2 class="size-3.5" />
        </Button>
      </div>
    </header>

    <div class="sub-line" />

    <!-- 主体：主百分比 -->
    <template v-if="hasData">
      <div class="mt-3.5 flex items-end justify-between gap-3">
        <span class="sub-num tabular-nums">{{ pctText }}</span>
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

      <div class="sub-bar mt-2.5">
        <div class="sub-bar-fill" :style="{ width: barWidth(pct) }" />
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
            class="sub-bar h-[5px]"
            :style="{ '--tone': toneVar(quotaTone(w.usedPct)) }"
          >
            <div
              class="sub-bar-fill"
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
      <div class="sub-num is-empty tabular-nums">—</div>
      <div class="mt-1 text-[11px] text-muted-foreground">
        配额状态未知 · 点击「刷新」立即获取
      </div>
      <div class="sub-bar mt-2.5">
        <div class="sub-bar-fill" style="width: 0%" />
      </div>
    </div>

    <!-- 错误提示 -->
    <div v-if="sub.lastError" class="sub-error">
      {{ sub.lastError }}
    </div>

    <footer
      class="mt-auto flex items-center justify-between gap-2 border-t border-dashed border-border/70 pt-2.5 text-[11px] text-muted-foreground"
    >
      <span>上次刷新 {{ fmtRelative(sub.lastRefreshAt) }}</span>
      <Badge v-if="!sub.enabled" variant="warning">已停用</Badge>
    </footer>
  </div>
</template>

<style scoped>
.sub-card {
  --accent: #64748b;
  --tone: var(--muted-foreground);

  position: relative;
  display: flex;
  min-height: 224px;
  flex-direction: column;
  padding: 16px;
  border-radius: 12px;
  border: 1px solid color-mix(in srgb, var(--foreground) 10%, transparent);
  background: var(--card);
  box-shadow:
    0 1px 2px rgb(0 0 0 / 0.06),
    0 8px 20px -14px rgb(0 0 0 / 0.25);
  transition: box-shadow 0.2s ease, border-color 0.2s ease;
}

.sub-card:hover {
  border-color: color-mix(in srgb, var(--accent) 30%, transparent);
  box-shadow:
    0 2px 4px rgb(0 0 0 / 0.06),
    0 16px 32px -18px color-mix(in srgb, var(--accent) 40%, transparent);
}

/* Provider 头像：accent 渐变 38×38 正方形 */
.sub-avatar {
  position: relative;
  display: flex;
  width: 38px;
  height: 38px;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  border-radius: 8px;
  background: linear-gradient(
    145deg,
    var(--accent),
    color-mix(in srgb, var(--accent) 45%, #7c3aed)
  );
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 0.35);
  color: #fff;
  font-size: 14px;
  font-weight: 700;
  letter-spacing: 0.02em;
}

.sub-avatar::before {
  content: '';
  position: absolute;
  inset: 0 0 50% 0;
  background: linear-gradient(
    180deg,
    rgb(255 255 255 / 0.35),
    rgb(255 255 255 / 0)
  );
}

.sub-avatar span {
  position: relative;
}

/* 状态胶囊 */
.sub-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border-radius: 9999px;
  border: 1px solid color-mix(in srgb, var(--foreground) 12%, transparent);
  background: color-mix(in srgb, var(--card) 60%, transparent);
  padding: 1px 8px 1px 6px;
  font-size: 10.5px;
  line-height: 16px;
  color: var(--muted-foreground);
}

.sub-chip.is-active {
  color: var(--success);
  border-color: color-mix(in srgb, var(--success) 35%, transparent);
}
.sub-chip.is-stale {
  color: var(--warning);
  border-color: color-mix(in srgb, var(--warning) 35%, transparent);
}
.sub-chip.is-error {
  color: var(--destructive);
  border-color: color-mix(in srgb, var(--destructive) 40%, transparent);
}

.sub-dot {
  width: 6px;
  height: 6px;
  border-radius: 9999px;
  background: currentColor;
  box-shadow: 0 0 0 3px color-mix(in srgb, currentColor 22%, transparent);
}

/* 分隔线 */
.sub-line {
  margin-top: 13px;
  height: 1px;
  border-radius: 9999px;
  background: linear-gradient(
    90deg,
    transparent,
    color-mix(in srgb, var(--accent) 45%, transparent) 30%,
    color-mix(in srgb, var(--accent) 45%, transparent) 70%,
    transparent
  );
  opacity: 0.45;
}

/* 主数字：按 tone 着色，纯色渲染最稳 */
.sub-num {
  font-size: 34px;
  font-weight: 700;
  line-height: 1.05;
  letter-spacing: -0.02em;
  color: var(--tone);
}

.sub-num.is-empty {
  --tone: var(--muted-foreground);
  opacity: 0.55;
}

/* 进度条 */
.sub-bar {
  position: relative;
  height: 8px;
  width: 100%;
  overflow: hidden;
  border-radius: 9999px;
  background: color-mix(in srgb, var(--foreground) 10%, transparent);
  box-shadow: inset 0 1px 2px rgb(0 0 0 / 0.12);
}

.sub-bar-fill {
  position: relative;
  height: 100%;
  overflow: hidden;
  border-radius: 9999px;
  background: var(--tone);
  transition: width 0.3s ease;
}

/* 错误条 */
.sub-error {
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
.sub-action {
  border-radius: 8px;
  color: var(--muted-foreground);
}

.sub-action:hover {
  background: color-mix(in srgb, var(--card) 70%, transparent);
  color: var(--foreground);
}

.sub-action.is-danger:hover {
  color: var(--destructive);
}
</style>