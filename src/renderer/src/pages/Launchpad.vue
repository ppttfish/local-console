<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { useAppStore } from '../stores/app'
import ServiceCard from '../components/ServiceCard.vue'
import AddServiceDialog from '../components/AddServiceDialog.vue'
import type { ServiceState } from '@shared/types'

const store = useAppStore()
const showAdd = ref(false)
const editingSvc = ref<ServiceState | null>(null)
let pollTimer: ReturnType<typeof setInterval> | null = null

onMounted(() => {
  store.refresh()
  pollTimer = setInterval(() => store.refresh(), 2000)
})
onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer)
})

function onAdded() {
  showAdd.value = false
  editingSvc.value = null
  store.refresh()
}
</script>

<template>
  <div class="launchpad">
    <header class="page-header">
      <div>
        <h1>启动台</h1>
        <p class="muted">一键启动与管理你的本地服务和批处理任务</p>
      </div>
      <div class="actions">
        <button @click="store.refresh()">刷新状态</button>
        <button class="primary" @click="showAdd = true">+ 添加服务</button>
      </div>
    </header>

    <div class="cards">
      <ServiceCard
        v-for="svc in store.services"
        :key="svc.id"
        :service="svc"
        @start="store.startService(svc.id)"
        @stop="store.stopService(svc.id)"
        @restart="store.restartService(svc.id)"
        @stop-external="store.stopExternalService(svc.id)"
        @restart-external="store.restartExternalService(svc.id)"
        @edit="editingSvc = svc"
        @delete="store.deleteService(svc.id)"
      />
      <div v-if="store.services.length === 0" class="empty card">
        <div class="emoji">📦</div>
        <div>还没有服务</div>
        <div class="muted">点右上角"添加服务"开始</div>
      </div>
    </div>

    <AddServiceDialog
      v-if="showAdd || editingSvc"
      :editing="editingSvc"
      @close="showAdd = false; editingSvc = null"
      @added="onAdded"
    />
  </div>
</template>

<style scoped>
.launchpad {
  display: flex;
  flex-direction: column;
  gap: 20px;
}
.page-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
}
.page-header h1 {
  margin: 0;
  font-size: 22px;
}
.page-header p {
  margin: 4px 0 0;
  font-size: 13px;
}
.actions {
  display: flex;
  gap: 8px;
}
.cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 14px;
}
.empty {
  text-align: center;
  padding: 40px 20px;
  grid-column: 1 / -1;
}
.emoji {
  font-size: 36px;
  margin-bottom: 10px;
}
</style>
