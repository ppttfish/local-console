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
import { cn } from '@/lib/utils'
import { mergeLogWindow, type LogWindow } from '@/lib/log-merge'

const store = useAppStore()
const selectedId = ref<string | null>(null)
/** 当前选中服务可见的日志行（视图层） */
const lines = ref<string[]>([])
/** 按服务缓存最近拿到的日志窗口：切换服务瞬间从缓存恢复，不空白、不串台 */
const logCache = new Map<string, LogWindow>()
/** 每个缓存窗口对应的 tail 值：行数切换后必须强制重读，否则 unchanged 会吃掉新行数 */
const cacheTailN = new Map<string, number>()
const tail = ref(300)
const autoScroll = ref(true)
const logEl = ref<HTMLElement | null>(null)
let pollTimer: ReturnType<typeof setInterval> | null = null
/** 每个服务只让最后一次「真正发出」的请求写回，防止旧快照覆盖新快照 */
const reqSeqById = new Map<string, number>()
/** 同一 (服务, 行数) 的请求在途时直接复用，快速连点不再并发读盘 */
const inflight = new Map<string, Promise<unknown>>()
/** 在途请求的元信息：复用的等待者必须沿用发起者的 seq/tail，否则响应会被自己占的新号丢掉 */
const inflightMeta = new Map<string, { id: string; seq: number; tailN: number }>()

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
  document.addEventListener('visibilitychange', onVisibilityChange)
})

/** 页面切到后台时停掉 2s 轮询，回前台再恢复，避免不可见时还在反复读盘/重渲染 */
function onVisibilityChange() {
  if (document.hidden) {
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  } else if (!pollTimer) {
    pollTimer = setInterval(refresh, 2000)
  }
}

// 打开页面时服务列表可能还在异步加载（bootstrap 未完成），
// 等它到位后自动选中第一个，避免每次都要手动点
watch(
  () => store.services.length,
  (n) => {
    if (n > 0 && !selectedId.value) selectedId.value = store.services[0]!.id
  }
)

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = null
  document.removeEventListener('visibilitychange', onVisibilityChange)
})

watch(selectedId, (id) => {
  // 先瞬间切回该服务上次看到的窗口（首次为空），再后台刷一轮
  if (id) restoreVisible(id)
  refresh()
})

/** 把某个服务的最新窗口提交进缓存；若它正是当前选中，同步到视图并滚动 */
function commit(id: string, entry: LogWindow, tailN: number) {
  logCache.set(id, entry)
  cacheTailN.set(id, tailN)
  if (logCache.size > 80) {
    // 防御性上限：只留最早见过的 80 个服务，避免历史服务日志长期占内存
    const oldest = logCache.keys().next().value
    if (oldest !== undefined) {
      logCache.delete(oldest)
      cacheTailN.delete(oldest)
    }
  }
  if (id === selectedId.value) restoreVisible(id)
}

function restoreVisible(id: string) {
  if (id !== selectedId.value) return
  lines.value = logCache.get(id)?.lines ?? []
  if (autoScroll.value) {
    void nextTick().then(() => {
      if (logEl.value) logEl.value.scrollTop = logEl.value.scrollHeight
    })
  }
}

// 请求序号：轮询 / 切服务 / 切行数 / 手动刷新会并发触发 refresh，
// 每个服务只让最后一次发出的请求写回，防止慢响应把旧快照盖到新快照上
async function refresh() {
  const id = selectedId.value
  if (!id) {
    lines.value = []
    return
  }
  const tailN = tail.value
  const key = `${id}:${tailN}`

  let p = inflight.get(key)
  if (!p) {
    // 只有真正发请求的那次才占号；复用同 key 在途请求的等待者沿用同一 meta，
    // 否则响应会被新占的号判为过期而丢弃（界面停在旧窗口）
    const seq = (reqSeqById.get(id) ?? 0) + 1
    reqSeqById.set(id, seq)
    // 缓存缺失或行数切换时 force 一次：主进程的 mtime/size 缓存可能被 CLI/MCP
    // 等调用方预热过、或行数变了但文件没动，直接放行会返回 unchanged，前端就一直空白/不生效
    const needForce = !logCache.has(id) || cacheTailN.get(id) !== tailN
    p = store.getLogs(id, tailN, needForce) as Promise<{
      text?: string
      unchanged?: boolean
    }>
    inflight.set(key, p)
    inflightMeta.set(key, { id, seq, tailN })
    void p
      .finally(() => {
        if (inflight.get(key) === p) inflight.delete(key)
        if (inflightMeta.get(key)?.seq === seq) inflightMeta.delete(key)
      })
      .catch(() => {})
  }
  const meta = inflightMeta.get(key)
  if (!meta) return
  try {
    const r = (await p) as { text?: string; unchanged?: boolean }
    if (reqSeqById.get(meta.id) !== meta.seq) return
    // 日志没变化：缓存里已有正确内容（切回时 restoreVisible 已恢复显示），无需重渲染
    if (r.unchanged) return
    const merged = mergeLogWindow(
      logCache.get(meta.id) ?? null,
      r.text ?? '',
      meta.tailN
    )
    commit(meta.id, merged.window, meta.tailN)
  } catch {
    // 读日志失败（如服务刚被删除）：跳过本轮，下个轮询周期自动重试，不弹打扰性提示
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
    logCache.delete(selectedId.value)
    cacheTailN.delete(selectedId.value)
    lines.value = []
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

        <!-- 日志流：纯 div 渲染。逐行 Motion 在 1000 行时开销过大（每行一个动画组件实例），
             新行动效改为 CSS 动画只挂最后 3 行，key 用 idx 按位置复用、class 不变时不重播；
             纯追加的轮询由 mergeLogWindow 只产出新增行，keyed diff 只插入新节点，不做整表重写 -->
        <!-- data-selectable / overscroll-contain：日志要能选中复制；滚到顶/底时不把滚动传给外层 -->
        <div
          ref="logEl"
          data-selectable
          class="flex-1 overflow-auto overscroll-contain bg-muted/40 p-4 font-mono text-[12px] leading-[1.6] whitespace-pre-wrap break-all"
        >
          <div
            v-for="(line, idx) in lines"
            :key="idx"
            :class="['log-line', idx >= lines.length - 3 && 'log-line-enter']"
          >
            {{ line }}
          </div>
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

<style scoped>
/* 新日志行入场：只对通过 log-line-enter 标记的最后几行生效，无 JS 组件开销 */
.log-line-enter {
  animation: log-line-in 0.2s ease-out;
}
@keyframes log-line-in {
  from {
    opacity: 0;
    transform: translateX(-4px);
  }
  to {
    opacity: 1;
    transform: translateX(0);
  }
}
/* 极致：视口外日志行跳过渲染，1000 行滚动时仅渲染可见区 + 缓冲，GPU 占用骤降 */
.log-line {
  content-visibility: auto;
  contain-intrinsic-size: 0 20px;
}
</style>
