/**
 * 宿主侧集成测试：用 mock ctx 调用 lib/index.js 注册的 HTTP 路由，
 * 验证能力探测、/notify 写状态并启动 Windows 置顶窗口、/actions 与 /dismiss。
 *
 * 只在 Windows 上跑；会短暂弹出一个原生置顶窗口，然后清理。
 */
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import plugin from '../lib/index.js'

if (process.platform !== 'win32') {
  console.log('skip: Windows only')
  process.exit(0)
}

const routes = new Map()
const disposers = []
const ctx = {
  webServer: {
    register({ path, handler }) {
      routes.set(path, handler)
      return () => routes.delete(path)
    },
  },
  connection: { isTrusted: () => true },
  effect(fn) {
    const dispose = fn()
    if (typeof dispose === 'function') disposers.push(dispose)
    return dispose
  },
  get(name) {
    return name === 'connection' ? ctx.connection : undefined
  },
}

function response() {
  let body = ''
  return {
    statusCode: 200,
    writeHead(code) {
      this.statusCode = code
    },
    end(value) {
      body += value ?? ''
    },
    get body() {
      return body
    },
    json() {
      return JSON.parse(body || '{}')
    },
  }
}

function request(method, payload) {
  const req = Readable.from(payload === undefined ? [] : [Buffer.from(JSON.stringify(payload))])
  req.method = method
  req.headers = { host: '127.0.0.1:5041', 'content-type': 'application/json' }
  return req
}

async function call(path, method, payload) {
  const handler = routes.get(`/dsh-task-toast/api${path}`)
  assert.ok(handler, `route ${path} should exist`)
  const res = response()
  await handler(request(method, payload), res)
  return res
}

plugin.apply(ctx)

const caps = await call('/capabilities', 'GET')
assert.equal(caps.statusCode, 200)
assert.equal(caps.json().systemOverlay, true)
console.log('ok - capabilities')

const payload = {
  id: `host-test-${Date.now()}`,
  sessionId: 'session-host-test',
  title: '任务已完成',
  body: '对话已就绪，可以回来继续查看。',
  sessionTitle: '「宿主侧集成测试」',
  detail: '第一行\n第二行',
  tone: 'success',
  theme: 'dark',
  timeLabel: '16:10',
  durationText: '用时 3 秒',
  labels: { turn: '本次', total: '对话累计', open: '在 DSH 中打开', close: '关闭' },
  stats: {
    turnTokensText: '1,234 tokens',
    turnCostText: '≈¥0.0042',
    totalTokensText: '5,678 tokens',
    totalCostText: '≈¥0.0193',
  },
}

const notify = await call('/notify', 'POST', payload)
assert.equal(notify.statusCode, 200)
assert.equal(notify.json().ok, true)
console.log('ok - notify')

const statePath = join(tmpdir(), 'dsh-task-toast', 'state.json')
assert.ok(existsSync(statePath), 'state.json should be written')
const state = JSON.parse(readFileSync(statePath, 'utf8'))
assert.equal(state.id, payload.id)
assert.equal(state.detail, payload.detail)
assert.equal(state.stats.turnTokensText, '1,234 tokens')
console.log('ok - state file')

const actions = await call('/actions', 'GET')
assert.equal(actions.statusCode, 200)
assert.ok(Array.isArray(actions.json().actions))
console.log('ok - actions')

const dismiss = await call('/dismiss', 'POST', {})
assert.equal(dismiss.statusCode, 200)
console.log('ok - dismiss')

for (const dispose of disposers.splice(0)) dispose()
console.log('ok - cleanup')
