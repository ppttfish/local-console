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
</style>
