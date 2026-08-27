/**
 * 中文习惯的数量/成本格式化 —— Usage 页与回顾面板共用
 */

const CNY_RATE = 7.16

export function fmtToken(n: number): string {
  if (n === 0) return '0'
  const abs = Math.abs(n)
  if (abs >= 1_000_000_000_000) return (n / 1_000_000_000_000).toFixed(2) + '万亿'
  if (abs >= 100_000_000) return (n / 100_000_000).toFixed(2) + '亿'
  if (abs >= 10_000) return (n / 10_000).toFixed(2) + '万'
  if (abs >= 1_000) return (n / 1_000).toFixed(1) + '千'
  return String(Math.round(n))
}

export function fmtTokenShort(n: number): string {
  const abs = Math.abs(n)
  if (abs >= 100_000_000) return (n / 100_000_000).toFixed(1) + '亿'
  if (abs >= 10_000) return (n / 10_000).toFixed(0) + '万'
  if (abs >= 1_000) return (n / 1_000).toFixed(0) + 'k'
  return String(Math.round(n))
}

export function fmtCost(v: number): string {
  if (v === 0) return '$0.00'
  if (v >= 1000) return '$' + (v / 1000).toFixed(2) + 'k'
  if (v >= 1) return '$' + v.toFixed(2)
  return '$' + v.toFixed(4)
}

export function fmtCny(v: number): string {
  if (v === 0) return '免费'
  return '约¥' + (v * CNY_RATE).toFixed(2)
}

export function fmtDate(ts: number | null | undefined): string {
  if (!ts) return '—'
  const d = new Date(ts)
  const pad = (x: number) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
