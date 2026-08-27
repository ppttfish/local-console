<script setup lang="ts">
import { computed, type Component } from 'vue'
import { Motion } from 'motion-v'
import { TrendingUp, TrendingDown } from 'lucide-vue-next'
import { Card } from '@/components/ui'
import { springCard } from '@/lib/motion'
import { cn } from '@/lib/utils'

const props = withDefaults(
  defineProps<{
    label: string
    value: string | number
    icon: Component
    iconTone?: 'primary' | 'success' | 'warning' | 'destructive' | 'muted'
    delta?: { value: string; positive?: boolean } | null
    sub?: string
    class?: string
  }>(),
  { iconTone: 'primary', delta: null }
)

const toneClass = computed(() => {
  switch (props.iconTone) {
    case 'primary':
      return 'bg-primary/10 text-primary'
    case 'success':
      return 'bg-success/10 text-success'
    case 'warning':
      return 'bg-warning/10 text-warning'
    case 'destructive':
      return 'bg-destructive/10 text-destructive'
    case 'muted':
      return 'bg-muted text-muted-foreground'
  }
})
</script>

<template>
  <Motion
    as-child
    :initial="{ opacity: 0, y: 8 }"
    :animate="{ opacity: 1, y: 0 }"
    :transition="springCard"
  >
    <Card :class="cn('p-4', props.class)">
      <div class="flex items-start gap-3">
        <div
          :class="[
            'flex size-10 shrink-0 items-center justify-center rounded-lg',
            toneClass
          ]"
        >
          <component :is="icon" class="size-5" />
        </div>
        <div class="min-w-0 flex-1">
          <div class="text-xs text-muted-foreground">{{ label }}</div>
          <div class="mt-0.5 text-2xl font-semibold tabular-nums leading-tight">
            {{ value }}
          </div>
          <div
            v-if="delta || sub"
            class="mt-1 flex items-center gap-1 text-[11px]"
          >
            <span
              v-if="delta"
              :class="[
                'inline-flex items-center gap-0.5 font-medium',
                delta.positive ? 'text-success' : 'text-destructive'
              ]"
            >
              <component
                :is="delta.positive ? TrendingUp : TrendingDown"
                class="size-3"
              />
              {{ delta.value }}
            </span>
            <span
              v-if="sub"
              :class="[delta && 'text-muted-foreground']"
              >{{ sub }}</span
            >
          </div>
        </div>
      </div>
    </Card>
  </Motion>
</template>
