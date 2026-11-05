/**
 * dsh-task-toast —— 宿主侧入口。
 *
 * 网页端负责检测完成事件、计算 token/花费；宿主侧负责把它送到一个
 * 真正的 Windows 置顶窗口（WPF/WinForms 由 overlay.ps1 创建），
 * 这样通知可以盖在其他应用窗口上，而不是只在 DSH 网页内部显示。
 *
 * 两端通过本机 HTTP 路由通信：
 *   GET  /dsh-task-toast/api/capabilities
 *   POST /dsh-task-toast/api/notify
 *   GET  /dsh-task-toast/api/actions
 *   POST /dsh-task-toast/api/dismiss
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const API_BASE = '/dsh-task-toast/api'
const MAX_BODY = 256 * 1024
const OVERLAY_DIR = 'dsh-task-toast'

class WindowsOverlay {
  constructor() {
    this.dir = join(tmpdir(), OVERLAY_DIR)
    this.statePath = join(this.dir, 'state.json')
    this.actionPath = join(this.dir, 'action.json')
    this.logPath = join(this.dir, 'overlay.log')
    this.script = fileURLToPath(new URL('./overlay.ps1', import.meta.url))
    this.powershell = process.env.SystemRoot
      ? join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      : 'powershell.exe'
    this.child = null
    this.lastState = null
  }

  available() {
    return process.platform === 'win32' && existsSync(this.powershell) && existsSync(this.script)
  }

  ensure() {
    if (this.child && this.child.exitCode === null && !this.child.killed) return true
    try {
      mkdirSync(this.dir, { recursive: true })
      this.child = spawn(
        this.powershell,
        [
          '-NoProfile',
          '-STA',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          this.script,
          '-StatePath',
          this.statePath,
          '-ActionPath',
          this.actionPath,
          '-ParentPid',
          String(process.pid),
          '-LogPath',
          this.logPath,
        ],
        { windowsHide: true, stdio: 'ignore' },
      )
      this.child.once('exit', () => {
        this.child = null
      })
      this.child.once('error', () => {
        this.child = null
      })
      return true
    } catch {
      this.child = null
      return false
    }
  }

  writeState(state) {
    mkdirSync(this.dir, { recursive: true })
    const temp = `${this.statePath}.tmp`
    writeFileSync(temp, JSON.stringify(state), 'utf8')
    rmSync(this.statePath, { force: true })
    renameSync(temp, this.statePath)
    this.lastState = state
  }

  show(payload) {
    if (!this.available()) return false
    const state = {
      ...payload,
      id: payload.id || `dsh-${Date.now()}`,
      visible: true,
    }
    try {
      this.writeState(state)
    } catch {
      return false
    }
    return this.ensure()
  }

  hide() {
    if (!this.lastState) return false
    try {
      this.writeState({ ...this.lastState, visible: false })
      return true
    } catch {
      return false
    }
  }

  takeActions() {
    try {
      if (!existsSync(this.actionPath)) return []
      const raw = readFileSync(this.actionPath, 'utf8')
      rmSync(this.actionPath, { force: true })
      if (!raw.trim()) return []
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed : [parsed]
    } catch {
      return []
    }
  }

  dispose() {
    try {
      this.child?.kill()
    } catch {}
    this.child = null
    for (const path of [this.statePath, this.actionPath, this.logPath]) {
      try {
        rmSync(path, { force: true })
      } catch {}
    }
  }
}

const json = (res, code, value) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('请求内容过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function text(value, limit) {
  return typeof value === 'string' ? value.slice(0, limit) : ''
}

export default {
  name: 'dsh-task-toast',
  inject: ['webServer', 'connection'],
  apply(ctx) {
    const overlay = new WindowsOverlay()
    const disposers = []

    const isLoopback = (req) => {
      const host = String(req.headers?.host ?? '').toLowerCase()
      const head = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]
      return head === '127.0.0.1' || head === 'localhost' || head === '[::1]' || head === '::1'
    }

    /** 和 DSH 其他宿主插件一致：只接受本机/受信任连接。 */
    const rejected = (req, res) => {
      if (isLoopback(req)) return false
      try {
        const conn = ctx.get('connection') ?? ctx.connection
        if (conn && typeof conn.isTrusted === 'function' && conn.isTrusted(req) === true) return false
        if (conn && typeof conn.requestRejection === 'function') {
          const code = conn.requestRejection(req)
          if (code === undefined || code === null || code === false) return false
          res.statusCode = typeof code === 'number' ? code : 403
          res.end()
          return true
        }
      } catch {}
      json(res, 403, { ok: false, error: '不受信任的访问来源' })
      return true
    }

    ctx.effect(
      () => () => {
        for (const dispose of disposers.splice(0)) {
          try {
            dispose()
          } catch {}
        }
        overlay.dispose()
      },
      'dsh-task-toast: host overlay',
    )

    const route = (path, handler) => {
      disposers.push(
        ctx.webServer.register({
          kind: 'exact',
          path: `${API_BASE}${path}`,
          handler: async (req, res) => {
            if (rejected(req, res)) return
            try {
              await handler(req, res)
            } catch (error) {
              try {
                json(res, 500, { ok: false, error: String(error?.message ?? error) })
              } catch {}
            }
          },
        }),
      )
    }

    route('/capabilities', async (req, res) => {
      if (req.method !== 'GET') return json(res, 405, { ok: false, error: '只支持 GET' })
      json(res, 200, {
        ok: true,
        systemOverlay: overlay.available(),
        platform: process.platform,
      })
    })

    route('/notify', async (req, res) => {
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: '只支持 POST' })
      let body
      try {
        body = JSON.parse((await readBody(req)) || '{}')
      } catch {
        return json(res, 400, { ok: false, error: '请求体不是合法 JSON' })
      }

      const stats = body?.stats && typeof body.stats === 'object' ? body.stats : {}
      const labels = body?.labels && typeof body.labels === 'object' ? body.labels : {}
      const payload = {
        id: text(body?.id, 160) || `dsh-${Date.now()}`,
        sessionId: text(body?.sessionId, 200),
        title: text(body?.title, 120) || '任务已完成',
        body: text(body?.body, 400),
        sessionTitle: text(body?.sessionTitle, 400),
        detail: text(body?.detail, 12000),
        tone: ['success', 'error', 'warn', 'muted'].includes(body?.tone) ? body.tone : 'success',
        theme: body?.theme === 'light' ? 'light' : 'dark',
        timeLabel: text(body?.timeLabel, 40),
        durationText: text(body?.durationText, 80),
        durationMs: Number.isFinite(body?.durationMs)
          ? Math.max(3000, Math.min(120000, Number(body.durationMs)))
          : 15000,
        labels: {
          turn: text(labels.turn, 20) || '本次',
          total: text(labels.total, 20) || '对话累计',
          open: text(labels.open, 30) || '在 DSH 中打开',
          close: text(labels.close, 30) || '关闭',
        },
        stats: {
          turnTokensText: text(stats.turnTokensText, 60) || '0 tokens',
          turnCostText: text(stats.turnCostText, 60) || '—',
          totalTokensText: text(stats.totalTokensText, 60) || '0 tokens',
          totalCostText: text(stats.totalCostText, 60) || '—',
        },
      }

      if (!overlay.show(payload)) {
        return json(res, 503, {
          ok: false,
          error: overlay.available() ? '置顶窗口启动失败' : '当前平台不支持系统级置顶窗口',
        })
      }
      return json(res, 200, { ok: true })
    })

    route('/actions', async (req, res) => {
      if (req.method !== 'GET') return json(res, 405, { ok: false, error: '只支持 GET' })
      json(res, 200, { ok: true, actions: overlay.takeActions() })
    })

    route('/dismiss', async (req, res) => {
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: '只支持 POST' })
      json(res, 200, { ok: overlay.hide() })
    })
  },
}
