<script setup lang="ts">
import { ref, computed } from 'vue'
import {
  SelectRoot,
  SelectTrigger,
  SelectValue,
  SelectIcon,
  SelectPortal,
  SelectContent,
  SelectViewport,
  SelectItem,
  SelectItemText,
  SelectItemIndicator,
  SelectScrollUpButton,
  SelectScrollDownButton
} from 'reka-ui'
import { Check, ChevronDown, ChevronUp } from 'lucide-vue-next'
import { cn } from '@/lib/utils'

interface SelectItemDef {
  value: string
  label: string
}

const props = defineProps<{
  modelValue?: string
  items: SelectItemDef[]
  placeholder?: string
  class?: string
  disabled?: boolean
}>()

const emits = defineEmits<{ 'update:modelValue': [v: string] }>()

const open = ref(false)
const value = computed({
  get: () => props.modelValue,
  set: (v) => emits('update:modelValue', v as string)
})
</script>

<template>
  <SelectRoot v-model="value" :open="open" @update:open="(o: boolean) => (open = o)">
    <SelectTrigger
      :class="
        cn(
          'flex h-9 w-full items-center justify-between rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm',
          'placeholder:text-muted-foreground/70',
          'focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1 focus:ring-offset-background',
          'disabled:cursor-not-allowed disabled:opacity-50',
          '[&>span]:line-clamp-1',
          props.class
        )
      "
    >
      <SelectValue :placeholder="placeholder" />
      <SelectIcon as-child>
        <ChevronDown class="size-4 opacity-60" />
      </SelectIcon>
    </SelectTrigger>
    <SelectPortal>
      <SelectContent
        position="popper"
        :side-offset="4"
        class="z-[200] max-h-72 min-w-[var(--reka-select-trigger-width)] overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-lg"
      >
        <SelectScrollUpButton class="flex h-6 items-center justify-center">
          <ChevronUp class="size-4" />
        </SelectScrollUpButton>
        <SelectViewport class="p-1">
          <SelectItem
            v-for="it in items"
            :key="it.value"
            :value="it.value"
            class="relative flex h-8 cursor-pointer select-none items-center rounded-sm pl-7 pr-2 text-sm outline-none focus:bg-accent focus:text-accent-foreground data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50"
          >
            <SelectItemIndicator class="absolute left-2 inline-flex items-center">
              <Check class="size-3.5" />
            </SelectItemIndicator>
            <SelectItemText>{{ it.label }}</SelectItemText>
          </SelectItem>
        </SelectViewport>
        <SelectScrollDownButton class="flex h-6 items-center justify-center">
          <ChevronDown class="size-4" />
        </SelectScrollDownButton>
      </SelectContent>
    </SelectPortal>
  </SelectRoot>
</template>
