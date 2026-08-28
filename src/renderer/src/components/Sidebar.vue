<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, RouterLink } from 'vue-router'
import { Motion } from 'motion-v'
import {
  LayoutGrid,
  Activity,
  Coins,
  ScrollText,
  Settings as SettingsIcon,
  Sun,
  Moon,
  Monitor,
} from 'lucide-vue-next'
import { useAppStore } from '@/stores/app'
import { useTheme } from '@/composables/useTheme'
import { springCard } from '@/lib/motion'
import { cn } from '@/lib/utils'
import Tooltip from './ui/Tooltip.vue'

const route = useRoute()
const store = useAppStore()
const { mode, setMode } = useTheme()

interface NavItem {
  name: string
  label: string
  icon: typeof LayoutGrid
}

const items: NavItem[] = [
  { name: 'launchpad', label: '启动台', icon: LayoutGrid },
  { name: 'monitor', label: '服务监控', icon: Activity },
  { name: 'usage', label: 'Token 用量', icon: Coins },
  { name: 'logs', label: '日志中心', icon: ScrollText },
  { name: 'settings', label: '设置', icon: SettingsIcon }
]

const themeModes = [
  { value: 'light' as const, icon: Sun, label: '亮色' },
  { value: 'dark' as const, icon: Moon, label: '暗色' },
  { value: 'auto' as const, icon: Monitor, label: '跟随系统' }
]

const isActive = (name: string) => route.name === name
</script>

<template>
  <aside
    class="flex h-screen w-[220px] flex-col border-r border-border bg-card"
  >
    <!-- 品牌 -->
    <div class="flex items-center gap-2.5 px-4 pt-5 pb-2">
      <div class="flex size-9 items-center justify-center text-[26px] leading-none">
        🐟
      </div>
      <div class="leading-tight">
        <div class="text-[15px] font-semibold tracking-tight">小福鱼</div>
        <div class="text-[11px] text-muted-foreground">
          v{{ store.appInfo?.version ?? '0.2.5' }}
        </div>
      </div>
    </div>

    <!-- 导航 -->
    <nav class="mt-3 flex flex-col gap-0.5 px-2">
      <RouterLink
        v-for="(i, idx) in items"
        :key="i.name"
        :to="{ name: i.name }"
        custom
        v-slot="{ navigate }"
      >
        <Motion
          as="a"
          :initial="{ opacity: 0, x: -6 }"
          :animate="{ opacity: 1, x: 0 }"
          :transition="{ ...springCard, delay: 0.03 * idx }"
          :class="
            cn(
              'group flex h-9 cursor-pointer items-center gap-2.5 rounded-lg px-2.5 text-[13px] transition-colors',
              isActive(i.name)
                ? 'bg-accent text-accent-foreground font-medium'
                : 'text-foreground/85 hover:bg-muted hover:text-foreground'
            )
          "
          @click="navigate"
        >
          <component
            :is="i.icon"
            :class="
              cn(
                'size-[15px] shrink-0',
                isActive(i.name)
                  ? 'text-accent-foreground'
                  : 'text-muted-foreground group-hover:text-foreground'
              )
            "
          />
          <span>{{ i.label }}</span>
        </Motion>
      </RouterLink>
    </nav>

    <!-- 占位：把主题切换推到底部 -->
    <div class="flex-1" />

    <!-- 主题切换：胶囊三段，底部 -->
    <div
      class="mx-3 mb-3 flex items-center gap-0.5 rounded-lg border border-border bg-muted/40 p-1"
    >
      <Tooltip
        v-for="t in themeModes"
        :key="t.value"
        :content="t.label"
      >
        <template #trigger>
          <button
            type="button"
            :class="
              cn(
                'flex h-7 flex-1 items-center justify-center rounded-md text-muted-foreground transition-all',
                'hover:text-foreground',
                mode === t.value &&
                  'bg-primary text-primary-foreground shadow-sm hover:text-primary-foreground'
              )
            "
            :aria-label="t.label"
            @click="setMode(t.value)"
          >
            <component :is="t.icon" class="size-3.5" />
          </button>
        </template>
      </Tooltip>
    </div>
  </aside>
</template>
