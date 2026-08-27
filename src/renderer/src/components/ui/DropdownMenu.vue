<script setup lang="ts">
import {
  DropdownMenuRoot,
  DropdownMenuTrigger,
  DropdownMenuPortal
} from 'reka-ui'

defineProps<{ open?: boolean }>()
const emits = defineEmits<{ 'update:open': [v: boolean] }>()
</script>

<template>
  <DropdownMenuRoot
    :open="open"
    @update:open="(v: boolean) => emits('update:open', v)"
  >
    <DropdownMenuTrigger as-child>
      <slot name="trigger" />
    </DropdownMenuTrigger>
    <DropdownMenuPortal>
      <slot />
    </DropdownMenuPortal>
  </DropdownMenuRoot>
</template>
