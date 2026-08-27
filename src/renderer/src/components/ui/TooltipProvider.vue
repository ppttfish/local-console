<script setup lang="ts">
import { TooltipProvider } from 'reka-ui'

defineProps<{ delayDuration?: number; skipDelayDuration?: number }>()
</script>

<template>
  <TooltipProvider
    :delay-duration="delayDuration ?? 250"
    :skip-delay-duration="skipDelayDuration ?? 300"
  >
    <slot />
  </TooltipProvider>
</template>
