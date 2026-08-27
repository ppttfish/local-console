# 小福鱼工作台 UI 现代化迁移方案

目标：把 renderer 从「纯手写 CSS」迁移到 **shadcn-vue + Tailwind CSS v4 + motion-v**，获得现代 SaaS 审美 + 弹簧微交互，同时不破坏现有功能。

> 本方案供新对话直接执行；执行前先通读一遍「约束红线」和「风险清单」。

---

## 0. 验收标准（做完要能回答）

- [ ] 视觉：5 个页面 + 4 个组件全部换成 shadcn 体系，亮/暗/跟随系统三态都正常
- [ ] 动效：卡片 hover/press 弹簧反馈、弹窗进出场、页面切换过渡
- [ ] 双端一致：Electron 桌面窗口 与 浏览器访问 `http://127.0.0.1:9600` 渲染一致
- [ ] `npm run typecheck`、`npm run build` 通过
- [ ] renderer JS 体积对照基线（当前 `assets/index-*.js` 约 784KB，其中 Chart.js 是大头），引入新体系后不应异常膨胀（预期 <1MB 量级）

## 1. 现状盘点

### 1.1 代码面（renderer 全部代码约 4000 行，规模很小，适合整体系迁移）

| 文件 | 行数 | 迁移重点 |
|---|---|---|
| `src/renderer/src/App.vue` | 80 | 骨架不动，2s 轮询逻辑不动 |
| `components/Sidebar.vue` | 181 | 导航骨架，最先迁移定调 |
| `components/ServiceCard.vue` | 464 | 视觉重灾区，做动效样板 |
| `components/AddServiceDialog.vue` | 303 | → shadcn Dialog/Form |
| `components/AddSubscriptionDialog.vue` | 320 | → shadcn Dialog/Form |
| `pages/Launchpad.vue` | 108 | 服务卡片列表容器 |
| `pages/Monitor.vue` | 185 | 指标卡 + 图表 |
| `pages/Usage.vue` | **1694** | 最大页：Chart.js 图表 + 筛选条 + 表格，最后迁移 |
| `pages/Logs.vue` | 185 | 日志流列表 |
| `pages/Settings.vue` | 174 | 表单 + 插件说明 |
| `styles/index.css` | 175 | 现有设计令牌（迁移后降级为兼容层，最终删除） |
| `composables/useTheme.ts` | ~50 | 主题切换，**保留不动**（继续写 `data-theme` 属性） |

### 1.2 现有设计令牌（`styles/index.css`）

亮色（`data-theme="light"` / 默认）与暗色（`data-theme="dark"` / `auto`+系统）两套，直接映射到 shadcn 令牌：

| 现有令牌 | 亮色值 | → shadcn 令牌 | 备注 |
|---|---|---|---|
| `--bg` | `#ffffff` | `--background` | |
| `--bg-soft` | `#f8fafc` | `--muted` / `--secondary` | 按用途二选一 |
| `--panel` | `#f1f5f9` | `--card` / `--muted` | |
| `--border` | `#e2e8f0` | `--border` | 同名，直接续用 |
| `--text` | `#0f172a` | `--foreground` | |
| `--muted` | `#64748b` | `--muted-foreground` | |
| `--accent` | `#0ea5e9` | `--primary` | **迁移时换成品牌蓝 `#2f6fde`**（与海报/设计基准一致；`#0ea5e9` 是旧值） |
| `--accent-soft` | `#e0f2fe` | `--primary-foreground` / 背景态 | |
| `--success` / `--warn` / `--danger` | 语义色 | `--success` / `--warning` / `--destructive` | 保留语义 |
| `--card` | `#ffffff` | `--card` / `--card-foreground` | |
| `--shadow` | 轻阴影 | Tailwind shadow 工具类 | 不再用变量 |

暗色一套照同样映射搬进 `[data-theme="dark"]` 段。

## 1.5 视觉预览（Phase 0：先看后迁，必须做）

动代码**之前**先用 gpt-image / 即梦出目标视觉 mockup，定调后再迁：

