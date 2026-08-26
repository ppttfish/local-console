<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import type {
  ProviderMeta,
  ConfigField,
  Sub,
  DiscoveredCredential
} from '../types/subscription'

const props = defineProps<{ editing?: Sub | null }>()
const emit = defineEmits<{ close: []; saved: [] }>()

const provider = ref('')
const displayName = ref('')
const credential = ref('')
const config = ref<Record<string, string>>({})
const error = ref('')
const saving = ref(false)

// 编辑模式：预填
watch(
  () => props.editing,
  (s) => {
    if (!s) return
    provider.value = s.provider
    displayName.value = s.displayName
    credential.value = '' // 不回显凭证（安全）；留空表示不修改
    const cfg: Record<string, string> = {}
    for (const [k, v] of Object.entries(s.config ?? {})) {
      cfg[k] = v === null || v === undefined ? '' : String(v)
    }
    config.value = cfg
  },
  { immediate: true }
)

const metas = ref<ProviderMeta[]>([])
const meta = computed<ProviderMeta | undefined>(
  () => metas.value.find((m) => m.id === provider.value)
)

const discovered = ref<DiscoveredCredential[]>([])
const useDiscovered = ref<string>('') // 选中的 opencode authKey

void (async () => {
  try {
    metas.value = (await window.lcp.subProviders()) as ProviderMeta[]
  } catch {
    metas.value = []
  }
  try {
    discovered.value = (await window.lcp.subDiscover()) as DiscoveredCredential[]
  } catch {
    discovered.value = []
  }
  if (!provider.value && metas.value.length > 0) {
    selectProvider(props.editing?.provider ?? metas.value[0]!.id)
  }
})()

function selectProvider(id: string) {
  provider.value = id
  const m = metas.value.find((x) => x.id === id)
  if (!m) return
  if (!props.editing) {
    const cfg: Record<string, string> = {}
    for (const f of m.configSchema) {
      const dv = m.defaultConfig[f.key]
      cfg[f.key] = dv === null || dv === undefined ? '' : String(dv)
    }
    config.value = cfg
  }
  if (!displayName.value) {
    displayName.value = m.label.split('（')[0]!.split(' (')[0]!
  }
}

function providerLabel(providerId: string): string {
  return metas.value.find((m) => m.id === providerId)?.label ?? providerId
}

function fieldsOf(m: ProviderMeta | undefined): ConfigField[] {
  return m?.configSchema ?? []
}

