<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import { Motion, AnimatePresence, MotionConfig } from 'motion-v'
import { CheckCircle2, AlertCircle } from 'lucide-vue-next'
import { useAppStore } from '@/stores/app'
import Sidebar from '@/components/Sidebar.vue'
import TooltipProvider from '@/components/ui/TooltipProvider.vue'
import { springSnappy } from '@/lib/motion'

const store = useAppStore()
let unsub: (() => void) | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null

onMounted(async () => {
  await store.bootstrap()
  // 主进程会在服务启停、端口变化时主动推快照，这里的轮询只是兜底：
  // 推送不可用（web 模式）或窗口重建时数据不会彻底停更。
  unsub = window.lcp.onStateChanged((s) => store.applyState(s as never))
  pollTimer = setInterval(() => {
    if (document.hidden) return
    void store.refresh()
  }, 15_000)
})

onUnmounted(() => {
  unsub?.()
  if (pollTimer) clearInterval(pollTimer)
})
</script>

<template>
  <!-- reduced-motion="user"：motion-v 走的是 JS 动画，globals.css 里那条
       prefers-reduced-motion 只管 CSS 过渡，管不到它，这里补上系统「减弱动效」偏好 -->
  <MotionConfig reduced-motion="user">
    <TooltipProvider :delay-duration="200">
      <div class="grid h-screen grid-cols-[220px_1fr] overflow-hidden bg-background text-foreground">
        <Sidebar />
        <main class="h-screen overflow-auto">
          <!-- 路由瞬时切换：包裹动画会拖慢切换且 query 变化会触发整页重挂，刻意不加 -->
          <RouterView />
        </main>
      </div>

      <!-- 全局操作通知 -->
      <div class="pointer-events-none fixed bottom-5 right-5 z-[300] flex max-w-[440px] flex-col gap-2">
        <AnimatePresence>
          <Motion
            v-for="t in store.toasts"
            :key="t.id"
            as="div"
            :initial="{ opacity: 0, y: 8, scale: 0.98 }"
            :animate="{ opacity: 1, y: 0, scale: 1 }"
            :exit="{ opacity: 0, y: -4, scale: 0.98 }"
            :transition="springSnappy"
            :class="[
              'pointer-events-auto flex items-start gap-2 rounded-lg border bg-card px-3.5 py-2.5 text-[12.5px] leading-relaxed shadow-md',
              t.kind === 'error'
                ? 'border-destructive/30 border-l-[3px] border-l-destructive'
                : 'border-success/30 border-l-[3px] border-l-success'
            ]"
          >
            <component
              :is="t.kind === 'error' ? AlertCircle : CheckCircle2"
              :class="[
                'mt-0.5 size-4 shrink-0',
                t.kind === 'error' ? 'text-destructive' : 'text-success'
              ]"
            />
            <span class="break-words">{{ t.text }}</span>
          </Motion>
        </AnimatePresence>
      </div>
    </TooltipProvider>
  </MotionConfig>
</template>
