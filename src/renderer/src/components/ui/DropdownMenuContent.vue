<script setup lang="ts">
import { DropdownMenuContent, type DropdownMenuContentProps } from 'reka-ui'
import { cn } from '@/lib/utils'

const props = defineProps<DropdownMenuContentProps & { class?: string }>()
</script>

<template>
  <DropdownMenuContent
    :side-offset="4"
    :class="
      cn(
        'z-[200] min-w-[10rem] overflow-hidden rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md',
        'data-[state=open]:animate-in data-[state=closed]:animate-out',
        'data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0',
        'data-[state=open]:zoom-in-95 data-[state=closed]:zoom-out-95',
        props.class
      )
    "
  >
    <slot />
  </DropdownMenuContent>
</template>
