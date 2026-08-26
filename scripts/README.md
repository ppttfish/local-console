# 本地总台 —— 快速启动脚本

**目标：把 `dist/win-unpacked/local-console.exe` 装成你的本机常驻服务。**
**完全不动源码、不打包、不联网。**

## 4 个脚本

| 脚本 | 作用 | 何时用 |
|---|---|---|
| `start.bat` | 后台启动 `local-console.exe` | 想用时 |
| `stop.bat` | 杀掉所有 `local-console.exe` 进程 | 想关时 |
| `status.bat` | 看进程 / 9600 端口 / 开机自启 | 不确定是否在跑 |
| `autostart.bat` | 开机自启开关 (on / off / status) | 一次性设好 |

## 推荐一次性设置

```cmd
:: 1. 启动一次（生成数据目录 + tray）
scripts\start.bat

:: 2. 设置开机自启（写 HKCU\Run，不需管理员）
scripts\autostart.bat on

:: 3. 验证
scripts\status.bat
```

之后每次开机 → 自动后台起 → 托盘图标 → 浏览器 `http://127.0.0.1:9600` 同步可用。

## 用法细节

### 启动
```cmd
scripts\start.bat
```
- 已在跑会提示"已在跑，无需重复启动"
- 后台起，不弹黑窗
- 关窗口 = 隐藏到托盘（不是退出，进程继续在）
- 完全退出：`scripts\stop.bat`

### 状态
```cmd
scripts\status.bat
```
- 看 3 个 local-console.exe 进程在不在
- 看 9600 LISTEN 在不在
- 看开机自启 HKCU 注册项在不在

### 开机自启
```cmd
scripts\autostart.bat on      :: 注册到 HKCU\...\Run\LocalConsole
scripts\autostart.bat off     :: 移除
scripts\autostart.bat status  :: 查询
```
- 不需要管理员权限（写当前用户注册表）
- 启动命令带 `--hidden` 参数，桌面不弹窗
- 真正退出靠 `scripts\stop.bat` 或右键托盘 → 退出

## 数据位置

```
%APPDATA%\Local Console\
├── state.db              # SQLite: services / run_history / agent_usage
├── startup.log           # 启动 + 运行日志（排查用）
├── model-pricing.json    # 模型定价（首次启动从代码生成）
└── logs/                 # 启动台里各服务的日志
```

## 升级 / 重新编译（什么时候要动源码）

| 场景 | 动作 |
|---|---|
| 改源码 (`src/`) | `npm run build` → 重新走打包流程 |
| 改依赖 (`package.json`) | `npm install` → `npm run build` |
| 完全不动 | 直接用现有 `dist/win-unpacked/local-console.exe` |

**日常使用 ≠ 改源码 ≠ 打包**。这台机器现在就有完整可用版本。

## 没做自动升级的原因

当前版本是 `0.2.0`。要加自动升级得：
1. 引入 `electron-updater` 包
2. 配 publish 到 GitHub Releases（需要 token）
3. 打 tag 触发发布
4. 写升级 UI 弹窗

不打算现在做——本机手动 `git pull && npm run build` 即可，绿色版 exe 替换就完事。