async function save() {
  error.value = ''
  const m = meta.value
  if (!m) {
    error.value = '请选择 Provider'
    return
  }
  if (!displayName.value.trim()) {
    error.value = '名称必填'
    return
  }
  // 必填校验；编辑时 credential 留空 = 保持不变；选了 opencode 发现的凭证则免填
  if (!useDiscovered.value && (!props.editing || credential.value)) {
    if (!credential.value.trim() && m.id !== 'generic') {
      error.value = '凭证必填（API key / token）'
      return
    }
  }
  for (const f of fieldsOf(m)) {
    if (f.required && !String(config.value[f.key] ?? '').trim()) {
      error.value = `${f.label} 必填`
      return
    }
  }

  saving.value = true
  try {
    const cfgObj: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(config.value)) {
      const f = fieldsOf(m).find((x) => x.key === k)
      if (f?.type === 'number') {
        cfgObj[k] = Number(v)
      } else {
        cfgObj[k] = v
      }
    }
    if (props.editing) {
      await window.lcp.subUpdate({
        id: props.editing.id,
        displayName: displayName.value,
        ...(credential.value ? { credential: credential.value } : {}),
        config: cfgObj
      })
    } else {
      await window.lcp.subCreate({
        provider: provider.value,
        displayName: displayName.value,
        credential: credential.value || '-',
        ...(useDiscovered.value ? { opencodeKey: useDiscovered.value } : {}),
        config: cfgObj
      })
    }
    emit('saved')
  } catch (e) {
    error.value = String((e as Error).message ?? e)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="overlay" @click.self="emit('close')">
    <div class="dialog">
      <h2>{{ editing ? '编辑订阅' : '添加订阅' }}</h2>

      <div class="field">
        <label>Provider</label>
        <select :value="provider" :disabled="!!editing" @change="selectProvider(($event.target as HTMLSelectElement).value)">
          <option v-for="m in metas" :key="m.id" :value="m.id">
            {{ m.label }}{{ m.builtin ? '' : ' · 手动' }}
          </option>
        </select>
        <span class="hint" v-if="meta?.builtin">
          内置适配器 · 主进程每 5 分钟自动拉取配额
        </span>
        <span class="hint" v-else-if="meta">
          通用类型 · 不调 API，由你手动维护「已用 / 总量 / 重置时间」
        </span>
      </div>

      <div class="field">
        <label>显示名</label>
        <input v-model="displayName" placeholder="例如：Claude Max" />
      </div>

      <div v-if="!editing && discovered.length > 0" class="field">
        <label>从 OpenCode 导入凭证</label>
        <div class="disc-list">
          <button
            v-for="d in discovered"
            :key="d.authKey"
            type="button"
            class="disc-item"
            :class="{ selected: useDiscovered === d.authKey }"
            @click="
              useDiscovered = useDiscovered === d.authKey ? '' : d.authKey;
              if (useDiscovered) { const pm = metas.find((x) => x.id === d.providerId); if (pm) selectProvider(pm.id); }
            "
          >
            <span>{{ providerLabel(d.providerId) }}</span>
            <code>{{ d.masked }}</code>
          </button>
        </div>
        <span class="hint">检测到 OpenCode 已登录的 Provider，点选即可复用其凭证（明文不经过界面）</span>
      </div>

      <div v-if="!useDiscovered" class="field">
        <label>{{ editing ? '凭证（留空 = 不修改）' : '凭证' }}</label>
        <input
          v-model="credential"
          type="password"
          :placeholder="editing ? '••••••••' : 'sk-...'"
          autocomplete="off"
        />
        <span class="hint">仅保存在本机 SQLite；列表中只显示掩码</span>
      </div>

      <div v-for="f in fieldsOf(meta)" :key="f.key" class="field">
        <label>{{ f.label }}<template v-if="f.required"> *</template></label>
        <select v-if="f.type === 'select'" v-model="config[f.key]">
          <option v-for="o in f.options ?? []" :key="o" :value="o">{{ o }}</option>
        </select>
        <input
          v-else
          v-model="config[f.key]"
          :type="f.type === 'number' ? 'number' : 'text'"
          :placeholder="f.placeholder"
        />
        <span class="hint" v-if="f.hint">{{ f.hint }}</span>
      </div>

      <div v-if="error" class="err">{{ error }}</div>

      <div class="row">
        <button @click="emit('close')">取消</button>
        <button class="primary" :disabled="saving" @click="save">
          {{ saving ? '保存中…' : editing ? '保存修改' : '添加' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}
.dialog {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 20px;
  width: min(520px, calc(100vw - 40px));
  max-height: 85vh;
  overflow-y: auto;
  box-shadow: 0 20px 50px rgba(0, 0, 0, 0.25);
}
.dialog h2 {
  margin: 0 0 14px;
  font-size: 16px;
}
.row {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 14px;
}
.disc-list {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
}
.disc-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  padding: 7px 10px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--bg-soft);
  font-size: 12px;
  cursor: pointer;
  text-align: left;
}
.disc-item:hover {
  border-color: var(--accent);
}
.disc-item.selected {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--text);
}
.disc-item code {
  font-size: 10.5px;
  opacity: 0.75;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 12px;
}
.field label {
  font-size: 11px;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.3px;
}
.hint {
  font-size: 11px;
  color: var(--muted);
}
.err {
  padding: 8px 10px;
  background: rgba(239, 68, 68, 0.1);
  color: var(--danger);
  font-size: 12px;
  border-radius: 6px;
  margin-bottom: 10px;
}
.row {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 14px;
}
</style>
