<script setup lang="ts">
import { computed } from 'vue'
import { SwitchRoot, SwitchThumb, type SwitchRootProps } from 'reka-ui'
import { cn } from '@/lib/utils'

const props = defineProps<
  Omit<SwitchRootProps, 'asChild'> & {
    modelValue?: boolean
    class?: string
  }
>()

const emits = defineEmits<{ 'update:modelValue': [v: boolean] }>()

const value = computed({
  get: () => props.modelValue,
  set: (v) => emits('update:modelValue', v as boolean)
})
</script>

<template>
  <SwitchRoot
    v-model="value"
    :class="
      cn(
        'peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent shadow-sm transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background',
        'disabled:cursor-not-allowed disabled:opacity-50',
        'data-[state=checked]:bg-primary data-[state=unchecked]:bg-muted',
        props.class
      )
    "
  >
    <SwitchThumb
      class="pointer-events-none block size-4 rounded-full bg-background shadow ring-0 transition-transform data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0"
    />
  </SwitchRoot>
</template>
