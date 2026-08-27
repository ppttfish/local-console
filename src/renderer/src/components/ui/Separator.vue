<script setup lang="ts">
import { Separator, type SeparatorProps } from 'reka-ui'
import { cn } from '@/lib/utils'

const props = withDefaults(
  defineProps<
    SeparatorProps & {
      class?: string
    }
  >(),
  { orientation: 'horizontal', decorative: true }
)
</script>

<template>
  <Separator
    :orientation="orientation"
    :decorative="decorative"
    :class="
      cn(
        'shrink-0 bg-border',
        orientation === 'horizontal' ? 'h-px w-full' : 'h-full w-px',
        props.class
      )
    "
  />
</template>
