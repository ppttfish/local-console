<script setup lang="ts">
import {
  TooltipProvider,
  TooltipRoot,
  TooltipTrigger,
  TooltipPortal,
  TooltipContent,
  TooltipArrow
} from 'reka-ui'
import { cn } from '@/lib/utils'

defineProps<{
  /** Tooltip 文本 */
  content?: string
  /** side */
  side?: 'top' | 'right' | 'bottom' | 'left'
  align?: 'start' | 'center' | 'end'
  delayDuration?: number
  class?: string
}>()
</script>

<template>
  <TooltipRoot
    :delay-duration="delayDuration ?? 250"
  >
    <TooltipTrigger as-child>
      <slot name="trigger" />
    </TooltipTrigger>
    <TooltipPortal>
      <TooltipContent
        :side="side ?? 'top'"
        :align="align ?? 'center'"
        :side-offset="6"
        :class="
          cn(
            'z-50 overflow-hidden rounded-md bg-foreground/90 px-2 py-1 text-xs text-background shadow-md',
            'data-[state=delayed-open]:animate-in data-[state=closed]:animate-out',
            'data-[state=delayed-open]:fade-in-0 data-[state=closed]:fade-out-0',
            'data-[state=delayed-open]:zoom-in-95',
            $props.class
          )
        "
      >
        <slot>{{ content }}</slot>
      </TooltipContent>
    </TooltipPortal>
  </TooltipRoot>
</template>
