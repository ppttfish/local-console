<script setup lang="ts">
import { ref } from 'vue'
import { useAppStore } from '../stores/app'
import type { ProjectDetection, ProjectCandidate } from '@shared/types'

const emit = defineEmits<{ close: []; added: [] }>()
const store = useAppStore()

const name = ref('')
const cwd = ref('')
const command = ref('')
const port = ref<number | null>(null)
const kind = ref<'service' | 'task'>('service')
const detection = ref<ProjectDetection | null>(null)
const error = ref('')
const saving = ref(false)

async function pickFolder() {
  const r = (await store.pickFolder()) as { ok: boolean; path?: string }
  if (r.ok && r.path) {
    cwd.value = r.path
    await detect()
  }
}

async function detect() {
  if (!cwd.value) return
  error.value = ''
  const r = (await store.detectProject(cwd.value)) as ProjectDetection
  detection.value = r
  if (r.candidates.length > 0 && !command.value) {
    applyCandidate(r.candidates[0]!)
  }
}

function applyCandidate(c: ProjectCandidate) {
  command.value = c.command
  if (c.port) port.value = c.port
  if (!name.value) name.value = c.label
}

async function save() {
  if (!name.value || !cwd.value || !command.value) {
    error.value = '名称、工作区、命令均为必填'
    return
  }
  saving.value = true
  error.value = ''
  try {
    await store.createService({
      name: name.value,
      kind: kind.value,
      cwd: cwd.value,
      command: command.value,
      port: port.value
    })
    emit('added')
  } catch (e) {
    error.value = String(e)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="mask" @click.self="emit('close')">
    <div class="dialog card">
      <header>
        <h2>添加服务</h2>
        <button class="close" @click="emit('close')">×</button>
      </header>

      <div class="form">
        <label>
          名称 *
          <input v-model="name" placeholder="如 opc-dashboard 前端" />
        </label>

        <label>
          类型
          <select v-model="kind">
            <option value="service">长期服务</option>
            <option value="task">批处理任务</option>
          </select>
        </label>

        <label>
          工作区文件夹 *
          <div class="row">
            <input v-model="cwd" placeholder="F:\opc\opc-dashboard" />
            <button @click="pickFolder">浏览…</button>
            <button @click="detect" :disabled="!cwd">识别</button>
          </div>
        </label>

        <div v-if="detection?.candidates.length" class="candidates">
          <div class="muted small">识别出的启动命令：</div>
          <div
            v-for="(c, i) in detection.candidates"
            :key="i"
            class="cand"
            :class="{ active: command === c.command }"
            @click="applyCandidate(c)"
          >
            <div class="cand-cmd">{{ c.label }}</div>
            <div class="cand-detail muted">{{ c.detail }}</div>
          </div>
        </div>

        <label>
          启动命令 *
          <input v-model="command" placeholder="npm run dev" />
        </label>

        <label>
          端口（可选）
          <input v-model.number="port" type="number" placeholder="5173" />
        </label>

        <div v-if="error" class="error">{{ error }}</div>
      </div>

      <footer>
        <button @click="emit('close')">取消</button>
        <button class="primary" :disabled="saving" @click="save">
          {{ saving ? '保存中…' : '保存' }}
        </button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}
.dialog {
  width: 540px;
  max-height: 86vh;
  display: flex;
  flex-direction: column;
}
header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
}
header h2 {
  margin: 0;
  font-size: 18px;
}
.close {
  width: 28px;
  height: 28px;
  padding: 0;
  border: none;
  background: transparent;
  font-size: 20px;
}
.form {
  display: flex;
  flex-direction: column;
  gap: 12px;
  overflow: auto;
  padding-right: 4px;
}
label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--muted);
}
.row {
  display: flex;
  gap: 6px;
}
.row input {
  flex: 1;
}
.candidates {
  background: var(--bg-soft);
  padding: 8px;
  border-radius: 6px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 180px;
  overflow: auto;
}
.cand {
  padding: 6px 8px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
}
.cand:hover {
  background: var(--hover);
}
.cand.active {
  background: var(--accent-soft);
  color: var(--accent);
}
.cand-cmd {
  font-family: monospace;
}
.cand-detail {
  font-size: 11px;
  margin-top: 2px;
}
.error {
  color: var(--danger);
  font-size: 12px;
}
footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
}
.small {
  font-size: 11px;
}
</style>
