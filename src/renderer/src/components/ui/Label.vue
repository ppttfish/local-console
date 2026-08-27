<script setup lang="ts">
import { Primitive, type PrimitiveProps } from 'reka-ui'
import { cn } from '@/lib/utils'

const props = defineProps<PrimitiveProps & { class?: string; for?: string }>()
</script>

<template>
  <Primitive
    :as="as"
    :as-child="asChild"
    :for="props.for"
    :class="
      cn(
        'text-xs font-medium leading-none text-foreground/80 peer-disabled:cursor-not-allowed peer-disabled:opacity-70',
        props.class
      )
    "
  >
    <slot />
  </Primitive>
</template>
