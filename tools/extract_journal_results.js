// 一次性工具：从 workflow journal 里把 result 事件取出来，按行切成可读的分片。
//
// 为什么需要它：单个 result 事件存的是 agent 的**完整返回对象**（document 正文 + cards），
// 一整行 JSON 可达数万 token，超出 Read 工具的单次上限，而 workflow 脚本本身没有文件系统权限、
// 产物也不会自动落盘。这个脚本负责把 journal 里的 payload 摊平成普通文件。
//
// 用法：
//   node tools/extract_journal_results.js <journal.jsonl> <unit> [<unit> ...]
// 产物写到 <journal 同目录>/extracted/<unit>.json 与 <unit>.document.md

const fs = require('node:fs')
const path = require('node:path')

const [journalPath, ...wanted] = process.argv.slice(2)
if (!journalPath || !wanted.length) {
  console.error('用法: node tools/extract_journal_results.js <journal.jsonl> <unit> [...]')
  process.exit(2)
}

const outDir = path.join(path.dirname(journalPath), 'extracted')
fs.mkdirSync(outDir, { recursive: true })

const lines = fs.readFileSync(journalPath, 'utf8').split('\n')
const found = new Set()

lines.forEach((line, i) => {
  if (!line.trim()) return
  let event
  try {
    event = JSON.parse(line)
  } catch {
    return
  }
  if (event.type !== 'result') return
  const payload = event.result
  if (!payload || typeof payload !== 'object') return
  if (!wanted.includes(payload.unit)) return

  // 整个返回对象原样落盘，便于核对没被截断
  const jsonPath = path.join(outDir, `${payload.unit}.json`)
  fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2))
  // document 单独落一份，方便直接看正文
  const docPath = path.join(outDir, `${payload.unit}.document.md`)
  fs.writeFileSync(docPath, payload.document || '')
  found.add(payload.unit)

  const cards = payload.cards || []
  console.log(
    `line ${i + 1}: ${payload.unit} -> ${jsonPath}\n` +
      `  cards=${cards.length} search_available=${payload.search_available} ` +
      `document=${(payload.document || '').length} chars unresolved=${(payload.unresolved || '').length} chars`
  )
})

const missing = wanted.filter((u) => !found.has(u))
if (missing.length) {
  console.error(`未在 journal 里找到 result：${missing.join(', ')}`)
  process.exit(1)
}
