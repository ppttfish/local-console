<script setup lang="ts">
import { computed } from 'vue'
import type { ServiceState } from '@shared/types'

const props = defineProps<{ service: ServiceState }>()
const emit = defineEmits<{
  start: []
  stop: []
  restart: []
  stopExternal: []
  restartExternal: []
  edit: []
  delete: []
}>()

/** 端口被外部进程占用（非本台托管）：真实的"外部接管运行中" */
const isExternalRunning = computed(
  () =>
    props.service.pid === null &&
    props.service.listening &&
    props.service.port_occupied_pid !== null
)

const statusLabel = computed(() => {
  if (isExternalRunning.value) return '外部运行中'
  const map: Record<typeof props.service.status, string> = {
    running: '运行中',
    stopped: '已停止',
    starting: '启动中',
    stopping: '停止中',
    failed: '失败'
  }
  return map[props.service.status]
})
const tagClass = computed(() =>
  isExternalRunning.value ? 'running' : props.service.status
)

const externalDesc = computed(() => {
  if (!isExternalRunning.value) return ''
  const name = props.service.port_process_name || '未知进程'
  return `${name}（PID ${props.service.port_occupied_pid}）`
})

/** 接管时回填的进程命令行（引号开头的绝对路径 / pnpm store 路径），通常无法直接启动 */
const commandLooksBackfilled = computed(() => {
  const c = props.service.command || ''
  const first = c.trim().split(/\s+/)[0] ?? ''
  return /^["']/.test(first) || c.includes('.pnpm')
})

const uptimeText = computed(() => {
  if (props.service.status !== 'running') return ''
  const s = props.service.uptime_sec
  if (s < 60) return `${s} 秒`
  if (s < 3600) return `${Math.floor(s / 60)} 分 ${s % 60} 秒`
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return `${h} 时 ${m} 分`
})

function confirmStopExternal() {
  if (
    confirm(
      `结束占用端口 :${props.service.port} 的外部进程？\n${externalDesc.value}\n（这会终止该进程，之后可点「启动」由本台接管）`
    )
  ) {
    emit('stopExternal')
  }
}

function onRestart() {
  if (isExternalRunning.value) {
    if (
      confirm(
        `重启 = 结束外部进程 ${externalDesc.value}，\n然后用本台命令重新拉起「${props.service.name}」。继续？`
      )
    ) {
      emit('restartExternal')
    }
    return
  }
  emit('restart')
}

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
      <span class="tag" :class="tagClass">{{ statusLabel }}</span>
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
      <div class="row" v-else-if="isExternalRunning">
        <span class="muted">外部进程 {{ externalDesc }}</span>
      </div>
    </div>

    <div v-if="commandLooksBackfilled" class="hint">
      这条命令像是从运行中进程回填的完整命令行，无法照此启动。
      点「编辑」改成简短的可执行命令（如 <code>dsh web</code>），
      工作区换成固定目录后即可托管启动。
    </div>
    <div v-if="isExternalRunning" class="hint">
      端口正由外部进程占用（非本控制台启动）。可「结束进程」释放端口，
      或「重启」结束后用上面的命令接管。
    </div>

    <div class="ops">
      <button
        v-if="isExternalRunning"
        @click="confirmStopExternal"
      >
        结束进程
      </button>
      <button
        v-else-if="service.status === 'stopped' || service.status === 'failed'"
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
        :disabled="service.status !== 'running' && !isExternalRunning"
        :title="
          service.status === 'running' || isExternalRunning
            ? '先停止再启动'
            : '请先启动，再使用重启'
        "
        @click="onRestart"
      >
        {{ isExternalRunning ? '重启接管' : '重启' }}
      </button>

      <span class="spacer" />

      <button @click="emit('edit')">编辑</button>
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
