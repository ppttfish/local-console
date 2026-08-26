<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { useAppStore } from '../stores/app'
import { useTheme } from '../composables/useTheme'

const route = useRoute()
const store = useAppStore()
const { mode, setMode } = useTheme()

const items = [
  { name: 'launchpad', label: '启动台', icon: '🚀' },
  { name: 'monitor', label: '服务监控', icon: '📊' },
  { name: 'usage', label: 'Token 用量', icon: '📈' },
  { name: 'logs', label: '日志中心', icon: '📜' },
  { name: 'settings', label: '设置', icon: '⚙️' }
]

const running = computed(() => store.runningServices.length)
const total = computed(() => store.services.length)
</script>

<template>
  <aside class="sidebar">
    <div class="brand">
      <div class="logo">⚡</div>
      <div class="title">
        <div class="name">本地总台</div>
        <div class="ver">v{{ store.appInfo?.version ?? '0.2.0' }}</div>
      </div>
    </div>

    <nav class="nav">
      <RouterLink
        v-for="i in items"
        :key="i.name"
        :to="{ name: i.name }"
        class="nav-item"
        :class="{ active: route.name === i.name }"
      >
        <span class="icon">{{ i.icon }}</span>
        <span class="label">{{ i.label }}</span>
      </RouterLink>
    </nav>

    <div class="theme-switch">
      <button
        :class="{ active: mode === 'light' }"
        @click="setMode('light')"
        title="亮色"
      >☀</button>
      <button
        :class="{ active: mode === 'dark' }"
        @click="setMode('dark')"
        title="暗色"
      >🌙</button>
      <button
        :class="{ active: mode === 'auto' }"
        @click="setMode('auto')"
        title="跟随系统"
      >⚙</button>
    </div>

    <div class="stats">
      <div class="stat">
        <div class="num">{{ running }}</div>
        <div class="lbl">运行中 / {{ total }}</div>
      </div>
      <div class="stat">
        <div class="num">{{ store.unmanagedPorts.length }}</div>
        <div class="lbl">未管理端口</div>
      </div>
    </div>
  </aside>
</template>

<style scoped>
.sidebar {
  background: var(--panel);
  border-right: 1px solid var(--border);
  padding: 20px 14px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 4px 6px;
}
.logo {
  font-size: 24px;
}
.title .name {
  font-weight: 600;
  font-size: 15px;
}
.title .ver {
  font-size: 11px;
  color: var(--muted);
}
.nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 6px;
  color: var(--text);
  text-decoration: none;
  font-size: 13px;
  transition: background 0.12s;
}
.nav-item:hover {
  background: var(--hover);
}
.nav-item.active {
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 500;
}
.icon {
  font-size: 15px;
  width: 20px;
  text-align: center;
}
.theme-switch {
  display: flex;
  background: var(--bg-soft);
  border-radius: 8px;
  padding: 4px;
  gap: 2px;
}
.theme-switch button {
  flex: 1;
  padding: 6px 0;
  border: none;
  background: transparent;
  font-size: 14px;
  border-radius: 6px;
  cursor: pointer;
  color: var(--muted);
  transition: all 0.15s;
}
.theme-switch button:hover {
  background: var(--hover);
  color: var(--text);
}
.theme-switch button.active {
  background: var(--accent);
  color: white;
}
.stats {
  margin-top: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  background: var(--bg-soft);
  border-radius: 8px;
}
.stat {
  display: flex;
  align-items: baseline;
  gap: 6px;
}
.num {
  font-size: 18px;
  font-weight: 600;
  color: var(--accent);
}
.lbl {
  font-size: 11px;
  color: var(--muted);
}
</style>
