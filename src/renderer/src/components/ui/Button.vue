<script setup lang="ts">
/**
 * shadcn-vue Button (new-york)
 *  - variant: default / secondary / outline / ghost / destructive / link
 *  - size:    sm / default / lg / icon
 *  - asChild: 把原生 <button> 替换为 <a> / <RouterLink>
 */
import { computed } from 'vue'
import { Primitive, type PrimitiveProps } from 'reka-ui'
import { cn } from '@/lib/utils'
import { buttonVariants, type ButtonVariants } from './button-variants'

export interface ButtonProps extends PrimitiveProps {
  variant?: ButtonVariants['variant']
  size?: ButtonVariants['size']
  class?: string
  type?: 'button' | 'submit' | 'reset'
  disabled?: boolean
}

const props = withDefaults(defineProps<ButtonProps>(), {
  as: 'button',
  type: 'button'
})

const classes = computed(() =>
  cn(
    buttonVariants({
      variant: props.variant,
      size: props.size
    }),
    props.class
  )
)
</script>

<template>
  <Primitive
    :as="as"
    :as-child="asChild"
    :class="classes"
    :type="as === 'button' ? type : undefined"
    :disabled="disabled"
  >
    <slot />
  </Primitive>
</template>
