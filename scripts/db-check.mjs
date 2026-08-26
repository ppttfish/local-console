// 直接查 DB 看真实数据（5 个 agent 都有没有）
import Database from 'better-sqlite3'
import { homedir } from 'node:os'
import { join } from 'node:path'

const userData = join(process.env.LOCAL_CONSOLE_DATA_DIR || process.env.APPDATA || homedir(), 'local-console')
const dbPath = join(userData, 'state.db')
console.log('DB:', dbPath)

const db = new Database(dbPath, { readonly: true, fileMustExist: true })

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
console.log('tables:', tables.map(t => t.name).join(', '))

const cols = db.prepare('PRAGMA table_info(agent_usage)').all()
console.log('cols:', cols.map(c => c.name).join(', '))

const byAgent = db.prepare(`
  SELECT agent, COUNT(*) as calls,
    SUM(input_tokens) as inp, SUM(output_tokens) as out,
    SUM(cached_tokens) as cached, SUM(cost_usd) as cost
  FROM agent_usage GROUP BY agent ORDER BY cost DESC
`).all()
console.log('by_agent:')
for (const r of byAgent) {
  console.log(`  ${r.agent}: ${r.calls} calls, in=${r.inp}, out=${r.out}, cached=${r.cached}, cost=$${(r.cost||0).toFixed(2)}`)
}

const byModel = db.prepare(`
  SELECT model, COUNT(*) as calls, SUM(cost_usd) as cost
  FROM agent_usage GROUP BY model ORDER BY cost DESC LIMIT 10
`).all()
console.log('by_model (top 10):')
for (const r of byModel) {
  console.log(`  ${r.model}: ${r.calls} calls, $${(r.cost||0).toFixed(4)}`)
}

const total = db.prepare('SELECT COUNT(*) as c, SUM(cost_usd) as cost FROM agent_usage').get()
console.log(`TOTAL: ${total.c} rows, $${(total.cost||0).toFixed(2)}`)

db.close()
