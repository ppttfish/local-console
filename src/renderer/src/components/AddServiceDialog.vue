<script setup lang="ts">
/**
 * 添加 / 编辑服务对话框
 *  - shadcn Dialog 容器 + 表单字段
 *  - 业务逻辑零修改（project detection / command backfill 校验 / 默认工作区）
 *  - 改进：底部按钮区分主/次、错误用 Alert 图标、命令回填提示用警告色
 */
import { ref, watch, computed } from 'vue'
import { AlertTriangle, FolderOpen, Search } from 'lucide-vue-next'
import { useAppStore } from '@/stores/app'
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
  ProjectDetection,
  ProjectCandidate,
  PortSnapshot,
  ServiceState
} from '@shared/types'

const props = defineProps<{
  fromPort?: PortSnapshot | null
  editing?: ServiceState | null
}>()
const emit = defineEmits<{ close: []; added: [] }>()
const store = useAppStore()

const name = ref('')
const cwd = ref('')
const command = ref('')
const port = ref<string>('')
const kind = ref<'service' | 'task'>('service')
const detection = ref<ProjectDetection | null>(null)
const error = ref('')
const saving = ref(false)
const open = ref(true)

function applyFromPort(p: PortSnapshot): void {
  if (!name.value) name.value = `${p.process_name || 'port'}-${p.port}`
  if (!port.value) port.value = String(p.port)
  if (p.cwd) cwd.value = p.cwd
  if (p.cmd) command.value = p.cmd
}

watch(
  () => [props.fromPort, props.editing] as const,
  ([p, ed]) => {
    if (ed) {
      name.value = ed.name
      kind.value = ed.kind
      cwd.value = ed.cwd
      command.value = ed.command
      port.value = ed.port !== null ? String(ed.port) : ''
    } else if (p) {
      applyFromPort(p)
    }
  },
  { immediate: true }
)

const commandLooksBackfilled = computed(() => {
  const c = command.value.trim()
  if (!c) return false
  const first = c.split(/\s+/)[0] ?? ''
  return /^["']/.test(first) || /(^|\s)"?[A-Za-z]:[\\/][^"\s]*\.pnpm\\/.test(c)
})

const kindItems = [
  { value: 'service', label: '长期服务（持续运行）' },
  { value: 'task', label: '批处理任务（跑完即结束）' }
]

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
  if (c.port) port.value = String(c.port)
  if (!name.value) name.value = c.label
}

async function save() {
  if (!name.value || !command.value) {
    error.value = '名称、命令均为必填'
    return
  }
  if (!cwd.value.trim()) {
    const home = store.appInfo?.homeDir
    if (!home) {
      error.value = '请填写工作区文件夹（暂无法获取默认目录）'
      return
    }
    cwd.value = home
  }
  saving.value = true
  error.value = ''
  try {
    const payload = {
      name: name.value,
      kind: kind.value,
      cwd: cwd.value,
      command: command.value,
      port: port.value ? Number(port.value) : null
    }
    if (props.editing) {
      await store.updateService({ id: props.editing.id, ...payload })
    } else {
      await store.createService(payload)
    }
    emit('added')
    open.value = false
  } catch (e) {
    error.value = String(e)
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
      <DialogContent class="max-w-[560px]">
        <DialogHeader>
          <DialogTitle>
            <template v-if="editing">编辑服务</template>
            <template v-else-if="fromPort"
              >接管端口 :{{ fromPort.port }}</template
            >
            <template v-else>添加服务</template>
          </DialogTitle>
          <DialogDescription>
            配置启动命令、工作目录与端口；保存后立即在启动台可用。
          </DialogDescription>
        </DialogHeader>

        <form
          class="flex max-h-[60vh] flex-col gap-4 overflow-y-auto pr-1"
          @submit.prevent="save"
        >
          <!-- 名称 -->
          <div class="flex flex-col gap-1.5">
            <Label for="svc-name">名称 <span class="text-destructive">*</span></Label>
            <Input
              id="svc-name"
              v-model="name"
              placeholder="如 opc-dashboard 前端"
              autocomplete="off"
            />
          </div>

          <!-- 类型 -->
          <div class="flex flex-col gap-1.5">
            <Label>类型</Label>
            <Select v-model="kind" :items="kindItems" />
          </div>

          <!-- 工作区 -->
          <div class="flex flex-col gap-1.5">
            <Label for="svc-cwd">工作区文件夹</Label>
            <div class="flex gap-2">
              <Input
                id="svc-cwd"
                v-model="cwd"
                placeholder="项目目录；全局命令（如 dsh web）可留空，默认用户主目录"
                class="flex-1"
              />
              <Button
                type="button"
                variant="outline"
                size="icon"
                title="浏览文件夹"
                @click="pickFolder"
              >
                <FolderOpen class="size-4" />
              </Button>
              <Button
                type="button"
                variant="outline"
                size="default"
                :disabled="!cwd"
                @click="detect"
              >
                <Search class="size-4" />
                识别
              </Button>
            </div>
          </div>

          <!-- 候选启动命令 -->
          <div
            v-if="detection?.candidates.length"
            class="flex flex-col gap-2 rounded-md border border-border bg-muted/40 p-2.5"
          >
            <div class="text-[11px] uppercase tracking-wider text-muted-foreground">
              识别出的启动命令
            </div>
            <div class="flex max-h-44 flex-col gap-1 overflow-y-auto">
              <button
                v-for="(c, i) in detection.candidates"
                :key="i"
                type="button"
                :class="
                  cn(
                    'flex w-full flex-col items-start gap-0.5 rounded-md px-2.5 py-1.5 text-left text-xs transition-colors',
                    command === c.command
                      ? 'bg-accent text-accent-foreground'
                      : 'hover:bg-muted'
                  )
                "
                @click="applyCandidate(c)"
              >
                <span class="font-mono">{{ c.label }}</span>
                <span
                  class="text-[11px] text-muted-foreground"
                  :class="
                    command === c.command && 'text-accent-foreground/80'
                  "
                  >{{ c.detail }}</span
                >
              </button>
            </div>
          </div>

          <!-- 命令 -->
          <div class="flex flex-col gap-1.5">
            <Label for="svc-cmd"
              >启动命令 <span class="text-destructive">*</span></Label
            >
            <Input
              id="svc-cmd"
              v-model="command"
              placeholder="npm run dev"
              autocomplete="off"
            />
            <div
              v-if="commandLooksBackfilled"
              class="mt-1 flex items-start gap-1.5 rounded-md border border-warning/40 bg-warning/10 p-2 text-[11.5px] text-foreground"
            >
              <AlertTriangle class="mt-0.5 size-3.5 shrink-0 text-warning" />
              <span>
                该命令像是从运行中进程回填的完整命令行（含临时目录或
                pnpm store 路径），无法照此启动。请改成简短的可执行命令（如
                <code class="rounded bg-muted px-1">dsh web</code>
                ），工作区也建议换成固定目录。
              </span>
            </div>
          </div>

          <!-- 端口 -->
          <div class="flex flex-col gap-1.5">
            <Label for="svc-port">端口（可选）</Label>
            <Input
              id="svc-port"
              v-model="port"
              type="number"
              placeholder="5173"
              :min="0"
              :step="1"
            />
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
            {{ saving ? '保存中…' : '保存' }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
