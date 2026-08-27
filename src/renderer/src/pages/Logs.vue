<script setup lang="ts">
/**
 * 日志中心
 *  - 左：服务列表（shadcn 风格 + 状态点 + active 胶囊）
 *  - 右：日志流（pre 文本 + 新行 fade-in 动效）
 *  - 顶栏：服务名 / 端口 / 自动滚动开关 / 行数 / 刷新 / 清空
 *  - 用 Switch 替换 checkbox
 *  - 增强：日志更新时新行轻量高亮（新行不重新播整段，仅末尾追加段）
 */
import { ref, onMounted, onUnmounted, watch, computed, nextTick } from 'vue'
import { Motion, AnimatePresence } from 'motion-v'
import { Trash2, RefreshCw, ArrowDown, ScrollText } from 'lucide-vue-next'
import { useAppStore } from '@/stores/app'
import {
  Button,
  Card,
  Switch,
  Select,
  Badge,
  DialogRoot,
  DialogPortal,
  DialogOverlay,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter
} from '@/components/ui'
import { springSnappy } from '@/lib/motion'
import { cn } from '@/lib/utils'

const store = useAppStore()
const selectedId = ref<string | null>(null)
const lines = ref<string[]>([])
const tail = ref(300)
const autoScroll = ref(true)
const logEl = ref<HTMLElement | null>(null)
let pollTimer: ReturnType<typeof setInterval> | null = null
let lastLineCount = 0

const selected = computed(() =>
  store.services.find((s) => s.id === selectedId.value)
)

const tailItems = [
  { value: '100', label: '最近 100 行' },
  { value: '300', label: '最近 300 行' },
  { value: '1000', label: '最近 1000 行' }
]

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
    lastLineCount = 0
    return
  }
  const r = (await store.getLogs(selectedId.value, tail.value)) as { text: string }
  const newLines = r.text ? r.text.split('\n') : []
  lines.value = newLines
  lastLineCount = newLines.length
  if (autoScroll.value) {
    await nextTick()
    if (logEl.value) logEl.value.scrollTop = logEl.value.scrollHeight
  }
}

async function clear() {
  if (!selectedId.value) return
  showClearConfirm.value = true
}

const showClearConfirm = ref(false)
const clearing = ref(false)
async function doClear() {
  if (!selectedId.value) return
  clearing.value = true
  try {
    await store.clearLogs(selectedId.value)
    lines.value = []
    lastLineCount = 0
    showClearConfirm.value = false
  } finally {
    clearing.value = false
  }
}

function statusTone(status: string): 'success' | 'muted' | 'destructive' | 'warning' {
  if (status === 'running') return 'success'
  if (status === 'failed') return 'destructive'
  if (status === 'starting' || status === 'stopping') return 'warning'
  return 'muted'
}

function scrollToBottom() {
  autoScroll.value = true
  if (logEl.value) logEl.value.scrollTop = logEl.value.scrollHeight
}
</script>

<template>
  <div class="flex h-full flex-col gap-5 p-8">
    <header class="flex items-end justify-between">
      <div>
        <h1 class="text-2xl font-semibold tracking-tight">日志中心</h1>
        <p class="mt-1 text-sm text-muted-foreground">查看服务的运行日志</p>
      </div>
    </header>

    <div class="grid min-h-0 flex-1 grid-cols-[260px_1fr] gap-4">
      <!-- 左：服务列表 -->
      <Card class="flex min-h-0 flex-col">
        <div class="flex items-center gap-2 border-b border-border p-3">
          <ScrollText class="size-4 text-muted-foreground" />
          <span class="text-xs font-medium text-muted-foreground">
            服务列表
          </span>
        </div>
        <div class="flex-1 overflow-y-auto p-1.5">
          <button
            v-for="s in store.services"
            :key="s.id"
            type="button"
            :class="
              cn(
                'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors',
                s.id === selectedId
                  ? 'bg-accent text-accent-foreground font-medium'
                  : 'hover:bg-muted'
              )
            "
            @click="selectedId = s.id"
          >
            <span
              :class="[
                'size-2 shrink-0 rounded-full',
                s.status === 'running' && 'bg-success',
                s.status === 'failed' && 'bg-destructive',
                (s.status === 'starting' || s.status === 'stopping') && 'bg-warning',
                s.status === 'stopped' && 'bg-muted-foreground/50'
              ]"
            />
            <span class="truncate">{{ s.name }}</span>
          </button>
          <div
            v-if="store.services.length === 0"
            class="px-3 py-8 text-center text-xs text-muted-foreground"
          >
            暂无服务
          </div>
        </div>
      </Card>

      <!-- 右：日志流 -->
      <Card v-if="selected" class="flex min-h-0 flex-col">
        <!-- 工具栏 -->
        <div
          class="flex flex-wrap items-center gap-2 border-b border-border p-3"
        >
          <span class="text-sm font-semibold">{{ selected.name }}</span>
          <Badge variant="muted" class="font-mono"
            >:{{ selected.port ?? '—' }}</Badge
          >
          <span class="flex-1" />
          <label
            class="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground"
          >
            <Switch v-model="autoScroll" />
            <span>自动滚到底</span>
          </label>
          <Select
            :model-value="String(tail)"
            :items="tailItems"
            class="w-[130px]"
            @update:model-value="(v: string) => { tail = Number(v); refresh(); }"
          />
          <Button variant="outline" size="sm" @click="refresh">
            <RefreshCw class="size-3.5" />
            刷新
          </Button>
          <Button variant="outline" size="sm" @click="clear">
            <Trash2 class="size-3.5" />
            清空
          </Button>
        </div>

        <!-- 日志流 -->
        <div
          ref="logEl"
          class="flex-1 overflow-auto bg-muted/40 p-4 font-mono text-[12px] leading-[1.6] whitespace-pre-wrap break-all"
        >
          <AnimatePresence>
            <Motion
              v-for="(line, idx) in lines"
              :key="idx"
              as="div"
              :initial="
                idx >= lines.length - 3
                  ? { opacity: 0, x: -4 }
                  : false
              "
              :animate="{ opacity: 1, x: 0 }"
              :transition="springSnappy"
            >
              {{ line }}
            </Motion>
          </AnimatePresence>
        </div>

        <!-- 底部状态条 -->
        <div
          class="flex items-center gap-2 border-t border-border px-3 py-1.5 text-[11px] text-muted-foreground"
        >
          <span>{{ lines.length }} 行</span>
          <span class="flex-1" />
          <Button
            v-if="!autoScroll"
            variant="ghost"
            size="sm"
            @click="scrollToBottom"
          >
            <ArrowDown class="size-3" />
            滚到底
          </Button>
        </div>
      </Card>

      <Card v-else class="flex items-center justify-center p-10 text-sm text-muted-foreground">
        选择左侧服务查看日志
      </Card>
    </div>
  </div>

  <!-- 清空日志确认 -->
  <DialogRoot v-model:open="showClearConfirm">
    <DialogPortal>
      <DialogOverlay />
      <DialogContent class="max-w-[420px]">
        <DialogHeader>
          <DialogTitle>清空日志？</DialogTitle>
          <DialogDescription>
            确认清空「{{ selected?.name }}」的所有日志？此操作不可恢复。
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="outline"
            :disabled="clearing"
            @click="showClearConfirm = false"
          >取消</Button>
          <Button
            variant="destructive"
            :disabled="clearing"
            @click="doClear"
          >
            <Trash2 class="size-4" />
            {{ clearing ? '清空中…' : '清空' }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
