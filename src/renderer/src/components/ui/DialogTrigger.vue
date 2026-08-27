<script setup lang="ts">
import { DialogTrigger as RDialogTrigger, type DialogTriggerProps } from 'reka-ui'

defineProps<DialogTriggerProps>()
</script>

<template>
  <RDialogTrigger as-child>
    <slot />
  </RDialogTrigger>
</template>