1. 出 4 张（存 `docs/mockups/`）：启动台主页（侧边栏+卡片网格）、添加服务弹窗、Token 用量页（筛选条+图表+表格）、暗色模式主页
2. 统一风格描述（每张提示词都带）：**shadcn/ui 风格，Neutral 基色，圆角中等偏大，细发丝边框，浅雾灰背景，主色电光蓝 #2f6fde，珊瑚橙点缀，紧凑的桌面效率工具布局，现代 SaaS 审美，扁平无拟物**
3. 用户挑 1~2 个方向 → 迁移按选定方向执行，mockup 图作为对照基准贴在对应页面迁移时参考
4. 4 张全带文字崩了没关系——mockup 只定「配色/圆角/布局/氛围」，文字最终由代码实现

## 2. 接入步骤（Phase 1：搭底座，不动业务代码）

```bash
# 1. 依赖（npm 包管理器；只加 dev 依赖的构建插件 + 运行时依赖）
npm i motion-v lucide-vue-next
npm i -D tailwindcss @tailwindcss/vite

# 2. shadcn-vue 初始化（交互式，问基色选 Neutral；路径问询时按下面 components.json 改）
npx shadcn-vue@latest init
```

`components.json`（init 生成后手工校准，本项目是 electron-vite 结构，不能信默认值）：

```json
{
  "$schema": "https://shadcn-vue.com/schema.json",
  "style": "new-york",
  "typescript": true,
  "tailwind": { "config": "", "css": "src/renderer/src/styles/globals.css" },
  "aliases": {
    "components": "@/components",
    "utils": "@/lib/utils",
    "ui": "@/components/ui",
    "lib": "@/lib",
    "hooks": "@/composables"
  },
  "iconLibrary": "lucide"
}
```

> `@/*` 别名已存在于 `tsconfig.web.json`（→ `src/renderer/src/*`），无需改。

`electron.vite.config.ts` 只给 **renderer** 加插件（main/preload 不能加）：

```ts
import tailwindcss from '@tailwindcss/vite'
// renderer: { plugins: [vue(), tailwindcss()], ... }
```

新建 `src/renderer/src/styles/globals.css`（`@theme inline` 里填 1.2 的映射表；暗色段沿用 `data-theme`，把 shadcn 默认的 `.dark` 变体改过来）：

```css
@import "tailwindcss";

/* 现有主题切换走 <html data-theme="light|dark|auto">，把 shadcn 的 dark 变体对齐 */
@custom-variant dark (&:where([data-theme="dark"], [data-theme="auto"] *));

@theme inline {
  --color-background: var(--background);
  /* ...全部令牌映射... */
}
```

拉首批组件（按需，别一次全拉）：

```bash
npx shadcn-vue@latest add button card dialog input select tabs switch badge tooltip dropdown-menu table separator skeleton scroll-area
```

## 3. 令牌迁移（Phase 2：双体系并存期）

- `useTheme.ts`、store 的 `theme` 字段、`data-theme` 写盘逻辑**一律不动**，只是把暗色判定换成上面的 `@custom-variant`。
- 期间 `index.css` 保留（老组件仍读旧变量），新组件全部吃新令牌；每完成一个页面迁移，就把该页用到的旧变量从 `index.css` 里删掉，最后整个文件删除。
- Tailwind **preflight** 会重置浏览器默认样式（button、input 等），老页面会有一次性闪变——所以顺序是「先 Sidebar/全局壳，后页面」，闪变期最短。

## 4. 页面迁移顺序（Phase 3）

按「定调 → 重灾区 → 低风险 → 最大」排序：

1. **Sidebar.vue** — 导航壳，定下间距/字体/高亮态
2. **ServiceCard.vue** — 做 motion-v 动效样板（见 Phase 4），同时验证卡片体系
3. **Launchpad.vue + AddServiceDialog + AddSubscriptionDialog** — 列表容器 + 两个弹窗表单
4. **Monitor.vue / Logs.vue / Settings.vue** — 指标卡、日志流、表单页
5. **Usage.vue 最后** — 1694 行最大；Chart.js/vue-chartjs **图表本体不动**，只换外层容器、筛选条（Select/Tabs/Switch）、表格（Table）；图表主题色通过 Chart.js 的 options 读新令牌变量，保证暗色下图表配色跟随

