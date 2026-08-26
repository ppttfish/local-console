# MCP 工具清单（v1）

本地总台通过 stdio 暴露 8 个 MCP 工具给 agent。
工具名前缀 `pws_`（personal workstation）。

## pws_list_services

**说明**：列出所有受管服务的当前状态。

**输入**：无

**输出**：
```json
[
  {
    "id": "6b13399e",
    "name": "opc-dashboard 前端",
    "status": "running",
    "pid": 39768,
    "port": 5173,
    "cwd": "F:/opc/opc-dashboard",
    "command": "npm run dev",
    ...
  }
]
```

**agent 用法**：
- "我本机现在跑了哪些服务？"
- "opc-dashboard 在跑吗？"

## pws_start_service

**说明**：按 ID 或名称启动服务。

**输入**：
```json
{
  "id": "6b13399e",          // 可选
  "name": "opc-dashboard 前端" // 可选；id 优先
}
```

**输出**：
```json
{ "ok": true, "pid": 39768 }
```

## pws_stop_service

**说明**：停止服务（优雅终止，5s 后强杀）。

**输入**：`{ id?, name? }`

## pws_restart_service

**说明**：先 stop 后 start（间隔 500ms）。

**输入**：`{ id?, name? }`

## pws_service_logs

**说明**：读取服务最近 N 行日志。

**输入**：
```json
{
  "id": "6b13399e",
  "tail": 200     // 默认 200，范围 10-5000
}
```

**输出**：纯文本日志。

## pws_scan_ports

**说明**：扫描本机所有 LISTEN 端口 + 占用进程。

**输入**：无

**输出**：
```json
[
  { "port": 5173, "pid": 39768, "process_name": "node.exe",
    "cmd": "vite", "app_id": "6b13399e", "app_name": "opc-dashboard 前端" },
  ...
]
```

**agent 用法**：
- "我 3000 端口被谁占了？"
- "本机有哪些没被纳管的端口？"

## pws_add_service

**说明**：把新服务加到启动台。

**输入**：
```json
{
  "name": "my-app",
  "cwd": "F:/opc/my-app",
  "command": "npm run dev",
  "port": 3000,              // 可选
  "kind": "service"          // service | task
}
```

## pws_delete_service

**说明**：删除服务（不会杀正在跑的进程）。

**输入**：`{ id?, name? }`

## 错误约定

- `isError: true` 表示调用失败；`content[0].text` 是人类可读错误信息
- 找不到服务时返回 `未找到服务: <key>`
- 启动失败时返回 `{ ok: false, error: "..." }`
