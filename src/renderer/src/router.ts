import { createRouter, createWebHashHistory } from 'vue-router'

/**
 * 全部页面按需加载。
 * 之前 6 个页面静态 import，chart.js / reka-ui / motion-v 全被打进同一个
 * 1.7MB 的 chunk，首屏必须把它整包解析完才能渲染。
 */
export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', redirect: '/launchpad' },
    {
      path: '/launchpad',
      component: () => import('./pages/Launchpad.vue'),
      name: 'launchpad',
      meta: { title: '启动台' }
    },
    {
      path: '/monitor',
      component: () => import('./pages/Monitor.vue'),
      name: 'monitor',
      meta: { title: '服务监控' }
    },
    {
      path: '/usage',
      component: () => import('./pages/Usage.vue'),
      name: 'usage',
      meta: { title: 'Token 用量' }
    },
    {
      path: '/logs',
      component: () => import('./pages/Logs.vue'),
      name: 'logs',
      meta: { title: '日志中心' }
    },
    {
      path: '/deals',
      component: () => import('./pages/Deals.vue'),
      name: 'deals',
      meta: { title: '薅羊毛' }
    },
    {
      path: '/settings',
      component: () => import('./pages/Settings.vue'),
      name: 'settings',
      meta: { title: '设置' }
    }
  ]
})
