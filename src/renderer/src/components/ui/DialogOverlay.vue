<script setup lang="ts">
import { DialogOverlay, type DialogOverlayProps } from 'reka-ui'
import { cn } from '@/lib/utils'

const props = defineProps<DialogOverlayProps & { class?: string }>()
</script>

<template>
  <DialogOverlay
    :class="
      cn(
        'fixed inset-0 z-50 bg-black/55 backdrop-blur-[2px]',
        'data-[state=open]:animate-in data-[state=closed]:animate-out',
        'data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0',
        props.class
      )
    "
  />
</template>
