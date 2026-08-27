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
  open: []
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
    starting: '启动中…',
    stopping: '停止中…',
    failed: '失败'
  }
  return map[props.service.status]
})

/** 状态点：外部=强调色，运行=绿晕，失败=红，过渡态=琥珀，其余灰 */
const dotClass = computed(() => {
  if (isExternalRunning.value) return 'external'
  if (props.service.status === 'running') return 'running'
  if (props.service.status === 'failed') return 'failed'
  if (props.service.status === 'starting' || props.service.status === 'stopping')
    return 'warn'
  return ''
})

/** 卡片边框状态色：运行绿调 / 外部蓝调 / 失败红调 */
const cardClass = computed(() => {
  if (isExternalRunning.value) return 'is-external'
  if (props.service.status === 'running') return 'is-running'
  if (props.service.status === 'failed') return 'is-failed'
  return ''
})

/** 端口 chip 是否可点开浏览器 */
const canOpen = computed(
  () =>
    !!props.service.port &&
    (props.service.listening || props.service.status === 'running')
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

/** 状态行右侧 mono 小字：托管显 PID+时长，外部显 PID */
const statusAside = computed(() => {
  if (props.service.status === 'running' && props.service.pid)
    return `PID ${props.service.pid} · ${uptimeText.value}`
  if (isExternalRunning.value)
    return `外部 PID ${props.service.port_occupied_pid}`
  return ''
})

const tileLetter = computed(
  () => [...(props.service.name || '?')][0]?.toUpperCase() ?? '?'
)
const tileColor = computed(
  () =>
    props.service.color ||
    (props.service.status === 'failed' ? 'var(--danger)' : 'var(--accent)')
)

const cmdTitle = computed(
  () => `命令：${props.service.command}\n工作区：${props.service.cwd}`
)

/** 接管时回填的进程命令行（引号开头的绝对路径 / pnpm store 路径），通常无法直接启动 */
const commandLooksBackfilled = computed(() => {
  const c = props.service.command || ''
  const first = c.trim().split(/\s+/)[0] ?? ''
  return /^["']/.test(first) || c.includes('.pnpm')
})

function confirmStopExternal() {
  if (
    confirm(
      `结束占用端口 :${props.service.port} 的外部进程？\n${props.service.port_process_name || '未知进程'}（PID ${props.service.port_occupied_pid}）\n（这会终止该进程，之后可点「启动」由本台接管）`
    )
  ) {
    emit('stopExternal')
  }
}

function onPrimary() {
  if (isExternalRunning.value) {
    if (
      confirm(
        `重启接管 = 结束外部进程 ${props.service.port_process_name || ''}（PID ${props.service.port_occupied_pid}），\n然后用本台命令重新拉起「${props.service.name}」。继续？`
      )
    ) {
      emit('restartExternal')
    }
    return
  }
  if (props.service.status === 'running') {
    emit('stop')
    return
  }
  if (props.service.status === 'stopped' || props.service.status === 'failed') {
    emit('start')
  }
}

function confirmDelete() {
  if (confirm(`确认删除「${props.service.name}」？\n（不会影响外部已在运行的进程）`)) {
    emit('delete')
  }
}
</script>

<template>
  <div class="svc" :class="cardClass">
    <!-- 头部：图标块 + 名称/状态 -->
    <div class="head">
      <div class="app-icon" :style="{ color: tileColor }">
        <span>{{ tileLetter }}</span>
      </div>
      <div class="meta">
        <div class="name" :title="service.name">{{ service.name }}</div>
        <div class="status">
          <span class="sdot" :class="dotClass" />
          <span class="st-text" :class="{ fail: service.status === 'failed' }">{{
            statusLabel
          }}</span>
          <button
            v-if="service.port && canOpen"
            class="st-port clickable"
            :title="`在浏览器打开 http://127.0.0.1:${service.port}`"
            @click="emit('open')"
          >
            :{{ service.port }}
          </button>
          <span v-else-if="service.port" class="st-port">:{{ service.port }}</span>
          <span v-if="statusAside" class="st-up">{{ statusAside }}</span>
        </div>
      </div>
    </div>

    <!-- 命令条（悬浮显命令+工作区） -->
    <div class="cmd" :title="cmdTitle">{{ service.command }}</div>

    <div v-if="commandLooksBackfilled" class="hint">
      这条命令像是从运行中进程回填的完整命令行，无法照此启动。点右侧
      ✎ 编辑，改成简短可执行命令（如 dsh web），工作区可留空。
    </div>
    <div v-else-if="isExternalRunning" class="hint">
      端口由外部进程占用（非本台启动）。「重启接管」会结束它并用上面的命令拉起。
    </div>

    <!-- 操作：主按钮 + 图标副操作 -->
    <div class="ops">
      <button
        v-if="isExternalRunning"
        class="btn-main primary"
        @click="onPrimary"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="6 3 20 12 6 21 6 3"/></svg>
        重启接管
      </button>
      <button
        v-else-if="service.status === 'running'"
        class="btn-main stop"
        @click="onPrimary"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>
        停止
      </button>
      <button
        v-else-if="service.status === 'stopped' || service.status === 'failed'"
        class="btn-main primary"
        @click="onPrimary"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="6 3 20 12 6 21 6 3"/></svg>
        启动
      </button>
      <button v-else class="btn-main" disabled>{{ statusLabel }}</button>

      <div class="sub">
        <button
          v-if="canOpen"
          class="ib"
          :title="`在浏览器打开 http://127.0.0.1:${service.port}`"
          @click="emit('open')"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>
        </button>
        <button
          v-if="service.status === 'running'"
          class="ib"
          title="重启"
          @click="emit('restart')"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><polyline points="21 3 21 9 15 9"/></svg>
        </button>
        <button
          v-if="isExternalRunning"
          class="ib danger"
          title="结束外部进程"
          @click="confirmStopExternal"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.77.04"/></svg>
        </button>
        <button class="ib" title="编辑" @click="emit('edit')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
        </button>
        <button class="ib danger" title="删除" @click="confirmDelete">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.svc {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 12px;
  box-shadow: var(--shadow);
  transition:
    transform 0.15s cubic-bezier(0.22, 1, 0.36, 1),
    box-shadow 0.15s,
    border-color 0.15s;
}
.svc:hover {
  transform: translateY(-2px);
  border-color: color-mix(in srgb, var(--text) 20%, var(--border));
  box-shadow: 0 12px 32px rgba(15, 23, 42, 0.14);
}
.svc.is-running {
  border-color: color-mix(in srgb, var(--success) 45%, var(--border));
}
.svc.is-external {
  border-color: color-mix(in srgb, var(--accent) 45%, var(--border));
}
.svc.is-failed {
  border-color: color-mix(in srgb, var(--danger) 55%, var(--border));
}

/* —— 头部：图标块 + 名称/状态 —— */
.head {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}
.app-icon {
  width: 40px;
  height: 40px;
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: color-mix(in srgb, var(--tile, var(--accent)) 16%, var(--card));
  color: var(--tile, var(--accent));
  font-size: 17px;
  font-weight: 700;
}
.meta {
  flex: 1;
  min-width: 0;
}
.name {
  font-size: 15px;
  font-weight: 700;
  letter-spacing: 0.01em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.status {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-top: 4px;
  font-size: 11px;
  color: var(--muted);
  min-height: 18px;
}
.sdot {
  width: 8px;
  height: 8px;
  flex: none;
  border-radius: 50%;
  background: var(--muted);
}
.sdot.running {
  background: var(--success);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--success) 20%, transparent);
}
.sdot.external {
  background: var(--accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent);
}
.sdot.failed {
  background: var(--danger);
}
.sdot.warn {
  background: var(--warn);
}
.st-text.fail {
  color: var(--danger);
  font-weight: 700;
}
.st-port {
  font-family: 'Geist Mono', Consolas, monospace;
  font-size: 10px;
  font-weight: 700;
  padding: 1px 7px;
  border-radius: 5px;
  border: 1px solid color-mix(in srgb, var(--text) 20%, var(--border));
  color: var(--muted);
  background: transparent;
}
button.st-port.clickable {
  color: var(--accent);
  border-color: color-mix(in srgb, var(--accent) 45%, var(--border));
  cursor: pointer;
}
button.st-port.clickable:hover {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}
.st-off {
  color: var(--warn);
}
.st-up {
  margin-left: auto;
  font-family: 'Geist Mono', Consolas, monospace;
  font-size: 10px;
  color: var(--muted);
  white-space: nowrap;
}

/* —— 命令条 —— */
.cmd {
  font-family: 'Geist Mono', Consolas, monospace;
  font-size: 10.5px;
  line-height: 1.55;
  color: var(--muted);
  background: var(--bg-soft);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 7px 10px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: default;
}

/* —— 提示 —— */
.hint {
  font-size: 11px;
  line-height: 1.6;
  color: var(--muted);
  border-left: 2px solid var(--warn);
  padding: 1px 0 1px 8px;
}

/* —— 操作行：主按钮 + 图标副操作 —— */
.ops {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 2px;
}
.btn-main {
  min-width: 92px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
}
.btn-main svg {
  width: 13px;
  height: 13px;
}
.btn-main.stop {
  background: transparent;
  border-color: color-mix(in srgb, var(--danger) 45%, var(--border));
  color: var(--danger);
}
.btn-main.stop:hover:not(:disabled) {
  background: var(--danger);
  border-color: var(--danger);
  color: #fff;
  filter: none;
}
.btn-main:disabled {
  opacity: 0.5;
}
.sub {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
}
.ib {
  width: 30px;
  height: 30px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--card);
  color: var(--muted);
  transition: all 0.13s ease;
}
.ib:hover:not(:disabled) {
  border-color: color-mix(in srgb, var(--text) 20%, var(--border));
  color: var(--text);
  background: var(--card);
}
.ib.danger {
  color: var(--danger);
  border-color: color-mix(in srgb, var(--danger) 35%, var(--border));
}
.ib.danger:hover:not(:disabled) {
  background: var(--danger);
  border-color: var(--danger);
  color: #fff;
}
.ib svg {
  width: 14px;
  height: 14px;
}
</style>
