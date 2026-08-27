/**
 * shadcn-vue 标配 cn：clsx + tailwind-merge，去重冲突的工具类
 */
import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
