<script setup lang="ts">
import { useVModel } from '@vueuse/core'
import { cn } from '@/lib/utils'

const props = defineProps<{
  modelValue?: string
  class?: string
  rows?: number
  placeholder?: string
}>()
const emits = defineEmits<{ 'update:modelValue': [v: string] }>()
const value = useVModel(props, 'modelValue', emits, { passive: true, defaultValue: '' })
</script>

<template>
  <textarea
    v-model="value"
    :rows="rows ?? 3"
    :placeholder="placeholder"
    :class="
      cn(
        'flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm',
        'placeholder:text-muted-foreground/70',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background',
        'disabled:cursor-not-allowed disabled:opacity-50',
        props.class
      )
    "
  />
</template>
