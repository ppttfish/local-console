<script setup lang="ts">
/**
 * 服务监控
 *  - 顶部 KPI 卡（总CPU/内存/未纳管端口/运行中）
 *  - 端口占用表（shadcn Table + 行内「加入看板」动作）
 *  - 保留时间戳 + 2s 轮询刷新
 */
import { computed, ref } from 'vue'
import { Server, Plug, Cpu, MemoryStick, Plus } from 'lucide-vue-next'
import { useAppStore } from '@/stores/app'
import type { PortSnapshot } from '@shared/types'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
  Button,
  Badge,
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell
} from '@/components/ui'
import KpiCard from '@/components/KpiCard.vue'
import AddServiceDialog from '@/components/AddServiceDialog.vue'

const store = useAppStore()

const top = computed(() => {
  return [...store.ports].sort((a, b) => a.port - b.port).slice(0, 50)
})

const showAdd = ref(false)
const portToAdopt = ref<PortSnapshot | null>(null)

function adopt(p: PortSnapshot) {
  portToAdopt.value = p
  showAdd.value = true
}

function onAdded() {
  showAdd.value = false
  portToAdopt.value = null
}
</script>

<template>
  <div class="flex flex-col gap-5 p-8">
    <header class="flex items-end justify-between">
      <div>
        <h1 class="text-2xl font-semibold tracking-tight">服务监控</h1>
        <p class="mt-1 text-sm text-muted-foreground">
          每 2 秒自动刷新 · 总 CPU {{ store.totalCpu.toFixed(1) }}% ·
          内存 {{ store.totalMem.toFixed(1) }}%
        </p>
      </div>
    </header>

    <!-- KPI -->
    <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <KpiCard
        label="运行中"
        :value="store.runningServices.length"
        :icon="Server"
        icon-tone="primary"
        :sub="`共 ${store.services.length} 个服务`"
      />
      <KpiCard
        label="未纳管端口"
        :value="store.unmanagedPorts.length"
        :icon="Plug"
        icon-tone="warning"
        sub="可一键加入看板"
      />
      <KpiCard
        label="总 CPU"
        :value="`${store.totalCpu.toFixed(1)}%`"
        :icon="Cpu"
        icon-tone="primary"
        sub="所有托管服务"
      />
      <KpiCard
        label="总内存"
        :value="`${store.totalMem.toFixed(1)}%`"
        :icon="MemoryStick"
        icon-tone="primary"
        sub="所有托管服务"
      />
    </div>

    <!-- 端口占用表 -->
    <Card>
      <CardHeader>
        <CardTitle>端口占用</CardTitle>
        <CardDescription>前 50 个按端口号排序</CardDescription>
      </CardHeader>
      <CardContent class="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead class="w-20">端口</TableHead>
              <TableHead>进程</TableHead>
              <TableHead class="w-24">PID</TableHead>
              <TableHead>应用</TableHead>
              <TableHead>命令</TableHead>
              <TableHead class="w-28 text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow
              v-for="p in top"
              :key="`${p.pid}:${p.port}`"
              class="[&>td]:py-2.5"
            >
              <TableCell>
                <code
                  class="rounded bg-muted px-1.5 py-0.5 font-mono text-[11.5px] font-bold"
                  >:{{ p.port }}</code
                >
              </TableCell>
              <TableCell class="font-medium">{{ p.process_name }}</TableCell>
              <TableCell>
                <code class="font-mono text-[12px] text-muted-foreground">
                  {{ p.pid }}
                </code>
              </TableCell>
              <TableCell>
                <Badge v-if="p.app_id" variant="success">
                  已纳管 · {{ p.app_name }}
                </Badge>
                <span v-else class="text-xs text-muted-foreground">—</span>
              </TableCell>
              <TableCell class="max-w-[320px]">
                <span
                  class="block truncate font-mono text-[12px] text-muted-foreground"
                  :title="p.cmd"
                >
                  {{ p.cmd || '—' }}
                </span>
              </TableCell>
              <TableCell class="text-right">
                <Button
                  v-if="!p.app_id"
                  size="sm"
                  variant="outline"
                  title="用这个端口的进程信息建一个服务条目"
                  @click="adopt(p)"
                >
                  <Plus class="size-3.5" />
                  加入看板
                </Button>
                <span v-else class="text-xs text-muted-foreground">—</span>
              </TableCell>
            </TableRow>
            <TableRow v-if="top.length === 0">
              <TableCell colspan="6" class="py-10 text-center text-sm text-muted-foreground">
                暂无监听端口
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </CardContent>
    </Card>

    <AddServiceDialog
      v-if="showAdd"
      :from-port="portToAdopt"
      @close="onAdded"
      @added="onAdded"
    />
  </div>
</template>
