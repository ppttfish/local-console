/**
 * Chart.js 主题工具：跟随 [data-theme="dark"] 切配色
 *  - 浅色：纯白底 + 浅灰网格 + 主色 #0ea5e9
 *  - 暗色：透明（图表放卡片里继承深色背景） + 深灰网格 + 主色 #38bdf8
 *  - 切换主题时调用 applyChartTheme(chart) 让所有 Chart 实例重读色
 */
import type { Chart as ChartJS, ChartOptions } from 'chart.js'

export interface ChartTheme {
  text: string
  textMuted: string
  grid: string
  border: string
  /** 画布用透明继承卡片底色；surface 是实底色（--card），给 tooltip 文字等需要实色的地方用 */
  background: string
  surface: string
  primary: string
  warning: string
  success: string
  danger: string
}

export function getTheme(): 'light' | 'dark' {
  if (typeof document === 'undefined') return 'light'
  const t = document.documentElement.getAttribute('data-theme')
  if (t === 'dark') return 'dark'
  // auto 模式：跟随系统
  if (typeof window !== 'undefined' && window.matchMedia) {
    return window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light'
  }
  return 'light'
}

export function readCssVar(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim()
  return v || fallback
}

export function getChartTheme(): ChartTheme {
  const dark = getTheme() === 'dark'
  if (dark) {
    return {
      text: readCssVar('--foreground', '#e2e8f0'),
      textMuted: readCssVar('--muted-foreground', '#94a3b8'),
      grid: readCssVar('--border', '#1f2937'),
      border: readCssVar('--border', '#1f2937'),
      background: 'transparent',
      surface: readCssVar('--card', '#111827'),
      primary: readCssVar('--primary', '#38bdf8'),
      warning: readCssVar('--warning', '#fbbf24'),
      success: readCssVar('--success', '#34d399'),
      danger: readCssVar('--destructive', '#f87171')
    }
  }
  return {
    text: readCssVar('--foreground', '#0f172a'),
    textMuted: readCssVar('--muted-foreground', '#64748b'),
    grid: readCssVar('--border', '#e2e8f0'),
    border: readCssVar('--border', '#e2e8f0'),
    background: 'transparent',
    surface: readCssVar('--card', '#ffffff'),
    primary: readCssVar('--primary', '#0ea5e9'),
    warning: readCssVar('--warning', '#f59e0b'),
    success: readCssVar('--success', '#10b981'),
    danger: readCssVar('--destructive', '#ef4444')
  }
}

/** 浅 / 深色都用的 axis 通用样式 */
export function buildAxisOptions(t: ChartTheme) {
  return {
    ticks: {
      color: t.textMuted,
      font: { size: 10.5 }
    },
    grid: { color: t.grid, drawTicks: false },
    border: { color: t.border }
  }
}

/** 通用 legend 样式 */
export function buildLegendOptions(t: ChartTheme) {
  return {
    color: t.text,
    font: { size: 11.5 },
    labels: { color: t.text, usePointStyle: true, boxWidth: 6, boxHeight: 6 }
  }
}

/** 通用 tooltip 样式：底色取文字色的反色（inverted），文字必须用实底色，transparent 会导致字看不见 */
export function buildTooltipOptions(t: ChartTheme) {
  return {
    backgroundColor: t.text,
    titleColor: t.surface,
    bodyColor: t.surface,
    borderWidth: 0,
    padding: 8,
    cornerRadius: 6,
    displayColors: true,
    titleFont: { size: 11.5, weight: 'bold' as const },
    bodyFont: { size: 11 }
  }
}

/**
 * 订阅 data-theme 变化，调用 onChange 让所有图表重读
 */
export function watchTheme(onChange: (theme: 'light' | 'dark') => void): () => void {
  if (typeof document === 'undefined') return () => {}
  const obs = new MutationObserver(() => {
    onChange(getTheme())
  })
  obs.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme', 'data-mode']
  })
  // 监听系统色
  const mq = window.matchMedia?.('(prefers-color-scheme: dark)')
  const onMq = () => onChange(getTheme())
  mq?.addEventListener('change', onMq)
  return () => {
    obs.disconnect()
    mq?.removeEventListener('change', onMq)
  }
}

/** 让单个 chart 重读主题并 update */
export function refreshChartTheme(chart: ChartJS): void {
  const t = getChartTheme()
  const opts = chart.options
  if (opts.scales) {
    for (const k of Object.keys(opts.scales)) {
      const s = (opts.scales as Record<string, { ticks?: unknown; grid?: unknown; border?: unknown }>)[k]!
      const ax = buildAxisOptions(t) as Record<string, unknown>
      s.ticks = { ...(s.ticks as object), ...(ax.ticks as object) }
      s.grid = { ...(s.grid as object), ...(ax.grid as object) }
      s.border = { ...(s.border as object), ...(ax.border as object) }
    }
  }
  if (opts.plugins?.legend) {
    Object.assign(opts.plugins.legend, buildLegendOptions(t))
  }
  if (opts.plugins?.tooltip) {
    Object.assign(opts.plugins.tooltip, buildTooltipOptions(t))
  }
  chart.update('none')
}
