<script setup lang="ts">
/**
 * 薅羊毛 —— 近期免费额度 / 体验卡等活动信息
 * 数据来自仓库 src/renderer/src/data/deals.json：进页面静默远程同步，
 * 失败时回落本地缓存 / 内置数据，改 JSON 推送即生效、无需发版。
 */
import { computed, onMounted, ref } from 'vue'
import { Motion } from 'motion-v'
import { Ban, CloudOff, Copy, Check, ExternalLink, RefreshCw } from 'lucide-vue-next'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from '@/components/ui'
import { springCard } from '@/lib/motion'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/stores/app'
import {
  fetchRemoteDeals,
  loadLocalDeals,
  type DealItem,
  type DealsData,
  type DealsOrigin
} from '@/lib/deals'

const store = useAppStore()

const data = ref<DealsData | null>(null)
const origin = ref<DealsOrigin>('bundled')
const fetchedAt = ref<number | null>(null)
const refreshing = ref(false)
/** 仅手动刷新失败时提示；进页面的静默同步失败不打扰（此时仍显示本地数据） */
const manualError = ref('')
const copiedField = ref('')

function isExpired(item: DealItem): boolean {
  if (!item.endsAt) return false
  return item.endsAt < new Date().toISOString().slice(0, 10)
}

// 过期沉底、置顶提前，同组内保持 JSON 书写顺序
const sortedItems = computed<DealItem[]>(() => {
  const items = data.value?.items ?? []
  return [...items].sort((a, b) => {
    const ax = isExpired(a) ? 1 : 0
    const bx = isExpired(b) ? 1 : 0
    if (ax !== bx) return ax - bx
    return (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0)
  })
})

function fmtTime(ts: number | null): string {
  if (!ts) return ''
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}

const sourceLabel = computed(() => {
  if (refreshing.value) return '同步中…'
  if (manualError.value) return '同步失败，当前为本地数据'
  switch (origin.value) {
    case 'remote':
      return `已同步 · ${fmtTime(fetchedAt.value)}`
    case 'cache':
      return `本地缓存 · ${fmtTime(fetchedAt.value)}`
    default:
      return '内置数据'
  }
})

async function refresh(manual: boolean): Promise<void> {
  refreshing.value = true
  if (manual) manualError.value = ''
  try {
    const res = await fetchRemoteDeals()
    if (res.ok) {
      data.value = res.data
      origin.value = 'remote'
      fetchedAt.value = res.fetchedAt
      if (manual) store.notify('success', `已同步 ${res.data.items.length} 条活动信息`)
    } else if (manual) {
      manualError.value = res.error
      store.notify('error', `同步失败：${res.error}`)
    }
  } finally {
    refreshing.value = false
  }
}

async function copyText(field: string, text?: string): Promise<void> {
  if (!text) return
  try {
    await navigator.clipboard.writeText(text)
    copiedField.value = field
    setTimeout(() => {
      if (copiedField.value === field) copiedField.value = ''
    }, 1500)
  } catch {
    store.notify('error', '复制失败，请手动选择文本复制')
  }
}

function openLink(url?: string): void {
  if (!url) return
  void window.lcp.openUrl(url)
}

onMounted(() => {
  // 先渲染本地数据避免空白，再静默远程同步
  const local = loadLocalDeals()
  data.value = local.data
  origin.value = local.origin
  fetchedAt.value = local.fetchedAt ?? null
  void refresh(false)
})
</script>

