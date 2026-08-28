import { createRouter, createWebHashHistory } from 'vue-router'
import Launchpad from './pages/Launchpad.vue'
import Monitor from './pages/Monitor.vue'
import Logs from './pages/Logs.vue'
import Settings from './pages/Settings.vue'
import Usage from './pages/Usage.vue'
import Deals from './pages/Deals.vue'

export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', redirect: '/launchpad' },
    { path: '/launchpad', component: Launchpad, name: 'launchpad', meta: { title: '启动台' } },
    { path: '/monitor', component: Monitor, name: 'monitor', meta: { title: '服务监控' } },
    { path: '/usage', component: Usage, name: 'usage', meta: { title: 'Token 用量' } },
    { path: '/logs', component: Logs, name: 'logs', meta: { title: '日志中心' } },
    { path: '/deals', component: Deals, name: 'deals', meta: { title: '薅羊毛' } },
    { path: '/settings', component: Settings, name: 'settings', meta: { title: '设置' } }
  ]
})
