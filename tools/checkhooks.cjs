// 静态检查：组件里的 Hook 是否写在了提前 return 之后。
// React 规定 Hook 顺序必须稳定；一旦 Hook 出现在 `if (...) return ...` 之后，
// form 从 null 变成对象的那一次渲染就会抛
// "Rendered more hooks than during the previous render."，整个设置页变空白。
const fs = require('fs')
const file = process.argv[2] || 'C:/Users/z/Desktop/新建文件夹/live2d-stage/client.js'
const L = fs.readFileSync(file, 'utf8').split(/\r?\n/)

function component(name) {
  const s = L.findIndex((l) => /^\s*function [A-Za-z0-9_]+\(/.test(l) && l.includes('function ' + name + '('))
  if (s < 0) return console.log(name, 'not found')
  const indent = (L[s].match(/^\s*/) || [''])[0].length
  let depth = 0
  let end = s
  for (let i = s; i < L.length; i++) {
    for (const ch of L[i]) {
      if (ch === '{') depth++
      else if (ch === '}') depth--
    }
    if (depth === 0 && i > s + 2) { end = i; break }
  }
  const retRe = new RegExp('^' + ' '.repeat(indent + 2) + '(if \\(|return\\b)')
  let first = null
  const hooks = []
  for (let i = s; i <= end; i++) {
    const l = L[i]
    if (retRe.test(l)) { if (first === null) first = i + 1 }
    if (/React\.use[A-Za-z]+\(/.test(l)) hooks.push(i + 1)
  }
  const after = hooks.filter((h) => first !== null && h > first)
  console.log(
    name, 'L' + (s + 1) + '-L' + (end + 1),
    'firstReturn=L' + first,
    'hooks=' + hooks.length,
    after.length ? 'AFFECTED=' + after.join(',') : 'OK',
  )
  return after.length
}

let bad = 0
for (const name of (process.argv[3] ? [process.argv[3]] : ['Live2DSettings', 'PreviewWindow', 'CapabilityPanel', 'StageAnchor'])) {
  bad += component(name) || 0
}
process.exit(bad ? 1 : 0)
