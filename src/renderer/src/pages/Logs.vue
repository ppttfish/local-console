<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch, computed } from 'vue'
import { useAppStore } from '../stores/app'

const store = useAppStore()
const selectedId = ref<string | null>(null)
const lines = ref<string[]>([])
const tail = ref(300)
const autoScroll = ref(true)
const logEl = ref<HTMLElement | null>(null)
let pollTimer: ReturnType<typeof setInterval> | null = null

const selected = computed(() =>
  store.services.find((s) => s.id === selectedId.value)
)

onMounted(() => {
  if (store.services.length > 0) selectedId.value = store.services[0]!.id
  pollTimer = setInterval(refresh, 2000)
})
onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer)
})

watch(selectedId, () => refresh())

async function refresh() {
  if (!selectedId.value) {
    lines.value = []
    return
  }
  const r = (await store.getLogs(selectedId.value, tail.value)) as { text: string }
  lines.value = r.text ? r.text.split('\n') : []
  if (autoScroll.value) {
    setTimeout(() => {
      if (logEl.value) logEl.value.scrollTop = logEl.value.scrollHeight
    }, 0)
  }
}

async function clear() {
  if (!selectedId.value) return
  if (!confirm('确认清空该服务的所有日志？')) return
  await store.clearLogs(selectedId.value)
  lines.value = []
}
</script>

<template>
  <div class="logs">
    <header class="page-header">
      <div>
        <h1>日志中心</h1>
        <p class="muted">查看服务的运行日志</p>
      </div>
    </header>

    <div class="layout">
      <aside class="list">
        <div
          v-for="s in store.services"
          :key="s.id"
          class="item"
          :class="{ active: s.id === selectedId }"
          @click="selectedId = s.id"
        >
          <span class="tag" :class="s.status">{{ s.status }}</span>
          <span class="name">{{ s.name }}</span>
        </div>
        <div v-if="store.services.length === 0" class="muted center">
          暂无服务
        </div>
      </aside>

      <div class="viewer card" v-if="selected">
        <div class="bar">
          <span>{{ selected.name }} · :{{ selected.port ?? '—' }}</span>
          <span class="spacer" />
          <label class="auto">
            <input type="checkbox" v-model="autoScroll" /> 自动滚到底
          </label>
          <select v-model.number="tail" @change="refresh">
            <option :value="100">最近 100 行</option>
            <option :value="300">最近 300 行</option>
            <option :value="1000">最近 1000 行</option>
          </select>
          <button @click="refresh">刷新</button>
          <button class="danger" @click="clear">清空</button>
        </div>
        <pre ref="logEl" class="log">{{ lines.join('\n') }}</pre>
      </div>
      <div v-else class="card muted center">选择左侧服务查看日志</div>
    </div>
  </div>
</template>

<style scoped>
.logs {
  display: flex;
  flex-direction: column;
  gap: 16px;
  height: 100%;
}
.page-header h1 {
  margin: 0;
  font-size: 22px;
}
.page-header p {
  margin: 4px 0 0;
  font-size: 13px;
}
.layout {
  display: grid;
  grid-template-columns: 240px 1fr;
  gap: 14px;
  min-height: 0;
  flex: 1;
}
.list {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 8px;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
}
.item:hover {
  background: var(--hover);
}
.item.active {
  background: var(--accent-soft);
  color: var(--accent);
}
.viewer {
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: 0;
}
.bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
  font-size: 12px;
}
.spacer {
  flex: 1;
}
.auto {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--muted);
}
.log {
  flex: 1;
  margin: 0;
  padding: 14px;
  overflow: auto;
  font-family: 'Geist Mono', Consolas, monospace;
  font-size: 12px;
  line-height: 1.55;
  background: var(--bg-soft);
  white-space: pre-wrap;
  word-break: break-all;
}
.center {
  text-align: center;
  padding: 40px;
}
</style>
