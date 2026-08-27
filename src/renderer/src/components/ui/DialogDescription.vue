<script setup lang="ts">
import { DialogDescription as RDialogDescription, type DialogDescriptionProps } from 'reka-ui'
import { cn } from '@/lib/utils'

const props = defineProps<DialogDescriptionProps & { class?: string }>()
</script>

<template>
  <RDialogDescription
    :class="cn('text-sm text-muted-foreground', props.class)"
  >
    <slot />
  </RDialogDescription>
</template>
