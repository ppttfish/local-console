/**
 * 动效统一参数（Phase 4 规范）
 *  - 卡片 / 按钮：stiffness 400 / damping 30（响应快、有回弹）
 *  - 弹窗：stiffness 260 / damping 26（更柔和、有点惯性）
 *  - 列表 stagger：30ms
 *  - 路由切换：150ms 横向位移
 *  - 使用时 `import { springCard, springDialog } from '@/lib/motion'`
 */
import type { Transition } from 'motion-v'

export const springCard: Transition = {
  type: 'spring',
  stiffness: 400,
  damping: 30
}

export const springDialog: Transition = {
  type: 'spring',
  stiffness: 260,
  damping: 26
}

export const springSnappy: Transition = {
  type: 'spring',
  stiffness: 500,
  damping: 32
}

export const tweenFast: Transition = {
  duration: 0.15,
  ease: 'easeOut'
}

/** 列表 stagger 父容器 transition */
export const listStagger: Transition = {
  staggerChildren: 0.03,
  delayChildren: 0.02
}
