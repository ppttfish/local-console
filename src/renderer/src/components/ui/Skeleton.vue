<script setup lang="ts">
import { cn } from '@/lib/utils'

const props = defineProps<{ class?: string }>()
</script>

<template>
  <div
    :class="
      cn(
        'relative overflow-hidden rounded-md bg-muted',
        'before:absolute before:inset-0',
        'before:translate-x-[-100%] before:animate-[shimmer_1.6s_infinite]',
        'before:bg-gradient-to-r before:from-transparent before:via-white/40 before:to-transparent',
        'dark:before:via-white/10',
        props.class
      )
    "
  >
    <slot />
  </div>
</template>

<style>
@keyframes shimmer {
  100% {
    transform: translateX(100%);
  }
}
</style>
