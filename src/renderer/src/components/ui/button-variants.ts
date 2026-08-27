/**
 * shadcn-vue Button variants
 *  - 必须从 .ts 文件导出（<script setup> 不支持 export）
 */
import { cva, type VariantProps } from 'class-variance-authority'

const baseClasses =
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50'

export const buttonVariants = cva(baseClasses, {
  variants: {
    variant: {
      default:
        'bg-primary text-primary-foreground shadow-sm hover:bg-primary/90 active:bg-primary/95',
      secondary:
        'bg-secondary text-secondary-foreground hover:bg-secondary/80',
      outline:
        'border border-border bg-background hover:bg-muted hover:text-foreground',
      ghost:
        'hover:bg-muted hover:text-foreground text-foreground/80',
      destructive:
        'bg-destructive text-destructive-foreground hover:bg-destructive/90',
      link:
        'text-primary underline-offset-4 hover:underline'
    },
    size: {
      sm: 'h-8 px-3 text-xs',
      default: 'h-9 px-4',
      lg: 'h-10 px-6 text-base',
      icon: 'size-9'
    }
  },
  defaultVariants: {
    variant: 'default',
    size: 'default'
  }
})

export type ButtonVariants = VariantProps<typeof buttonVariants>
