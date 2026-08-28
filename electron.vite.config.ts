import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'node:path'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    },
    build: {
      outDir: 'out/main',
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          'mcp/standalone': resolve('src/main/mcp/standalone.ts'),
          'http-standalone': resolve('src/main/http-standalone.ts')
        },
        output: {
          /**
           * 主进程输出 CJS。
           *
           * 原因：ESM 主进程 + 本地开发环境会崩 —— Electron 的 ESM loader 在解析
           * node_modules 里的 `electron` CJS 包时触发 Node 20 的
           * cjsPreparseModuleExports bug（module.exports undefined）。
           * 打包成 asar 后 `electron` 包不在依赖里、走 Electron 内置模块，所以
           * 安装版能跑、`npm run dev` / `electron .` 却起不来。
           * CJS 是 Electron 主进程最标准的形态，且源码只用 __dirname、没有
           * import.meta，切换零成本。
           * package.json 是 "type": "module"，必须用 .cjs 扩展名才会被当 CJS。
           */
          format: 'cjs',
          entryFileNames: '[name].cjs',
          chunkFileNames: 'chunks/[name].cjs'
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/preload',
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts') },
        output: {
          format: 'cjs',
          entryFileNames: 'index.cjs'
        }
      }
    }
  },
  renderer: {
    root: 'src/renderer',
    resolve: {
      alias: {
        '@': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [vue(), tailwindcss()],
    build: {
      outDir: 'out/renderer',
      chunkSizeWarningLimit: 800,
      rollupOptions: {
        input: { index: resolve('src/renderer/index.html') },
        output: {
          /**
           * 手动分包。之前所有依赖加业务代码打成一个 1.7MB 的 chunk，
           * 首屏必须整包解析完才能渲染。拆开之后：
           *   ui / motion —— 所有页面共用，长期命中缓存
           *   chart —— 只有 Token 用量页用到，跟着那条路由懒加载
           */
          manualChunks(id: string): string | undefined {
            // Windows 下 id 用反斜杠，先归一，否则下面的前缀匹配全部失效
            const p = id.replace(/\\/g, '/')
            if (!p.includes('/node_modules/')) return undefined
            // 图表只在 Token 用量页用到，且体积最大，单独拆出去跟着路由懒加载
            if (p.includes('/node_modules/chart.js') || p.includes('/node_modules/vue-chartjs')) {
              return 'chart'
            }
            // UI 基础库：所有页面共用，长期命中缓存
            if (p.includes('/node_modules/reka-ui') || p.includes('/node_modules/lucide-vue-next')) {
              return 'ui'
            }
            // motion 全家桶必须整体成组。只挑 motion-v 会把 motion-dom /
            // motion-utils 留在 vendor 里，形成 motion -> vendor -> motion 的循环 chunk
            if (p.includes('/node_modules/motion') || p.includes('/node_modules/framer-motion')) {
              return 'motion'
            }
            return 'vendor'
          }
        }
      }
    }
  }
})
