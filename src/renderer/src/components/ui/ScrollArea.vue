<script setup lang="ts">
import { ScrollAreaRoot, ScrollAreaViewport, ScrollAreaScrollbar, ScrollAreaThumb } from 'reka-ui'
import { cn } from '@/lib/utils'

const props = defineProps<{ class?: string }>()
</script>

<template>
  <ScrollAreaRoot :class="cn('relative overflow-hidden', props.class)">
    <ScrollAreaViewport class="h-full w-full rounded-[inherit]">
      <slot />
    </ScrollAreaViewport>
    <ScrollAreaScrollbar
      orientation="vertical"
      class="flex select-none touch-none p-0.5 transition-colors h-full w-2"
    >
      <ScrollAreaThumb class="relative flex-1 rounded-full bg-muted-foreground/30 hover:bg-muted-foreground/50" />
    </ScrollAreaScrollbar>
    <ScrollAreaScrollbar
      orientation="horizontal"
      class="flex select-none touch-none p-0.5 transition-colors h-2 flex-col"
    >
      <ScrollAreaThumb class="relative flex-1 rounded-full bg-muted-foreground/30 hover:bg-muted-foreground/50" />
    </ScrollAreaScrollbar>
  </ScrollAreaRoot>
</template>
