<script setup lang="ts">
import { DialogTitle as RDialogTitle, type DialogTitleProps } from 'reka-ui'
import { cn } from '@/lib/utils'

const props = defineProps<DialogTitleProps & { class?: string }>()
</script>

<template>
  <RDialogTitle
    :class="cn('text-base font-semibold leading-none tracking-tight', props.class)"
  >
    <slot />
  </RDialogTitle>
</template>
