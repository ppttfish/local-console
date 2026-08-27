<script setup lang="ts">
import { cn } from '@/lib/utils'

const props = defineProps<{ class?: string }>()
</script>

<template>
  <th
    :class="
      cn(
        'h-10 px-3 text-left align-middle text-xs font-medium uppercase tracking-wider text-muted-foreground',
        '[&:has([role=checkbox])]:pr-0',
        props.class
      )
    "
  >
    <slot />
  </th>
</template>