<template>
  <div class="flex flex-col gap-5 p-8">
    <header class="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 class="text-2xl font-semibold tracking-tight">薅羊毛</h1>
        <p class="mt-1 text-sm text-muted-foreground">
          近期免费额度、体验卡等活动信息，点卡片直达领取页
        </p>
      </div>
      <div class="flex items-center gap-2.5">
        <span
          :class="
            cn(
              'flex items-center gap-1.5 text-xs',
              manualError ? 'text-warning' : 'text-muted-foreground'
            )
          "
        >
          <CloudOff v-if="manualError" class="size-3.5" />
          {{ sourceLabel }}
        </span>
        <Button variant="outline" size="sm" :disabled="refreshing" @click="refresh(true)">
          <RefreshCw :class="cn('size-3.5', refreshing && 'animate-spin')" />
          刷新
        </Button>
      </div>
    </header>

    <!-- 瀑布流：CSS columns，卡片高度不一时后排自动上移；过期卡整卡去色置灰 -->
    <div v-if="sortedItems.length" class="columns-1 gap-4 md:columns-2 xl:columns-3">
      <Motion
        v-for="(item, idx) in sortedItems"
        :key="item.id"
        as-child
        :initial="{ opacity: 0, y: 6 }"
        :animate="{ opacity: 1, y: 0 }"
        :transition="{ ...springCard, delay: 0.04 * idx }"
      >
        <Card
          :class="
            cn(
              'mb-4 break-inside-avoid',
              isExpired(item) && 'opacity-60 grayscale'
            )
          "
        >
          <CardHeader>
            <div class="flex items-start justify-between gap-3">
              <CardTitle class="text-[15px] leading-snug">{{ item.title }}</CardTitle>
              <Badge v-if="isExpired(item)" variant="muted" class="shrink-0 gap-1">
                <Ban class="size-3" />
                已过期
              </Badge>
              <Badge v-else-if="item.pinned" variant="success" class="shrink-0">进行中</Badge>
            </div>
            <CardDescription class="whitespace-pre-line leading-relaxed">
              {{ item.description }}
            </CardDescription>
            <div v-if="item.tags?.length" class="flex flex-wrap gap-1.5 pt-0.5">
              <Badge v-for="t in item.tags" :key="t" variant="outline">{{ t }}</Badge>
            </div>
          </CardHeader>
          <CardContent class="flex flex-col gap-2.5">
            <div v-if="item.url" class="flex items-center gap-2">
              <Button size="sm" @click="openLink(item.url)">
                <ExternalLink class="size-3.5" />
                {{ item.urlLabel || '打开活动页' }}
              </Button>
              <span
                v-if="item.endsAt"
                class="text-xs text-muted-foreground"
              >截止 {{ item.endsAt }}</span>
              <span v-else class="text-xs text-muted-foreground">长期有效</span>
            </div>

            <div
              v-if="item.apiBase"
              class="flex items-center gap-2 text-[12.5px]"
            >
              <span class="w-16 shrink-0 text-muted-foreground">API 地址</span>
              <code class="flex-1 truncate rounded bg-muted px-2 py-1 font-mono text-[12px]">
                {{ item.apiBase }}
              </code>
              <Button
                variant="ghost"
                size="icon"
                class="size-7 shrink-0"
                aria-label="复制 API 地址"
                @click="copyText(item.id + ':api', item.apiBase)"
              >
                <Check v-if="copiedField === item.id + ':api'" class="size-3.5 text-success" />
                <Copy v-else class="size-3.5" />
              </Button>
            </div>

            <div v-if="item.model" class="flex items-center gap-2 text-[12.5px]">
              <span class="w-16 shrink-0 text-muted-foreground">模型</span>
              <code class="flex-1 truncate rounded bg-muted px-2 py-1 font-mono text-[12px]">
                {{ item.model }}
              </code>
              <Button
                variant="ghost"
                size="icon"
                class="size-7 shrink-0"
                aria-label="复制模型名"
                @click="copyText(item.id + ':model', item.model)"
              >
                <Check v-if="copiedField === item.id + ':model'" class="size-3.5 text-success" />
                <Copy v-else class="size-3.5" />
              </Button>
            </div>
          </CardContent>
        </Card>
      </Motion>
    </div>

    <Card v-else-if="!refreshing">
      <CardContent class="flex flex-col items-center gap-1.5 py-10 text-center">
        <p class="text-sm text-muted-foreground">暂无活动信息</p>
        <p class="text-xs text-muted-foreground">有新羊毛时会在仓库 deals.json 里更新</p>
      </CardContent>
    </Card>
  </div>
</template>
