<script setup lang="ts">
import { DialogPortal as RDialogPortal, type DialogPortalProps } from 'reka-ui'

defineProps<DialogPortalProps>()
</script>

<template>
  <RDialogPortal>
    <slot />
  </RDialogPortal>
</template>
