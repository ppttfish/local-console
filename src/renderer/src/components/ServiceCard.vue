<script setup lang="ts">
import { computed } from 'vue'
import type { ServiceState } from '@shared/types'

const props = defineProps<{ service: ServiceState }>()
const emit = defineEmits<{
  start: []
  stop: []
  restart: []
  delete: []
}>()

const statusLabel = computed(() => {
  const map: Record<typeof props.service.status, string> = {
    running: '运行中',
    stopped: '已停止',
    starting: '启动中',
    stopping: '停止中',
    failed: '失败'
  }
  return map[props.service.status]
})

// 从端口接管的条目：本控制台没有 ServiceManager 实例在跑它，
// 但它的端口仍被外部进程占着。状态如实显示 stopped/failed，并给个提示。
const isAdoptedExternal = computed(
  () =>
    (props.service.status === 'stopped' || props.service.status === 'failed') &&
    props.service.pid === null
)

const uptimeText = computed(() => {
  if (props.service.status !== 'running') return ''
  const s = props.service.uptime_sec
  if (s < 60) return `${s} 秒`
  if (s < 3600) return `${Math.floor(s / 60)} 分 ${s % 60} 秒`
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return `${h} 时 ${m} 分`
})

function confirmDelete() {
  if (confirm(`确认删除「${props.service.name}」？\n（不会影响外部已在运行的进程）`)) {
    emit('delete')
  }
}
</script>

<template>
  <div class="card svc">
    <div class="head">
      <div class="name" :style="{ color: service.color || undefined }">
        {{ service.name }}
      </div>
      <span class="tag" :class="service.status">{{ statusLabel }}</span>
    </div>

    <div class="meta">
      <div class="row" v-if="service.port">
        <span class="muted">端口</span>
        <span>:{{ service.port }}</span>
        <span v-if="service.listening" class="muted">· 已监听</span>
      </div>
      <div class="row">
        <span class="muted">命令</span>
        <code>{{ service.command }}</code>
      </div>
      <div class="row">
        <span class="muted">工作区</span>
        <code class="cwd">{{ service.cwd }}</code>
      </div>
      <div class="row" v-if="service.status === 'running' && service.pid">
        <span class="muted">PID {{ service.pid }} · 已运行 {{ uptimeText }}</span>
      </div>
    </div>

    <div v-if="isAdoptedExternal" class="hint">
      此条目从外部端口接管，本控制台未运行它。点「启动」会用上面的命令
      在「工作区」里拉起一个新进程。
    </div>

    <div class="ops">
      <button
        v-if="service.status === 'stopped' || service.status === 'failed'"
        class="primary"
        @click="emit('start')"
      >
        启动
      </button>
      <button
        v-else-if="service.status === 'running'"
        @click="emit('stop')"
      >
        停止
      </button>
      <button
        v-else
        disabled
      >
        {{ service.status === 'starting' ? '启动中…' : '停止中…' }}
      </button>

      <button
        :disabled="service.status !== 'running'"
        :title="
          service.status === 'running'
            ? '先停止再启动'
            : '请先启动，再使用重启'
        "
        @click="emit('restart')"
      >
        重启
      </button>

      <span class="spacer" />

      <button class="danger" @click="confirmDelete">删除</button>
    </div>
  </div>
</template>

<style scoped>
.svc {
  display: flex;
  flex-direction: column;
  gap: 12px;
  transition: transform 0.1s;
}
.svc:hover {
  transform: translateY(-1px);
}
.head {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.name {
  font-weight: 600;
  font-size: 15px;
}
.meta {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
}
.row {
  display: flex;
  gap: 8px;
  align-items: baseline;
  line-height: 1.5;
}
.row > .muted:first-child {
  flex: 0 0 auto;
  min-width: 3.5em;
  color: var(--muted);
  font-size: 11.5px;
}
.row code {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}


.hint {
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--muted);
  background: var(--bg-soft);
  border-left: 2px solid var(--warn);
  padding: 6px 8px;
  border-radius: 3px;
}

code {
  font-family: 'Geist Mono', 'Cascadia Code', Consolas, monospace;
  font-size: 11.5px;
  background: var(--bg-soft);
  padding: 1px 6px;
  border-radius: 4px;
}
code.cwd {
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  direction: rtl;
  text-align: left;
}
.ops {
  display: flex;
  gap: 6px;
  align-items: center;
  margin-top: 4px;
}
.spacer {
  flex: 1;
}
</style>