每页迁移守则：**只换表现层，业务逻辑一行不动**（`window.lcp` 调用、store、轮询、API 参数全部原样保留）。

## 5. 动效规范（Phase 4：motion-v）

统一用法（`import { Motion, AnimatePresence } from 'motion-v'`）：

- **弹簧参数统一**（抽到 `src/renderer/src/lib/motion.ts` 导出常量）：
  `transition: { type: 'spring', stiffness: 400, damping: 30 }`（按钮/卡片），弹窗类用 `{ type: 'spring', stiffness: 260, damping: 26 }`
- **卡片微交互**（ServiceCard 样板）：
  ```vue
  <Motion.div
    :initial="{ opacity: 0, y: 8 }"
    :animate="{ opacity: 1, y: 0 }"
    :whileHover="{ scale: 1.02 }"
    :whilePress="{ scale: 0.97 }"
    :transition="springCard"
  >
  ```
- **弹窗进出场**：`<AnimatePresence>` 包 `<Motion.div v-if="open" :exit="{ opacity: 0, scale: 0.96 }">`
- **列表项 stagger**：父容器 `:transition="{ staggerChildren: 0.03 }"`，子项 `variants` 延迟递增；**注意 2s 轮询刷新时 key 必须稳定**（用服务 id 而非索引），否则每次刷新整列重播动画
- **尊重系统减弱动效**：`@media (prefers-reduced-motion: reduce)` 下动画全关（shadcn 组件自身已带，motion-v 处用 `useReducedMotion()` 或 CSS 兜底）
- 图标统一 `lucide-vue-next`（shadcn-vue 默认图标库），替换现有手写 emoji/内联 svg

## 6. 验证（Phase 5）

按风险执行：

1. `npm run typecheck`（tsconfig.node + tsconfig.web 全过）
2. `npm run build` 出 `out/renderer`，检查 JS 产物体积
3. **双端手测**（renderer 改动只需 build + 浏览器刷新，见验证工作流记忆）：
   - 桌面端：`npm run dev` 起 Electron 窗口，或直接跑打包产物
   - Web 端：build 后 `npm run start:web`，浏览器开 `http://127.0.0.1:9600`
   - 两端口径：5 个页面都点一遍、弹窗开合、亮/暗/跟随系统三主题、托盘唤出
   - 注意用户常驻实例可能占着 9600，测试用独立端口/实例，**别动常驻实例**
4. 打包验证：`npm run dist:nsis -- --config.npmRebuild=false`（better-sqlite3 被常驻实例锁定时必须带）

## 7. 约束红线（绝不能碰）

- 主进程 `src/main/*`、preload、`src/preload/index.ts`、`web-bridge.ts`、`src/shared/*`、IPC 通道名——**零改动**
- `useTheme.ts` 的 `data-theme` 机制、store 的轮询/推送逻辑——不动
- Chart.js 图表本体、数据口径——不动
- 不引入新的样式库/框架（Tailwind 是唯一新增样式依赖）
- 迁移中不做无关重构（不改命名、不顺手优化业务逻辑），保持 diff 可读

## 8. 风险清单

| 风险 | 应对 |
|---|---|
| shadcn init 默认路径假设 `src/` 根 | 按第 2 节 components.json 手工校准 |
| Tailwind preflight 重置老组件样式 | 迁移顺序先壳后页；必要时临时给老区域加 `@layer base` 兜底 |
| `file://` 协议（Electron loadFile）下资源加载 | 全部走相对路径/打包内资源，不用绝对 URL |
| 2s 轮询导致列表动画重播 | 列表 key 用稳定 id；动画只在挂载时播一次 |
| 暗色下 Chart.js 配色 | 图表 options 读新令牌变量，随 `data-theme` 变化重绘 |
| 打包体积膨胀 | 按需 `add` 组件（shadcn 是复制进仓库的，天然 tree-shaking）；验收基线第 0 节 |
| motion-v 在 Vue SFC 的 `<Motion.div>` 写法需显式 import | 不要依赖 auto-import，统一 `import { Motion, AnimatePresence } from 'motion-v'` |