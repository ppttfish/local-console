<script setup lang="ts">
import {
  DialogContent,
  DialogClose,
  type DialogContentProps
} from 'reka-ui'
import { X } from 'lucide-vue-next'
import { cn } from '@/lib/utils'

const props = defineProps<DialogContentProps & { class?: string; showClose?: boolean }>()
</script>

<template>
  <DialogContent
    :class="
      cn(
        'fixed left-1/2 top-1/2 z-50 grid w-full max-w-lg -translate-x-1/2 -translate-y-1/2 gap-4 border border-border bg-background p-6 shadow-xl',
        'rounded-xl',
        'data-[state=open]:animate-in data-[state=closed]:animate-out',
        'data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0',
        'data-[state=open]:zoom-in-95 data-[state=closed]:zoom-out-95',
        'duration-150',
        props.class
      )
    "
  >
    <slot />
    <DialogClose
      v-if="showClose !== false"
      class="absolute right-4 top-4 inline-flex size-6 items-center justify-center rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1"
    >
      <X class="size-4" />
      <span class="sr-only">关闭</span>
    </DialogClose>
  </DialogContent>
</template>
