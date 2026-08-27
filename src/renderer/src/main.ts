import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import { router } from './router'
import './styles/globals.css'
// 老 CSS 仍保留（含 --accent 等旧变量），等所有页面迁完再删
import './styles/index.css'
import { installWebBridge } from './web-bridge'
import { syncThemeModeAttribute } from './composables/syncThemeMode'
installWebBridge()
syncThemeModeAttribute()

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.mount('#app')
