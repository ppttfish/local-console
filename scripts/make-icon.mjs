// 生成 256x256 PNG -> .ico
// 用 sharp 渲染 SVG，再转 ICO
import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'
import pngToIco from 'png-to-ico'
import sharp from 'sharp'

const svg = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0ea5e9"/>
      <stop offset="100%" stop-color="#8b5cf6"/>
    </linearGradient>
  </defs>
  <rect width="256" height="256" rx="56" fill="url(#g)"/>
  <g fill="#fff" transform="translate(40,52)">
    <!-- 闪电 / bolt -->
    <path d="M88 0 L0 144 L60 144 L36 224 L176 80 L112 80 Z" opacity="0.95"/>
  </g>
</svg>`

const outDir = 'build'
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })

const pngPath = 'build/icon.png'
const icoPath = 'build/icon.ico'

const buf = await sharp(Buffer.from(svg)).resize(256, 256).png().toBuffer()
writeFileSync(pngPath, buf)
console.log('wrote', pngPath, buf.length, 'bytes')

const ico = await pngToIco([buf])
writeFileSync(icoPath, ico)
console.log('wrote', icoPath, ico.length, 'bytes')
