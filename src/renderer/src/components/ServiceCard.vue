<script setup lang="ts">
/**
 * 启动台 / 服务卡片
 *  - 视觉：shadcn Card + 边框状态色 (绿/蓝/红)
 *  - 微交互：motion-v hover scale 1.015, press 0.985，弹簧过渡
 *  - 业务：完全不重写（isExternalRunning / 命令回填检测 / 主按钮 / 三点菜单）
 *  - 状态行展示真实 PID / 运行时长 / 进程内存
 */
import { computed, ref } from 'vue'
import { Motion } from 'motion-v'
import {
  Play,
  Square,
  RefreshCw,
  RotateCw,
  ExternalLink,
  Pencil,
  Trash2,
  MoreHorizontal,
  PowerOff
} from 'lucide-vue-next'
import type { ServiceState } from '@shared/types'
import { useAppStore } from '@/stores/app'
import { springCard, springSnappy } from '@/lib/motion'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui'
import Tooltip from '@/components/ui/Tooltip.vue'
import DropdownMenu from '@/components/ui/DropdownMenu.vue'
import DropdownMenuContent from '@/components/ui/DropdownMenuContent.vue'
import DropdownMenuItem from '@/components/ui/DropdownMenuItem.vue'
import DropdownMenuSeparator from '@/components/ui/DropdownMenuSeparator.vue'
import DialogRoot from '@/components/ui/DialogRoot.vue'
import DialogPortal from '@/components/ui/DialogPortal.vue'
import DialogOverlay from '@/components/ui/DialogOverlay.vue'
import DialogContent from '@/components/ui/DialogContent.vue'
import DialogHeader from '@/components/ui/DialogHeader.vue'
import DialogTitle from '@/components/ui/DialogTitle.vue'
import DialogDescription from '@/components/ui/DialogDescription.vue'
import DialogFooter from '@/components/ui/DialogFooter.vue'

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

const store = useAppStore()

// 危险操作确认（删除 / 重启接管 / 结束外部进程）
type ConfirmKind = 'delete' | 'stopExternal' | 'restartExternal' | null
const confirmKind = ref<ConfirmKind>(null)
const confirmOpen = computed({
  get: () => confirmKind.value !== null,
  set: (v: boolean) => {
    if (!v) confirmKind.value = null
  }
})

const confirmTitle = computed(() => {
  switch (confirmKind.value) {
    case 'delete':
      return '删除服务'
    case 'stopExternal':
      return '结束外部进程'
    case 'restartExternal':
      return '重启接管'
    default:
      return ''
  }
})
const confirmBody = computed(() => {
  switch (confirmKind.value) {
    case 'delete':
      return `确认删除「${props.service.name}」？\n（不会影响外部已在运行的进程）`
    case 'stopExternal':
      return `结束占用端口 :${props.service.port} 的外部进程？\n${props.service.port_process_name || '未知进程'}（PID ${props.service.port_occupied_pid}）\n（这会终止该进程，之后可点「启动」由本台接管）`
    case 'restartExternal':
      return `重启接管 = 结束外部进程 ${props.service.port_process_name || ''}（PID ${props.service.port_occupied_pid}），\n然后用本台命令重新拉起「${props.service.name}」。继续？`
    default:
      return ''
  }
})
const confirmActionLabel = computed(() => {
  switch (confirmKind.value) {
    case 'delete':
      return '删除'
    case 'stopExternal':
      return '结束进程'
    case 'restartExternal':
      return '继续'
    default:
      return '确认'
  }
})

function runConfirm() {
  const k = confirmKind.value
  confirmKind.value = null
  if (k === 'delete') emit('delete')
  else if (k === 'stopExternal') emit('stopExternal')
  else if (k === 'restartExternal') emit('restartExternal')
}

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

const statusTone = computed<
  'success' | 'muted' | 'warning' | 'destructive' | 'primary'
>(() => {
  if (isExternalRunning.value) return 'primary'
  if (props.service.status === 'running') return 'success'
  if (props.service.status === 'failed') return 'destructive'
  if (
    props.service.status === 'starting' ||
    props.service.status === 'stopping'
  )
    return 'warning'
  return 'muted'
})

