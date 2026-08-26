<script setup lang="ts">
import { useAppStore } from '../stores/app'

const store = useAppStore()
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
        <tr><td class="muted">版本</td><td>{{ store.appInfo?.version }}</td></tr>
        <tr><td class="muted">数据目录</td><td><code>{{ store.appInfo?.dataDir }}</code></td></tr>
        <tr><td class="muted">日志目录</td><td><code>{{ store.appInfo?.logDir }}</code></td></tr>
      </table>
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
      <p class="muted">本地总台已内置 MCP server，agent 可通过 stdio 直接调用以下工具：</p>
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
</style>
