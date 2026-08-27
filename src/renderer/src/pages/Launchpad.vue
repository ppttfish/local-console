<script setup lang="ts">
/**
 * 启动台
 *  - 顶部 4 个 KPI 卡（运行中 / 总数 / 未纳管端口 / 错误数）
 *  - 服务卡片网格
 *  - 关键交互：列表 key 用 service.id，2s 轮询不会重播整列动画
 *  - 顶部右侧 + 添加服务（主操作）
 *  - 用 shadcn Button + lucide 图标
 */
import { ref, computed } from 'vue'
import { Motion } from 'motion-v'
import { Plus, RefreshCw, Server, AlertTriangle, Layers, Plug } from 'lucide-vue-next'
import { useAppStore } from '@/stores/app'
import ServiceCard from '@/components/ServiceCard.vue'
import KpiCard from '@/components/KpiCard.vue'
import AddServiceDialog from '@/components/AddServiceDialog.vue'
import { Button } from '@/components/ui'
import { listStagger, springCard } from '@/lib/motion'
import type { ServiceState } from '@shared/types'

const store = useAppStore()
const showAdd = ref(false)
const editingSvc = ref<ServiceState | null>(null)

const errorCount = computed(
  () => store.services.filter((s) => s.status === 'failed').length
)

const running = computed(() => store.runningServices.length)
const total = computed(() => store.services.length)
const unmanaged = computed(() => store.unmanagedPorts.length)

function onAdded() {
  showAdd.value = false
  editingSvc.value = null
  void store.refresh()
}
</script>

<template>
  <div class="flex flex-col gap-5 p-8">
    <!-- 标题栏 -->
    <header class="flex items-end justify-between">
      <div>
        <h1 class="text-2xl font-semibold tracking-tight">启动台</h1>
        <p class="mt-1 text-sm text-muted-foreground">
          一键启动与管理你的本地服务和批处理任务
        </p>
      </div>
      <div class="flex items-center gap-2">
        <Button
          variant="outline"
          size="default"
          @click="store.refresh()"
        >
          <RefreshCw class="size-4" />
          刷新状态
        </Button>
        <Button @click="showAdd = true">
          <Plus class="size-4" />
          添加服务
        </Button>
      </div>
    </header>

    <!-- KPI 行 -->
    <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <KpiCard
        :label="`运行中 / ${total}`"
        :value="running"
        :icon="Server"
        icon-tone="primary"
        sub="本地服务"
      />
      <KpiCard
        label="未纳管端口"
        :value="unmanaged"
        :icon="Plug"
        icon-tone="warning"
        sub="可在「服务监控」中纳管"
      />
      <KpiCard
        label="服务总数"
        :value="total"
        :icon="Layers"
        icon-tone="muted"
        sub="含已停止 / 失败"
      />
      <KpiCard
        label="错误数"
        :value="errorCount"
        :icon="AlertTriangle"
        :icon-tone="errorCount > 0 ? 'destructive' : 'success'"
        :sub="errorCount > 0 ? '有失败服务' : '一切正常'"
      />
    </div>

    <!-- 服务卡片网格 -->
    <Motion
      as="div"
      :initial="false"
      :animate="{ transition: listStagger }"
      class="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3"
    >
      <ServiceCard
        v-for="(svc, idx) in store.services"
        :key="svc.id"
        :service="svc"
        :style="{ '--idx': idx }"
        @start="store.startService(svc.id)"
        @stop="store.stopService(svc.id)"
        @restart="store.restartService(svc.id)"
        @stop-external="store.stopExternalService(svc.id)"
        @restart-external="store.restartExternalService(svc.id)"
        @open="store.openServiceInBrowser(svc)"
        @edit="editingSvc = svc"
        @delete="store.deleteService(svc.id)"
      />
      <Motion
        v-if="store.services.length === 0"
        as="div"
        :initial="{ opacity: 0, y: 6 }"
        :animate="{ opacity: 1, y: 0 }"
        :transition="springCard"
        class="col-span-full flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-card/40 py-16 text-center"
      >
        <div class="text-4xl">📦</div>
        <div class="text-sm font-medium">还没有服务</div>
        <div class="text-xs text-muted-foreground">
          点右上角"添加服务"开始
        </div>
        <Button class="mt-3" size="sm" @click="showAdd = true">
          <Plus class="size-4" />
          添加第一个服务
        </Button>
      </Motion>
    </Motion>

    <AddServiceDialog
      v-if="showAdd || editingSvc"
      :editing="editingSvc"
      @close="showAdd = false; editingSvc = null"
      @added="onAdded"
    />
  </div>
</template>
