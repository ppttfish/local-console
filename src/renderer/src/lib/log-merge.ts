/**
 * 日志窗口增量合并（纯函数，无 Vue 依赖，便于独立验证）。
 *
 * 渲染端每次拿到的都是「最近 tail 行」的文本窗口。绝大多数轮询周期里，
 * 新窗口就是旧窗口后面追加了几行（文件在增长、窗口还没滑动）。此时只把
 * 新增行拼在旧行后面，Vue 按 idx 复用 key 时只会插入新节点，不会因为
 * 窗口整体下移而把 1000 个文本节点全部重写一遍。
 *
 * 其余情况（窗口滑动 / 日志轮转 / 行数切换 / 首次读取）整体替换，
 * 保证内容永远与服务端窗口一致。
 *
 * 注意：服务端文本以 \n 结尾时，split 会多出一个末尾空元素（“幽灵行”）。
 * 这里统一去掉它——否则增量追加时旧窗口尾部和“幽灵行”错位，会在新旧内容
 * 之间插入空白行。顺带状态行的行数也变成真实日志行数。
 */

export interface LogWindow {
  /** 渲染用的行（最多 tail 行，不含结尾幽灵空行） */
  lines: string[]
  /** 上次窗口的原始文本（已去掉结尾 \n），用作「纯追加」判断依据 */
  text: string
}

export interface MergeResult {
  window: LogWindow
  /** true = 纯追加，UI 只需追加新行 */
  appended: boolean
}

export function mergeLogWindow(
  prev: LogWindow | null,
  text: string,
  tail: number
): MergeResult {
  const n = Number.isFinite(tail) && tail > 0 ? Math.min(Math.floor(tail), 20000) : 300
  const raw = text ? text.split('\n') : []
  // 去掉文件结尾换行符产生的幽灵空行
  if (raw.length > 0 && raw[raw.length - 1] === '') raw.pop()
  const newLines = raw

  const pureAppend =
    prev !== null &&
    prev.text.length > 0 &&
    text.length > prev.text.length &&
    text.startsWith(prev.text) &&
    newLines.length > prev.lines.length

  if (pureAppend) {
    const merged = prev.lines.concat(newLines.slice(prev.lines.length)).slice(-n)
    return { window: { lines: merged, text: merged.join('\n') }, appended: true }
  }

  const lines = newLines.slice(-n)
  return { window: { lines, text: lines.join('\n') }, appended: false }
}