const cardBorderClass = computed(() => {
  if (isExternalRunning.value) return 'border-primary/45'
  if (props.service.status === 'running') return 'border-success/45'
  if (props.service.status === 'failed') return 'border-destructive/55'
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

/** 状态行右侧 mono 小字：托管显 PID+时长+内存，外部显 PID */
const statusAside = computed(() => {
  if (props.service.status === 'running' && props.service.pid) {
    const mem =
      props.service.mem_mb !== null ? ` · ${props.service.mem_mb} MB` : ''
    return `PID ${props.service.pid} · ${uptimeText.value}${mem}`
  }
  if (isExternalRunning.value)
    return `外部 PID ${props.service.port_occupied_pid}`
  return ''
})

const tileLetter = computed(
  () => [...(props.service.name || '?')][0]?.toUpperCase() ?? '?'
)
const tileColor = computed(() => {
  if (isExternalRunning.value) return 'var(--primary)'
  if (props.service.status === 'failed') return 'var(--destructive)'
  return 'var(--primary)'
})

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
  confirmKind.value = 'stopExternal'
}

function onPrimary() {
  if (isExternalRunning.value) {
    confirmKind.value = 'restartExternal'
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
  confirmKind.value = 'delete'
}

const statusDotClass = computed(() => {
  switch (statusTone.value) {
    case 'success':
      return 'bg-success shadow-[0_0_0_3px_theme(colors.success/20)]'
    case 'primary':
      return 'bg-primary shadow-[0_0_0_3px_theme(colors.primary/20)]'
    case 'destructive':
      return 'bg-destructive'
    case 'warning':
      return 'bg-warning'
    default:
      return 'bg-muted-foreground'
  }
})
</script>

<template>
  <Motion
    as="div"
    :initial="{ opacity: 0, y: 8 }"
    :animate="{ opacity: 1, y: 0 }"
    :while-hover="{ y: -2, scale: 1.005 }"
    :while-press="{ scale: 0.995 }"
    :transition="springCard"
    :class="
      cn(
        'group relative flex flex-col gap-3 rounded-xl border bg-card p-4 shadow-sm transition-[border-color,box-shadow]',
        cardBorderClass,
        'hover:shadow-md'
      )
    "
  >
    <!-- 头部：图标块 + 名称/状态 -->
    <div class="flex min-w-0 items-center gap-3">
      <div
        class="flex size-10 shrink-0 items-center justify-center rounded-[10px] border border-border text-[17px] font-bold"
        :style="{
          background: `color-mix(in srgb, ${tileColor} 16%, var(--card))`,
          color: tileColor
        }"
      >
        <span>{{ tileLetter }}</span>
      </div>
      <div class="min-w-0 flex-1">
        <div
          class="truncate text-[15px] font-bold leading-tight tracking-tight"
          :title="service.name"
        >
          {{ service.name }}
        </div>
        <div class="mt-1 flex min-h-[18px] items-center gap-1.5 text-[11px] text-muted-foreground">
          <span :class="['size-2 shrink-0 rounded-full', statusDotClass]" />
          <span
            :class="[
              service.status === 'failed' && 'font-bold text-destructive'
            ]"
            >{{ statusLabel }}</span
          >
          <Tooltip
            v-if="service.port && canOpen"
            :content="`在浏览器打开 http://127.0.0.1:${service.port}`"
          >
            <template #trigger>
              <button
                type="button"
                class="cursor-pointer rounded border border-primary/40 bg-transparent px-1.5 py-px font-mono text-[10px] font-bold text-primary transition-colors hover:border-primary hover:bg-primary hover:text-primary-foreground"
                @click="emit('open')"
              >
                :{{ service.port }}
              </button>
            </template>
          </Tooltip>
          <span
            v-else-if="service.port"
            class="rounded border border-border px-1.5 py-px font-mono text-[10px] font-bold text-muted-foreground"
            >:{{ service.port }}</span
          >
          <span
            v-if="statusAside"
            class="ml-auto font-mono text-[10px] text-muted-foreground whitespace-nowrap"
            >{{ statusAside }}</span
          >
        </div>
      </div>
      <DropdownMenu>
        <template #trigger>
          <button
            type="button"
            class="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            title="更多操作"
            aria-label="更多操作"
          >
            <MoreHorizontal class="size-4" />
          </button>
        </template>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            v-if="canOpen"
            @select="emit('open')"
          >
            <ExternalLink class="size-4" />
            <span>浏览器打开</span>
          </DropdownMenuItem>
          <DropdownMenuItem
            v-if="service.status === 'running'"
            @select="emit('restart')"
          >
            <RefreshCw class="size-4" />
            <span>重启</span>
          </DropdownMenuItem>
          <DropdownMenuItem
            v-if="isExternalRunning"
            @select="confirmStopExternal"
          >
            <PowerOff class="size-4" />
            <span>结束外部进程</span>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem @select="emit('edit')">
            <Pencil class="size-4" />
            <span>编辑</span>
          </DropdownMenuItem>
          <DropdownMenuItem
            class="text-destructive focus:text-destructive data-[highlighted]:text-destructive"
            @select="confirmDelete"
          >
            <Trash2 class="size-4" />
            <span>删除</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>

    <!-- 命令条 -->
    <div
      class="cursor-default truncate rounded-md border border-border bg-muted px-2.5 py-1.5 font-mono text-[10.5px] leading-relaxed text-muted-foreground"
      :title="cmdTitle"
    >
      {{ service.command }}
    </div>

    <Motion
      v-if="commandLooksBackfilled"
      :initial="{ opacity: 0, y: -2 }"
      :animate="{ opacity: 1, y: 0 }"
      :transition="springSnappy"
      class="border-l-2 border-warning pl-2 text-[11px] leading-relaxed text-muted-foreground"
    >
      这条命令像是从运行中进程回填的完整命令行，无法照此启动。点右侧
      ✎ 编辑，改成简短可执行命令（如 dsh web），工作区可留空。
    </Motion>
    <Motion
      v-else-if="isExternalRunning"
      :initial="{ opacity: 0, y: -2 }"
      :animate="{ opacity: 1, y: 0 }"
      :transition="springSnappy"
      class="border-l-2 border-primary pl-2 text-[11px] leading-relaxed text-muted-foreground"
    >
      端口由外部进程占用（非本台启动）。「重启接管」会结束它并用上面的命令拉起。
    </Motion>

    <!-- 操作：主按钮 + 图标副操作 -->
    <div class="mt-1 flex items-center gap-2">
      <Button
        v-if="isExternalRunning"
        size="sm"
        @click="onPrimary"
      >
        <RotateCw class="size-3.5" />
        重启接管
      </Button>
      <Button
        v-else-if="service.status === 'running'"
        size="sm"
        variant="outline"
        class="text-destructive border-destructive/45 hover:bg-destructive hover:text-destructive-foreground hover:border-destructive"
        @click="onPrimary"
      >
        <Square class="size-3.5" />
        停止
      </Button>
      <Button
        v-else-if="service.status === 'stopped' || service.status === 'failed'"
        size="sm"
        @click="onPrimary"
      >
        <Play class="size-3.5" />
        启动
      </Button>
      <Button
        v-else
        size="sm"
        variant="outline"
        disabled
      >
        {{ statusLabel }}
      </Button>

      <div class="ml-auto flex items-center gap-1">
        <Button
          v-if="canOpen"
          variant="ghost"
          size="icon"
          title="在浏览器打开"
          @click="emit('open')"
        >
          <ExternalLink class="size-4" />
        </Button>
        <Button
          v-if="service.status === 'running'"
          variant="ghost"
          size="icon"
          title="重启"
          @click="emit('restart')"
        >
          <RefreshCw class="size-4" />
        </Button>
        <Button
          v-if="isExternalRunning"
          variant="ghost"
          size="icon"
          class="text-destructive hover:text-destructive"
          title="结束外部进程"
          @click="confirmStopExternal"
        >
          <PowerOff class="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          title="编辑"
          @click="emit('edit')"
        >
          <Pencil class="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          class="text-destructive hover:text-destructive"
          title="删除"
          @click="confirmDelete"
        >
          <Trash2 class="size-4" />
        </Button>
      </div>
    </div>
  </Motion>

  <!-- 危险操作确认弹窗 -->
  <DialogRoot v-model:open="confirmOpen">
    <DialogPortal>
      <DialogOverlay />
      <DialogContent class="max-w-[420px]">
        <DialogHeader>
          <DialogTitle>{{ confirmTitle }}</DialogTitle>
          <DialogDescription class="whitespace-pre-line">
            {{ confirmBody }}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" @click="confirmKind = null">取消</Button>
          <Button
            :variant="confirmKind === 'delete' ? 'destructive' : 'default'"
            @click="runConfirm"
          >
            {{ confirmActionLabel }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
