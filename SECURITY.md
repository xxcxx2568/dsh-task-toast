# 安全说明

## 凭据与密钥

- 本仓库不包含任何 API Key、Cookie、GitHub Token、本机绝对路径或真实会话数据。
- 插件不需要任何账号或 API Key；费用只是按内置价目表做的估算。
- 示例图使用虚构的「示例会话」与示例 token 数，不是真实对话。

## 数据落在哪里

- 原生窗口状态 / 动作 / 日志：`%TEMP%\dsh-task-toast\`（Windows 临时目录）
  - `state.json`：会话标题、最终回复、统计文本
  - `action.json`：窗口按钮动作
  - `overlay.log`：原生窗口诊断日志
- 这些文件只在本机供宿主和 PowerShell 窗口读取；插件停用或 DSH 退出时清理。
- 插件不向作者或任何第三方服务器上传数据；仅使用本机 loopback HTTP 路由。

## 系统调用

Windows 端会启动：

```text
powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File lib/overlay.ps1
```

`overlay.ps1` 只做三件事：画一个 WinForms 置顶窗口、读取状态文件、把按钮动作写回动作文件。脚本完全开源，可自行审计；如果不希望执行 PowerShell，插件会自动回退到网页内卡片。

## 费用与外部链接

- 内置 DeepSeek 价格来自官方公开价目表，可能随官方调整而过期；它不是账单。
- 插件本身不访问价格接口，也不会发起搜索/抓取请求。

## 报告问题

请通过 GitHub Issues 报告，并附上脱敏后的 `overlay.log` 片段。不要粘贴 Token、Cookie、完整会话内容或任何密钥。
