<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import { useAppStore } from './stores/app'
import Sidebar from './components/Sidebar.vue'

const store = useAppStore()
let unsub: (() => void) | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null

onMounted(async () => {
  await store.bootstrap()
  unsub = window.lcp.onStateChanged((s) => store.applyState(s))
  // 主进程没主动推送数据，每 2 秒轮询拉一次
  pollTimer = setInterval(() => {
    void store.refresh()
  }, 2000)
})

onUnmounted(() => {
  unsub?.()
  if (pollTimer) clearInterval(pollTimer)
})
</script>

<template>
  <div class="layout">
    <Sidebar />
    <main class="main">
      <RouterView />
    </main>
  </div>

  <!-- 全局操作通知 -->
  <div class="toasts">
    <div v-for="t in store.toasts" :key="t.id" class="toast" :class="t.kind">
      {{ t.text }}
    </div>
  </div>
</template>

<style scoped>
.layout {
  display: grid;
  grid-template-columns: 220px 1fr;
  height: 100vh;
  background: var(--bg);
  color: var(--text);
}
.main {
  overflow: auto;
  padding: 24px;
}
.toasts {
  position: fixed;
  right: 20px;
  bottom: 20px;
  z-index: 300;
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-width: 440px;
}
.toast {
  background: var(--card);
  border: 1px solid var(--border);
  border-left: 3px solid var(--muted);
  border-radius: 8px;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.14);
  padding: 10px 14px;
  font-size: 12.5px;
  line-height: 1.5;
  word-break: break-all;
}
.toast.error {
  border-left-color: var(--danger);
}
.toast.success {
  border-left-color: var(--success);
}
</style>
