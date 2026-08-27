import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import { router } from './router'
import './styles/globals.css'
import { installWebBridge } from './web-bridge'
import { syncThemeModeAttribute } from './composables/syncThemeMode'
installWebBridge()
syncThemeModeAttribute()

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.mount('#app')
