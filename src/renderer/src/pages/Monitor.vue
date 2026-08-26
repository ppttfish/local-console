<script setup lang="ts">
import { computed } from 'vue'
import { useAppStore } from '../stores/app'

const store = useAppStore()

const top = computed(() => {
  return [...store.ports].sort((a, b) => a.port - b.port).slice(0, 50)
})

function timeAgo(ts: number) {
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 60) return `${s} 秒前`
  return `${Math.floor(s / 60)} 分前`
}
</script>

<template>
  <div class="monitor">
    <header class="page-header">
      <div>
        <h1>服务监控</h1>
        <p class="muted">每 2 秒自动刷新 · 总 CPU {{ store.totalCpu.toFixed(1) }}% · 内存 {{ store.totalMem.toFixed(1) }}%</p>
      </div>
    </header>

    <div class="grid">
      <div class="card kpi">
        <div class="kpi-num">{{ store.runningServices.length }}</div>
        <div class="kpi-lbl">运行中 / {{ store.services.length }}</div>
      </div>
      <div class="card kpi">
        <div class="kpi-num">{{ store.unmanagedPorts.length }}</div>
        <div class="kpi-lbl">未纳管端口</div>
      </div>
      <div class="card kpi">
        <div class="kpi-num">{{ store.ports.length }}</div>
        <div class="kpi-lbl">总监听端口</div>
      </div>
    </div>

    <div class="card">
      <h3>端口占用（TOP 50）</h3>
      <table class="ports">
        <thead>
          <tr>
            <th>端口</th>
            <th>进程</th>
            <th>PID</th>
            <th>应用</th>
            <th>命令</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="p in top" :key="`${p.pid}:${p.port}`">
            <td class="mono">:{{ p.port }}</td>
            <td>{{ p.process_name }}</td>
            <td class="mono">{{ p.pid }}</td>
            <td>
              <span v-if="p.app_id" class="tag running">已纳管 · {{ p.app_name }}</span>
              <span v-else class="muted">—</span>
            </td>
            <td class="cmd" :title="p.cmd">{{ p.cmd || '—' }}</td>
          </tr>
          <tr v-if="top.length === 0">
            <td colspan="5" class="muted center">暂无监听端口</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.monitor {
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.page-header h1 {
  margin: 0;
  font-size: 22px;
}
.page-header p {
  margin: 4px 0 0;
  font-size: 13px;
}
.grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 14px;
}
.kpi {
  text-align: center;
}
.kpi-num {
  font-size: 32px;
  font-weight: 600;
  color: var(--accent);
}
.kpi-lbl {
  color: var(--muted);
  font-size: 12px;
  margin-top: 2px;
}
table.ports {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
  margin-top: 8px;
}
.ports th,
.ports td {
  text-align: left;
  padding: 6px 8px;
  border-bottom: 1px solid var(--border);
}
.ports th {
  color: var(--muted);
  font-weight: 500;
  font-size: 11px;
  text-transform: uppercase;
}
.mono {
  font-family: 'Geist Mono', Consolas, monospace;
  font-size: 12px;
}
.cmd {
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.center {
  text-align: center;
  padding: 30px;
}
h3 {
  margin: 0 0 4px;
  font-size: 14px;
}
</style>
