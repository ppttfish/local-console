/**
 * 把主题模式同步到 <html data-mode="light|dark|auto">。
 *  - useTheme.ts 写 data-theme=light|dark（effective 之后），不动。
 *  - 这里只额外加一个 data-mode 用来表达"原始三态"，给新 CSS（如 @custom-variant dark）的多态判定用。
 *  - 不影响老 CSS，老 CSS 继续读 data-theme。
 */
import { watchEffect } from 'vue'
import { useTheme } from './useTheme'

export function syncThemeModeAttribute(): void {
  const { mode } = useTheme()
  watchEffect(() => {
    document.documentElement.setAttribute('data-mode', mode.value)
  })
}
