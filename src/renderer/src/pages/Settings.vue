<script setup lang="ts">
/**
 * 设置页
 *  - 用 Tabs 把信息分组：本机 / 升级 / 快捷操作 / MCP / 插件
 *  - 危险操作（退出）用 destructive variant + 确认弹窗
 */
import { ref, onMounted } from 'vue'
import { Motion } from 'motion-v'
import {
  RefreshCw,
  FolderOpen,
  PowerOff,
  AppWindow,
  Sparkles,
  Cable,
  Puzzle
} from 'lucide-vue-next'
import { useAppStore } from '@/stores/app'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
  Button,
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
  Badge,
  Separator,
  DialogRoot,
  DialogPortal,
  DialogOverlay,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter
} from '@/components/ui'
import { springCard } from '@/lib/motion'

const store = useAppStore()

interface UpdateStatus {
  currentVersion: string
  lastCheck: { at: number; result: string; newVersion?: string; error?: string } | null
  downloaded: boolean
  pendingVersion?: string
}

const updateStatus = ref<UpdateStatus | null>(null)
const checking = ref(false)
const checkResult = ref<string>('')

async function loadStatus() {
  try {
    updateStatus.value = await (window as unknown as {
      lcp: { getUpdateStatus: () => Promise<UpdateStatus> }
    }).lcp.getUpdateStatus()
  } catch {
    // ignore
  }
}

async function checkUpdate() {
  if (checking.value) return
  checking.value = true
  checkResult.value = ''
  try {
    const r = await (window as unknown as {
      lcp: { checkUpdate: () => Promise<{ status: string; version?: string; error?: string }> }
    }).lcp.checkUpdate()
    if (r.status === 'available') {
      checkResult.value = `发现新版本 v${r.version}，主进程将弹出升级窗口`
    } else if (r.status === 'no-update') {
      checkResult.value = '当前已是最新版本'
    } else if (r.status === 'dev-skip') {
      checkResult.value = '开发模式，跳过检查'
    } else {
      checkResult.value = `检查失败：${r.error ?? r.status}`
    }
    await loadStatus()
  } catch (e) {
    checkResult.value = `错误：${(e as Error).message}`
  } finally {
    checking.value = false
  }
}

onMounted(loadStatus)

// 退出确认
const showQuitConfirm = ref(false)
const quitting = ref(false)
async function doQuit() {
  quitting.value = true
  try {
    await store.quit()
  } finally {
    quitting.value = false
  }
}

const mcpTools = [
  { name: 'pws_list_services', desc: '列出所有服务' },
  { name: 'pws_start_service / pws_stop_service / pws_restart_service', desc: '启停 / 重启服务' },
  { name: 'pws_service_logs', desc: '读取服务日志' },
  { name: 'pws_scan_ports', desc: '扫描所有监听端口' },
  { name: 'pws_add_service / pws_delete_service', desc: '新增 / 删除服务' }
]
</script>

