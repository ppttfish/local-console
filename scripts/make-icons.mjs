// 从源 logo PNG 生成全套图标：
//   build/icon.png                  electron-builder 打包图标源
//   build/icon.ico                  exe / 窗口标题栏 / 托盘图标（多尺寸）
//   src/renderer/public/favicon.ico web 版浏览器标签页图标
// 用法: node scripts/make-icons.mjs <source.png>
import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import pngToIco from 'png-to-ico'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const src = process.argv[2]
if (!src) {
  console.error('usage: node scripts/make-icons.mjs <source.png>')
  process.exit(1)
}

// Windows ico 标准尺寸链；png-to-ico 只接受方形、≤256 的 PNG
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]

// 源图四角不透明（AI 生成图自带浅色底），直接当桌面图标会是一块硬方块。
// 处理：先放大 8% 再居中裁切，把源图自带的圆角边推出裁切区外，
// 然后套 Windows 11 风格的 22% 圆角遮罩，四角全透明。
async function roundedBadge(src, size) {
  const zoom = 1.08
  const big = Math.round(size * zoom)
  const off = Math.round((big - size) / 2)
  const zoomed = await sharp(src).resize(big, big).png().toBuffer()
  const r = Math.round(size * 0.22)
  const mask = Buffer.from(
    `<svg width="${size}" height="${size}"><rect width="${size}" height="${size}" rx="${r}" ry="${r}"/></svg>`
  )
  return sharp(zoomed)
    .extract({ left: off, top: off, width: size, height: size })
    .composite([{ input: mask, blend: 'dest-in' }])
    .png()
    .toBuffer()
}

const resized = await Promise.all(ICO_SIZES.map((s) => roundedBadge(src, s)))

mkdirSync(resolve(root, 'build'), { recursive: true })
await roundedBadge(src, 512).then((buf) =>
  writeFileSync(resolve(root, 'build/icon.png'), buf)
)
writeFileSync(resolve(root, 'build/icon.ico'), await pngToIco(resized))

mkdirSync(resolve(root, 'src/renderer/public'), { recursive: true })
const favSizes = [16, 32, 48, 64]
const favIco = await pngToIco(favSizes.map((s) => resized[ICO_SIZES.indexOf(s)]))
writeFileSync(resolve(root, 'src/renderer/public/favicon.ico'), favIco)

console.log('done: build/icon.png, build/icon.ico, src/renderer/public/favicon.ico')
