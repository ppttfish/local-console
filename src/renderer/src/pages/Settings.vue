<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useAppStore } from '../stores/app'

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
</script>

<template>
  <div class="settings">
    <header class="page-header">
      <h1>设置</h1>
      <p class="muted">本机配置与插件入口</p>
    </header>

    <div class="card">
      <h3>本机信息</h3>
      <table class="info">
        <tr><td class="muted">应用名</td><td>{{ store.appInfo?.name }}</td></tr>
        <tr><td class="muted">版本</td><td>{{ updateStatus?.currentVersion ?? store.appInfo?.version }}</td></tr>
        <tr><td class="muted">数据目录</td><td><code>{{ store.appInfo?.dataDir }}</code></td></tr>
        <tr><td class="muted">日志目录</td><td><code>{{ store.appInfo?.logDir }}</code></td></tr>
      </table>
    </div>

    <div class="card">
      <h3>自动升级</h3>
      <p class="muted">通过 GitHub Releases 检查新版。检查到新版本时主进程会自动弹窗。</p>
      <div class="actions">
        <button :disabled="checking" @click="checkUpdate">
          {{ checking ? '检查中...' : '检查更新' }}
        </button>
        <span v-if="updateStatus?.lastCheck" class="muted small">
          上次检查: {{ new Date(updateStatus.lastCheck.at).toLocaleString() }}
          ({{ updateStatus.lastCheck.result }})
        </span>
      </div>
      <p v-if="checkResult" class="small" :class="{ ok: checkResult.includes('最新') || checkResult.includes('发现') }">
        {{ checkResult }}
      </p>
    </div>

    <div class="card">
      <h3>快捷操作</h3>
      <div class="actions">
        <button @click="store.openDataDir()">打开数据目录</button>
        <button @click="store.openLogDir()">打开日志目录</button>
        <button class="danger" @click="store.quit()">退出应用</button>
      </div>
    </div>

    <div class="card">
      <h3>MCP 集成</h3>
      <p class="muted">小福鱼已内置 MCP server，agent 可通过 stdio 直接调用以下工具：</p>
      <ul class="mcp-list">
        <li><code>pws_list_services</code> — 列出所有服务</li>
        <li><code>pws_start_service</code> / <code>pws_stop_service</code> / <code>pws_restart_service</code></li>
        <li><code>pws_service_logs</code> — 读取服务日志</li>
        <li><code>pws_scan_ports</code> — 扫描所有监听端口</li>
        <li><code>pws_add_service</code> / <code>pws_delete_service</code></li>
      </ul>
      <p class="muted small">在 Claude / Codex 等客户端 MCP 配置中，将命令设为：<br><code>local-console-mcp</code>（npm 安装后全局可用）</p>
    </div>

    <div class="card">
      <h3>插件</h3>
      <p class="muted">v1 已搭好插件骨架。v2 第一个官方插件：<code>token-usage</code>，统计本机 agent token 用量。</p>
    </div>
  </div>
</template>

<style scoped>
.settings {
  display: flex;
  flex-direction: column;
  gap: 14px;
  max-width: 720px;
}
.page-header h1 {
  margin: 0;
  font-size: 22px;
}
.page-header p {
  margin: 4px 0 0;
  font-size: 13px;
}
h3 {
  margin: 0 0 10px;
  font-size: 14px;
}
.info {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.info td {
  padding: 4px 8px;
}
.info td:first-child {
  width: 100px;
}
code {
  font-family: 'Geist Mono', Consolas, monospace;
  font-size: 12px;
  background: var(--bg-soft);
  padding: 1px 6px;
  border-radius: 4px;
}
.actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  align-items: center;
}
.mcp-list {
  margin: 8px 0;
  padding-left: 20px;
  font-size: 13px;
  line-height: 1.8;
}
.small {
  font-size: 12px;
}
.ok {
  color: #10b981;
}
</style>
