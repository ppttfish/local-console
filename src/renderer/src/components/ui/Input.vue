<script setup lang="ts">
import { useVModel } from '@vueuse/core'
import { cn } from '@/lib/utils'

const props = defineProps<{
  modelValue?: string | number
  class?: string
  type?: string
  placeholder?: string
  disabled?: boolean
  min?: number
  step?: number
  autocomplete?: string
}>()

const emits = defineEmits<{ 'update:modelValue': [value: string | number] }>()

const value = useVModel(props, 'modelValue', emits, {
  passive: true,
  defaultValue: ''
})
</script>

<template>
  <input
    v-model="value"
    :type="type ?? 'text'"
    :placeholder="placeholder"
    :disabled="disabled"
    :min="min"
    :step="step"
    :autocomplete="autocomplete"
    :class="
      cn(
        'flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors',
        'placeholder:text-muted-foreground/70',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background',
        'disabled:cursor-not-allowed disabled:opacity-50',
        'file:border-0 file:bg-transparent file:text-sm file:font-medium',
        props.class
      )
    "
  />
</template>
