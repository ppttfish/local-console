<script setup lang="ts">
/**
 * 添加 / 编辑订阅对话框
 *  - shadcn Dialog 容器
 *  - Provider / 凭证 / 配置字段（含 opencode 凭证复用）
 *  - 业务逻辑零修改
 */
import { ref, computed, watch } from 'vue'
import { AlertTriangle } from 'lucide-vue-next'
import {
  DialogRoot,
  DialogPortal,
  DialogOverlay,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
  Button,
  Input,
  Label,
  Select,
  Badge
} from '@/components/ui'
import { cn } from '@/lib/utils'
import type {
  ProviderMeta,
  ConfigField,
  Sub,
  DiscoveredCredential
} from '@/types/subscription'

const props = defineProps<{ editing?: Sub | null }>()
const emit = defineEmits<{ close: []; saved: [] }>()

const provider = ref('')
const displayName = ref('')
const credential = ref('')
const config = ref<Record<string, string>>({})
const error = ref('')
const saving = ref(false)
const open = ref(true)

watch(
  () => props.editing,
  (s) => {
    if (!s) return
    provider.value = s.provider
    displayName.value = s.displayName
    credential.value = ''
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
const useDiscovered = ref<string>('')

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

const providerSelectItems = computed(() =>
  metas.value.map((m) => ({
    value: m.id,
    label: m.builtin ? m.label : `${m.label} · 手动`
  }))
)

function toggleDiscovered(authKey: string, providerId: string) {
  useDiscovered.value = useDiscovered.value === authKey ? '' : authKey
  if (useDiscovered.value) {
    const pm = metas.value.find((x) => x.id === providerId)
    if (pm) selectProvider(pm.id)
  }
}

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

function configItems(f: ConfigField): { value: string; label: string }[] {
  return (f.options ?? []).map((o) => ({ value: o, label: o }))
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
    open.value = false
  } catch (e) {
    error.value = String((e as Error).message ?? e)
  } finally {
    saving.value = false
  }
}

function close() {
  open.value = false
  emit('close')
}
</script>

<template>
  <DialogRoot v-model:open="open">
    <DialogPortal>
      <DialogOverlay />
      <DialogContent class="max-w-[540px]">
        <DialogHeader>
          <DialogTitle>{{ editing ? '编辑订阅' : '添加订阅' }}</DialogTitle>
          <DialogDescription>
            <template v-if="meta?.builtin">
              内置适配器 · 主进程每 5 分钟自动拉取配额
            </template>
            <template v-else-if="meta">
              通用类型 · 不调 API，由你手动维护「已用 / 总量 / 重置时间」
            </template>
            <template v-else>加载中…</template>
          </DialogDescription>
        </DialogHeader>

        <form
          class="flex max-h-[60vh] flex-col gap-4 overflow-y-auto pr-1"
          @submit.prevent="save"
        >
          <!-- Provider -->
          <div class="flex flex-col gap-1.5">
            <Label>Provider</Label>
            <Select
              :model-value="provider"
              :items="providerSelectItems"
              :disabled="!!editing"
              @update:model-value="selectProvider"
            />
          </div>

          <!-- 显示名 -->
          <div class="flex flex-col gap-1.5">
            <Label for="sub-name">显示名</Label>
            <Input
              id="sub-name"
              v-model="displayName"
              placeholder="例如：Claude Max"
            />
          </div>

          <!-- 凭证发现（仅新建） -->
          <div
            v-if="!editing && discovered.length > 0"
            class="flex flex-col gap-1.5"
          >
            <Label>从 OpenCode 导入凭证</Label>
            <div class="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
              <button
                v-for="d in discovered"
                :key="d.authKey"
                type="button"
                :class="
                  cn(
                    'flex items-center justify-between gap-2 rounded-md border border-border bg-muted/40 px-2.5 py-1.5 text-left text-xs transition-colors',
                    'hover:border-primary',
                    useDiscovered === d.authKey &&
                      'border-primary bg-accent text-accent-foreground'
                  )
                "
                @click="toggleDiscovered(d.authKey, d.providerId)"
              >
                <span>{{ providerLabel(d.providerId) }}</span>
                <code class="rounded bg-background/60 px-1.5 py-0.5 font-mono text-[10.5px]">
                  {{ d.masked }}
                </code>
              </button>
            </div>
            <p class="text-[11px] text-muted-foreground">
              检测到 OpenCode 已登录的 Provider，点选即可复用其凭证（明文不经过界面）
            </p>
          </div>

          <!-- 凭证 -->
          <div v-if="!useDiscovered" class="flex flex-col gap-1.5">
            <Label for="sub-cred">
              {{ editing ? '凭证（留空 = 不修改）' : '凭证' }}
            </Label>
            <Input
              id="sub-cred"
              v-model="credential"
              type="password"
              :placeholder="editing ? '••••••••' : 'sk-...'"
              autocomplete="off"
            />
            <p class="text-[11px] text-muted-foreground">
              仅保存在本机 SQLite；列表中只显示掩码
            </p>
          </div>

          <!-- 动态配置字段 -->
          <div
            v-for="f in fieldsOf(meta)"
            :key="f.key"
            class="flex flex-col gap-1.5"
          >
            <Label :for="`cfg-${f.key}`">
              {{ f.label }}<template v-if="f.required">
                <span class="text-destructive"> *</span>
              </template>
            </Label>
            <Select
              v-if="f.type === 'select'"
              v-model="config[f.key]"
              :items="configItems(f)"
            />
            <Input
              v-else
              :id="`cfg-${f.key}`"
              v-model="config[f.key]"
              :type="f.type === 'number' ? 'number' : f.type === 'password' ? 'password' : 'text'"
              :placeholder="f.placeholder"
              autocomplete="off"
            />
            <p v-if="f.hint" class="text-[11px] text-muted-foreground">
              {{ f.hint }}
            </p>
          </div>

          <div
            v-if="error"
            class="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-[12px] text-destructive"
          >
            <AlertTriangle class="mt-0.5 size-3.5 shrink-0" />
            <span>{{ error }}</span>
          </div>
        </form>

        <DialogFooter>
          <Button variant="outline" type="button" @click="close">取消</Button>
          <Button type="button" :disabled="saving" @click="save">
            {{ saving ? '保存中…' : editing ? '保存修改' : '添加' }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
