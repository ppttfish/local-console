/**
 * 主题管理 —— 亮色 / 暗色 / 跟随系统
 *  - 状态存 localStorage
 *  - 应用到 <html> 的 data-theme 属性
 *  - CSS 变量在 styles/globals.css
 */
import { ref, watchEffect } from 'vue'

export type ThemeMode = 'light' | 'dark' | 'auto'

const STORAGE_KEY = 'lcp.theme'
const mode = ref<ThemeMode>(loadMode())

function loadMode(): ThemeMode {
  try {
    const v = localStorage.getItem(STORAGE_KEY) as ThemeMode | null
    if (v === 'light' || v === 'dark' || v === 'auto') return v
  } catch {
    // SSR or no localStorage
  }
  return 'auto'
}

function saveMode(m: ThemeMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, m)
  } catch {
    // ignore
  }
}

function effectiveTheme(m: ThemeMode): 'light' | 'dark' {
  if (m === 'auto') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light'
  }
  return m
}

function applyTheme(t: 'light' | 'dark'): void {
  document.documentElement.setAttribute('data-theme', t)
}

// 系统主题变化监听：模块级只注册一次。
// 不能放在 useTheme() 的 onMounted 里——syncThemeModeAttribute 在组件外调用
// useTheme 时 onMounted 是无效调用（无组件实例），监听器会静默丢失。
if (typeof window !== 'undefined') {
  window
    .matchMedia('(prefers-color-scheme: dark)')
    .addEventListener('change', () => {
      if (mode.value === 'auto') applyTheme(effectiveTheme('auto'))
    })
}

export function useTheme() {
  watchEffect(() => {
    applyTheme(effectiveTheme(mode.value))
  })

  function setMode(m: ThemeMode): void {
    mode.value = m
    saveMode(m)
  }

  return {
    mode,
    setMode
  }
}