<template>
  <div class="flex flex-col gap-5 p-8">
    <header>
      <h1 class="text-2xl font-semibold tracking-tight">设置</h1>
      <p class="mt-1 text-sm text-muted-foreground">本机配置与插件入口</p>
    </header>

    <Tabs default-value="info" class="gap-4">
      <TabsList class="self-start">
        <TabsTrigger value="info">
          <AppWindow class="size-3.5" />
          本机
        </TabsTrigger>
        <TabsTrigger value="update">
          <Sparkles class="size-3.5" />
          升级
        </TabsTrigger>
        <TabsTrigger value="actions">
          <PowerOff class="size-3.5" />
          快捷操作
        </TabsTrigger>
        <TabsTrigger value="mcp">
          <Cable class="size-3.5" />
          MCP
        </TabsTrigger>
        <TabsTrigger value="plugins">
          <Puzzle class="size-3.5" />
          插件
        </TabsTrigger>
      </TabsList>

      <TabsContent value="info">
        <Motion
          as-child
          :initial="{ opacity: 0, y: 6 }"
          :animate="{ opacity: 1, y: 0 }"
          :transition="springCard"
        >
          <Card>
            <CardHeader>
              <CardTitle>本机信息</CardTitle>
              <CardDescription>当前安装与数据位置</CardDescription>
            </CardHeader>
            <CardContent class="grid grid-cols-1 gap-3 sm:grid-cols-[140px_1fr]">
              <span class="text-xs text-muted-foreground">应用名</span>
              <span class="text-sm">{{ store.appInfo?.name }}</span>
              <Separator class="sm:col-span-2" />
              <span class="text-xs text-muted-foreground">版本</span>
              <span class="font-mono text-sm">
                {{ updateStatus?.currentVersion ?? store.appInfo?.version }}
              </span>
              <Separator class="sm:col-span-2" />
              <span class="text-xs text-muted-foreground">数据目录</span>
              <code
                class="break-all rounded bg-muted px-2 py-1 font-mono text-xs"
                >{{ store.appInfo?.dataDir }}</code
              >
              <Separator class="sm:col-span-2" />
              <span class="text-xs text-muted-foreground">日志目录</span>
              <code
                class="break-all rounded bg-muted px-2 py-1 font-mono text-xs"
                >{{ store.appInfo?.logDir }}</code
              >
            </CardContent>
          </Card>
        </Motion>
      </TabsContent>

      <TabsContent value="update">
        <Motion
          as-child
          :initial="{ opacity: 0, y: 6 }"
          :animate="{ opacity: 1, y: 0 }"
          :transition="springCard"
        >
          <Card>
            <CardHeader>
              <CardTitle>自动升级</CardTitle>
              <CardDescription>通过 GitHub Releases 检查新版</CardDescription>
            </CardHeader>
            <CardContent class="flex flex-col gap-3">
              <p class="text-sm text-muted-foreground">
                检查到新版本时主进程会自动弹窗。
              </p>
              <div class="flex flex-wrap items-center gap-2">
                <Button :disabled="checking" @click="checkUpdate">
                  <RefreshCw
                    :class="['size-4', checking && 'animate-spin']"
                  />
                  {{ checking ? '检查中…' : '检查更新' }}
                </Button>
                <Badge
                  v-if="updateStatus?.lastCheck"
                  variant="muted"
                  class="font-normal"
                >
                  上次检查: {{ new Date(updateStatus.lastCheck.at).toLocaleString() }}
                  · {{ updateStatus.lastCheck.result }}
                </Badge>
              </div>
              <p
                v-if="checkResult"
                :class="[
                  'text-sm',
                  (checkResult.includes('最新') || checkResult.includes('发现'))
                    ? 'text-success'
                    : 'text-muted-foreground'
                ]"
              >
                {{ checkResult }}
              </p>
            </CardContent>
          </Card>
        </Motion>
      </TabsContent>

      <TabsContent value="actions">
        <Motion
          as-child
          :initial="{ opacity: 0, y: 6 }"
          :animate="{ opacity: 1, y: 0 }"
          :transition="springCard"
        >
          <Card>
            <CardHeader>
              <CardTitle>快捷操作</CardTitle>
              <CardDescription>一键打开本机数据 / 退出应用</CardDescription>
            </CardHeader>
            <CardContent class="flex flex-wrap gap-2">
              <Button variant="outline" @click="store.openDataDir()">
                <FolderOpen class="size-4" />
                打开数据目录
              </Button>
              <Button variant="outline" @click="store.openLogDir()">
                <FolderOpen class="size-4" />
                打开日志目录
              </Button>
              <Button variant="destructive" @click="showQuitConfirm = true">
                <PowerOff class="size-4" />
                退出应用
              </Button>
            </CardContent>
          </Card>
        </Motion>
      </TabsContent>

      <TabsContent value="mcp">
        <Motion
          as-child
          :initial="{ opacity: 0, y: 6 }"
          :animate="{ opacity: 1, y: 0 }"
          :transition="springCard"
        >
          <Card>
            <CardHeader>
              <CardTitle>MCP 集成</CardTitle>
              <CardDescription
                >小福鱼已内置 MCP server，agent 可通过 stdio 直接调用以下工具：</CardDescription
              >
            </CardHeader>
            <CardContent class="flex flex-col gap-3">
              <ul class="flex flex-col gap-2 text-sm">
                <li
                  v-for="t in mcpTools"
                  :key="t.name"
                  class="flex items-baseline gap-3"
                >
                  <code
                    class="shrink-0 rounded bg-muted px-2 py-0.5 font-mono text-[12px]"
                    >{{ t.name }}</code
                  >
                  <span class="text-muted-foreground">{{ t.desc }}</span>
                </li>
              </ul>
              <Separator />
              <p class="text-xs text-muted-foreground">
                在 Claude / Codex 等客户端 MCP 配置中，将命令设为：
              </p>
              <code
                class="block w-fit rounded bg-muted px-2 py-1 font-mono text-xs"
                >local-console-mcp</code
              >
              <p class="text-[11px] text-muted-foreground">
                （npm 安装后全局可用）
              </p>
            </CardContent>
          </Card>
        </Motion>
      </TabsContent>

      <TabsContent value="plugins">
        <Motion
          as-child
          :initial="{ opacity: 0, y: 6 }"
          :animate="{ opacity: 1, y: 0 }"
          :transition="springCard"
        >
          <Card>
            <CardHeader>
              <CardTitle>插件</CardTitle>
              <CardDescription>扩展小福鱼的能力</CardDescription>
            </CardHeader>
            <CardContent>
              <p class="text-sm text-muted-foreground">
                v1 已搭好插件骨架。v2 第一个官方插件：
                <code class="rounded bg-muted px-1.5 py-0.5 font-mono text-xs"
                  >token-usage</code
                >，统计本机 agent token 用量。
              </p>
            </CardContent>
          </Card>
        </Motion>
      </TabsContent>
    </Tabs>

    <!-- 退出确认 -->
    <DialogRoot v-model:open="showQuitConfirm">
      <DialogPortal>
        <DialogOverlay />
        <DialogContent class="max-w-[420px]">
          <DialogHeader>
            <DialogTitle>退出小福鱼？</DialogTitle>
            <DialogDescription>
              所有托管服务的子进程会一并结束；外部进程不受影响。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              :disabled="quitting"
              @click="showQuitConfirm = false"
            >取消</Button>
            <Button
              variant="destructive"
              :disabled="quitting"
              @click="doQuit"
            >
              <PowerOff class="size-4" />
              {{ quitting ? '退出中…' : '确认退出' }}
            </Button>
          </DialogFooter>
        </DialogContent>
      </DialogPortal>
    </DialogRoot>
  </div>
</template>
