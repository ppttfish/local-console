<script setup lang="ts">
import { DialogRoot as RDialogRoot, type DialogRootProps } from 'reka-ui'

const props = defineProps<DialogRootProps>()
</script>

<template>
  <RDialogRoot v-bind="props">
    <slot />
  </RDialogRoot>
</template>
