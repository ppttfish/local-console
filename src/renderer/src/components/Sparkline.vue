<script setup lang="ts">
/**
 * 极简 sparkline：纯 SVG，零依赖
 *  - data: 数值数组
 *  - tone: 跟随主题 (primary / success / warning / danger / muted)
 *  - height: 高度（px），宽度填满父容器
 *  - 无 tooltip、无坐标轴；只画线 + 可选末端点
 */
import { computed } from 'vue'
import { cn } from '@/lib/utils'

const props = withDefaults(
  defineProps<{
    data: number[]
    tone?: 'primary' | 'success' | 'warning' | 'danger' | 'muted'
    height?: number
    showArea?: boolean
    showDot?: boolean
    class?: string
  }>(),
  { height: 28, showArea: true, showDot: false, tone: 'primary' }
)

const toneClass = computed(() => {
  switch (props.tone) {
    case 'primary':
      return 'stroke-primary'
    case 'success':
      return 'stroke-success'
    case 'warning':
      return 'stroke-warning'
    case 'danger':
      return 'stroke-destructive'
    case 'muted':
      return 'stroke-muted-foreground'
  }
})
const fillClass = computed(() => {
  switch (props.tone) {
    case 'primary':
      return 'fill-primary/15'
    case 'success':
      return 'fill-success/15'
    case 'warning':
      return 'fill-warning/15'
    case 'danger':
      return 'fill-destructive/15'
    case 'muted':
      return 'fill-muted-foreground/10'
  }
})

const path = computed(() => {
  const d = props.data.filter((n) => Number.isFinite(n))
  if (d.length < 2) return { line: '', area: '' }
  const max = Math.max(...d)
  const min = Math.min(...d)
  const range = max - min || 1
  const w = 100 // viewBox width; preserveAspectRatio none
  const h = 100 // viewBox height
  const step = w / (d.length - 1)
  const points = d.map((v, i) => {
    const x = i * step
    const y = h - ((v - min) / range) * h
    return [x, y] as const
  })
  const line = points
    .map(([x, y], i) => (i === 0 ? `M${x.toFixed(2)},${y.toFixed(2)}` : `L${x.toFixed(2)},${y.toFixed(2)}`))
    .join(' ')
  const area =
    `M0,${h} ` +
    points
      .map(([x, y]) => `L${x.toFixed(2)},${y.toFixed(2)}`)
      .join(' ') +
    ` L${w},${h} Z`
  const last = points[points.length - 1]!
  return { line, area, lastX: last[0], lastY: last[1] }
})
</script>

<template>
  <svg
    v-if="path.line"
    :class="cn('block w-full', props.class)"
    :style="{ height: `${height}px` }"
    viewBox="0 0 100 100"
    preserveAspectRatio="none"
  >
    <path
      v-if="showArea"
      :d="path.area"
      :class="fillClass"
    />
    <path
      :d="path.line"
      :class="toneClass"
      fill="none"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      vector-effect="non-scaling-stroke"
    />
    <circle
      v-if="showDot"
      :cx="path.lastX"
      :cy="path.lastY"
      r="2.4"
      :class="toneClass"
      stroke="none"
    />
  </svg>
</template>
