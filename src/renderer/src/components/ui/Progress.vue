<script setup lang="ts">
import { computed } from 'vue'
import { ProgressRoot, ProgressIndicator, type ProgressRootProps } from 'reka-ui'
import { cn } from '@/lib/utils'

const props = defineProps<
  ProgressRootProps & {
    modelValue?: number
    /** tone: ok=绿, warn=琥珀, danger=红, primary=蓝 */
    tone?: 'primary' | 'ok' | 'warn' | 'danger' | 'unknown'
    class?: string
  }
>()

const colorClass = computed(() => {
  switch (props.tone) {
    case 'ok':
      return 'bg-success'
    case 'warn':
      return 'bg-warning'
    case 'danger':
      return 'bg-destructive'
    case 'primary':
      return 'bg-primary'
    case 'unknown':
      return 'bg-muted-foreground/30'
    default:
      return 'bg-primary'
  }
})
</script>

<template>
  <ProgressRoot
    :model-value="modelValue"
    :class="
      cn(
        'relative h-2 w-full overflow-hidden rounded-full bg-muted',
        props.class
      )
    "
  >
    <ProgressIndicator
      :class="cn('h-full transition-transform duration-300', colorClass)"
      :style="`transform: translateX(-${100 - (modelValue ?? 0)}%)`"
    />
  </ProgressRoot>
</template>
