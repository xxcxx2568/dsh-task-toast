param(
  [Parameter(Mandatory = $true)][string]$StatePath,
  [Parameter(Mandatory = $true)][string]$ActionPath,
  [Parameter(Mandatory = $true)][int]$ParentPid,
  [int]$Slot = 0,
  [string]$LogPath = ''
)

$ErrorActionPreference = 'Stop'

function Log([string]$message) {
  if ([string]::IsNullOrWhiteSpace($LogPath)) { return }
  try {
    Add-Content -LiteralPath $LogPath -Value ("{0:HH:mm:ss.fff} {1}" -f (Get-Date), $message) -Encoding UTF8
  }
  catch {}
}

Log 'overlay start'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class ToastWin32 {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll", EntryPoint="GetClassLongPtr")] public static extern IntPtr GetClassLongPtr(IntPtr hWnd, int nIndex);
  [DllImport("user32.dll", EntryPoint="SetClassLongPtr")] public static extern IntPtr SetClassLongPtr(IntPtr hWnd, int nIndex, IntPtr dwNewLong);
}
"@

[ToastWin32]::SetProcessDPIAware() | Out-Null
[System.Windows.Forms.Application]::EnableVisualStyles()

function ColorOf([int]$r, [int]$g, [int]$b) {
  return [System.Drawing.Color]::FromArgb($r, $g, $b)
}

$palette = @{
  card = ColorOf 255 255 255
  border = ColorOf 229 231 235
  title = ColorOf 17 24 39
  secondary = ColorOf 75 85 99
  tertiary = ColorOf 156 163 175
  detail = ColorOf 243 244 246
  detailText = ColorOf 107 114 128
  open = ColorOf 17 24 39
  success = ColorOf 34 160 107
  error = ColorOf 229 72 77
  warn = ColorOf 217 155 0
  muted = ColorOf 138 143 152
  edgeShadow = ColorOf 216 220 226
  shadowOuter = ColorOf 230 232 236
  shadowMid = ColorOf 218 222 227
  shadowInner = ColorOf 206 211 218
  scrollTrack = ColorOf 227 230 235
  scrollThumbBorder = ColorOf 199 204 212
}

$script:isLight = $true
$script:toneColor = $palette.success

function FontOf([int]$size, [bool]$bold = $false) {
  $style = if ($bold) { [System.Drawing.FontStyle]::Bold } else { [System.Drawing.FontStyle]::Regular }
  return New-Object System.Drawing.Font('Microsoft YaHei UI', $size, $style, [System.Drawing.GraphicsUnit]::Pixel)
}

function Set-RoundedControl($control, [int]$radius) {
  if ($null -eq $control -or $control.Width -le 2 -or $control.Height -le 2) { return }
  try {
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $diameter = $radius * 2
    $width = $control.Width
    $height = $control.Height
    $path.AddArc(0, 0, $diameter, $diameter, 180, 90)
    $path.AddArc($width - $diameter, 0, $diameter, $diameter, 270, 90)
    $path.AddArc($width - $diameter, $height - $diameter, $diameter, $diameter, 0, 90)
    $path.AddArc(0, $height - $diameter, $diameter, $diameter, 90, 90)
    $path.CloseFigure()
    $control.Region = New-Object System.Drawing.Region($path)
  }
  catch {}
}

$form = New-Object System.Windows.Forms.Form
$form.AutoScaleMode = [System.Windows.Forms.AutoScaleMode]::None
$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
$form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
$form.ShowInTaskbar = $false
$form.TopMost = $true
$form.BackColor = [System.Drawing.Color]::Magenta
$form.TransparencyKey = [System.Drawing.Color]::Magenta
$form.Width = 812
$form.Height = 432
$form.Font = FontOf 21
$area = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$form.Location = New-Object System.Drawing.Point(($area.Right - $form.Width - 20), ($area.Bottom - $form.Height))

# 透明窗体里放一层柔和阴影和一张真正的圆角白卡；四角挖空，得到第一版那种有厚度的卡片。
$shadowOuter = New-Object System.Windows.Forms.Panel
$shadowOuter.Left = 8
$shadowOuter.Top = 8
$shadowOuter.Width = 808
$shadowOuter.Height = 420
$shadowOuter.BackColor = $palette.shadowOuter
$form.Controls.Add($shadowOuter)

$shadowMid = New-Object System.Windows.Forms.Panel
$shadowMid.Left = 10
$shadowMid.Top = 10
$shadowMid.Width = 804
$shadowMid.Height = 421
$shadowMid.BackColor = $palette.shadowMid
$form.Controls.Add($shadowMid)

$shadowInner = New-Object System.Windows.Forms.Panel
$shadowInner.Left = 11
$shadowInner.Top = 11
$shadowInner.Width = 802
$shadowInner.Height = 422
$shadowInner.BackColor = $palette.shadowInner
$form.Controls.Add($shadowInner)

$card = New-Object System.Windows.Forms.Panel
$card.Left = 12
$card.Top = 12
$card.Width = 800
$card.Height = 420
$card.BackColor = $palette.card
$form.Controls.Add($card)
$card.BringToFront()

$root = New-Object System.Windows.Forms.TableLayoutPanel
$root.Dock = [System.Windows.Forms.DockStyle]::Fill
$root.ColumnCount = 1
$root.RowCount = 5
$root.BackColor = $palette.card
$root.Padding = New-Object System.Windows.Forms.Padding(20, 16, 20, 14)
$root.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, 48)))
$root.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::AutoSize)))
$root.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, 74)))
$root.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Percent, 100)))
$root.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, 72)))
$card.Controls.Add($root)

# 第一版左侧那条绿色强调线。
$accent = New-Object System.Windows.Forms.Panel
$accent.Width = 4
$accent.Left = 0
$accent.Top = 16
$accent.Height = $card.Height - 32
$accent.BackColor = $palette.success
$accent.Anchor = [System.Windows.Forms.AnchorStyles]::Top -bor [System.Windows.Forms.AnchorStyles]::Bottom -bor [System.Windows.Forms.AnchorStyles]::Left
$card.Controls.Add($accent)
$accent.BringToFront()

# 第一版底部那条会走完的绿色进度线。
$progress = New-Object System.Windows.Forms.Panel
$progress.Width = $card.Width
$progress.Height = 3
$progress.Left = 0
$progress.Top = $card.Height - 3
$progress.BackColor = $palette.success
$progress.Anchor = [System.Windows.Forms.AnchorStyles]::Bottom -bor [System.Windows.Forms.AnchorStyles]::Left
$card.Controls.Add($progress)
$progress.BringToFront()

$header = New-Object System.Windows.Forms.TableLayoutPanel
$header.Dock = [System.Windows.Forms.DockStyle]::Fill
$header.ColumnCount = 4
$header.RowCount = 1
$header.BackColor = $palette.card
$header.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Absolute, 42)))
$header.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Percent, 100)))
$header.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::AutoSize)))
$header.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Absolute, 30)))
$root.Controls.Add($header, 0, 0)

$icon = New-Object System.Windows.Forms.Label
$icon.Text = '✓'
$icon.TextAlign = [System.Drawing.ContentAlignment]::MiddleCenter
$icon.Font = FontOf 18 $true
$icon.ForeColor = $palette.success
$icon.BackColor = $palette.card
$icon.Width = 32
$icon.Height = 32
$icon.Margin = New-Object System.Windows.Forms.Padding(0, 8, 0, 0)
$header.Controls.Add($icon, 0, 0)

$title = New-Object System.Windows.Forms.Label
$title.Text = '任务已完成'
$title.Font = FontOf 26 $true
$title.ForeColor = $palette.title
$title.AutoSize = $false
$title.Dock = [System.Windows.Forms.DockStyle]::Fill
$title.TextAlign = [System.Drawing.ContentAlignment]::MiddleLeft
$title.AutoEllipsis = $true
$title.Margin = New-Object System.Windows.Forms.Padding(9, 0, 8, 0)
$header.Controls.Add($title, 1, 0)

$time = New-Object System.Windows.Forms.Label
$time.Text = ''
$time.Font = FontOf 20
$time.ForeColor = $palette.tertiary
$time.AutoSize = $true
$time.Anchor = [System.Windows.Forms.AnchorStyles]::Right
$time.Margin = New-Object System.Windows.Forms.Padding(0, 0, 10, 0)
$header.Controls.Add($time, 2, 0)

$close = New-Object System.Windows.Forms.Button
$close.Text = '✕'
$close.Font = FontOf 17
$close.ForeColor = $palette.tertiary
$close.BackColor = $palette.detail
$close.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat
$close.FlatAppearance.BorderSize = 0
$close.FlatAppearance.BorderColor = $palette.detail
$close.FlatAppearance.MouseOverBackColor = $palette.edgeShadow
$close.UseVisualStyleBackColor = $false
$close.Cursor = [System.Windows.Forms.Cursors]::Hand
$close.Width = 28
$close.Height = 28
$close.TextAlign = [System.Drawing.ContentAlignment]::MiddleCenter
$close.Anchor = [System.Windows.Forms.AnchorStyles]::Top -bor [System.Windows.Forms.AnchorStyles]::Right
$close.Margin = New-Object System.Windows.Forms.Padding(0, 10, 0, 0)
$close.Add_MouseEnter({ $close.ForeColor = $palette.title })
$close.Add_MouseLeave({ $close.ForeColor = $palette.tertiary })
$header.Controls.Add($close, 3, 0)

$bodyPanel = New-Object System.Windows.Forms.TableLayoutPanel
$bodyPanel.Dock = [System.Windows.Forms.DockStyle]::Fill
$bodyPanel.ColumnCount = 1
$bodyPanel.RowCount = 2
$bodyPanel.AutoSize = $true
$bodyPanel.BackColor = $palette.card
$bodyPanel.Margin = New-Object System.Windows.Forms.Padding(0, 4, 0, 0)
$root.Controls.Add($bodyPanel, 0, 1)

$session = New-Object System.Windows.Forms.Label
$session.Text = ''
$session.Font = FontOf 26 $true
$session.ForeColor = $palette.title
$session.AutoSize = $true
$session.Dock = [System.Windows.Forms.DockStyle]::Top
$bodyPanel.Controls.Add($session, 0, 0)

$body = New-Object System.Windows.Forms.Label
$body.Text = ''
$body.Font = FontOf 22
$body.ForeColor = $palette.secondary
$body.AutoSize = $true
$body.MaximumSize = New-Object System.Drawing.Size(700, 0)
$body.Dock = [System.Windows.Forms.DockStyle]::Top
$body.Margin = New-Object System.Windows.Forms.Padding(0, 2, 0, 0)
$bodyPanel.Controls.Add($body, 0, 1)

$stats = New-Object System.Windows.Forms.TableLayoutPanel
$stats.Dock = [System.Windows.Forms.DockStyle]::Fill
$stats.ColumnCount = 3
$stats.RowCount = 2
$stats.BackColor = $palette.card
$stats.Padding = New-Object System.Windows.Forms.Padding(0)
$stats.Margin = New-Object System.Windows.Forms.Padding(0, 6, 0, 0)
$stats.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::AutoSize)))
$stats.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Percent, 100)))
$stats.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::AutoSize)))
$root.Controls.Add($stats, 0, 2)

function New-StatLabel([string]$text, [bool]$bold, [System.Drawing.Color]$color, [int]$size = 20) {
  $label = New-Object System.Windows.Forms.Label
  $label.Text = $text
  $label.Font = FontOf $size $bold
  $label.ForeColor = $color
  $label.AutoSize = $true
  $label.Anchor = [System.Windows.Forms.AnchorStyles]::Left
  return $label
}

$turnLabel = New-StatLabel '本次' $false $palette.tertiary 20
$turnTokens = New-StatLabel '' $false $palette.title 24
$turnCost = New-StatLabel '' $true $palette.title 24
$totalLabel = New-StatLabel '对话累计' $false $palette.tertiary 20
$totalTokens = New-StatLabel '' $false $palette.title 24
$totalCost = New-StatLabel '' $true $palette.title 24
$turnTokens.Anchor = [System.Windows.Forms.AnchorStyles]::Right
$turnCost.Anchor = [System.Windows.Forms.AnchorStyles]::Right
$totalTokens.Anchor = [System.Windows.Forms.AnchorStyles]::Right
$totalCost.Anchor = [System.Windows.Forms.AnchorStyles]::Right
$stats.Controls.Add($turnLabel, 0, 0)
$stats.Controls.Add($turnTokens, 1, 0)
$stats.Controls.Add($turnCost, 2, 0)
$stats.Controls.Add($totalLabel, 0, 1)
$stats.Controls.Add($totalTokens, 1, 1)
$stats.Controls.Add($totalCost, 2, 1)

$detailPanel = New-Object System.Windows.Forms.Panel
$detailPanel.Dock = [System.Windows.Forms.DockStyle]::Fill
$detailPanel.BackColor = $palette.detail
$detailPanel.Padding = New-Object System.Windows.Forms.Padding(0)
$detailPanel.Margin = New-Object System.Windows.Forms.Padding(0, 8, 0, 0)
$root.Controls.Add($detailPanel, 0, 3)

$detailViewport = New-Object System.Windows.Forms.Panel
$detailViewport.Dock = [System.Windows.Forms.DockStyle]::Fill
$detailViewport.BackColor = $palette.detail
$detailPanel.Controls.Add($detailViewport)

$detailLabel = New-Object System.Windows.Forms.Label
$detailLabel.Text = ''
$detailLabel.AutoSize = $true
$detailLabel.BackColor = $palette.detail
$detailLabel.ForeColor = $palette.detailText
$detailLabel.Font = FontOf 21
$detailLabel.UseMnemonic = $false
$detailLabel.Left = 9
$detailLabel.Top = 7
$detailLabel.MaximumSize = New-Object System.Drawing.Size(700, 0)
$detailViewport.Controls.Add($detailLabel)

# 白色拖动条：不再用系统灰色滚动条。
$scrollTrack = New-Object System.Windows.Forms.Panel
$scrollTrack.BackColor = $palette.scrollTrack
$scrollTrack.Width = 16
$scrollTrack.Height = 40
$scrollTrack.Left = 744
$scrollTrack.Top = 0
$scrollTrack.Visible = $false
$detailPanel.Controls.Add($scrollTrack)

$scrollThumb = New-Object System.Windows.Forms.Panel
$scrollThumb.BackColor = [System.Drawing.Color]::White
$scrollThumb.Width = 10
$scrollThumb.Height = 40
$scrollThumb.Left = 738
$scrollThumb.Top = 0
$scrollThumb.Visible = $false
$detailPanel.Controls.Add($scrollThumb)
$scrollThumb.BringToFront()
$scrollThumb.Add_Paint({
  param($sender, $event)
  try {
    $event.Graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $pen = New-Object System.Drawing.Pen($palette.scrollThumbBorder, 1)
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $diameter = 6
    $width = $scrollThumb.Width - 1
    $height = $scrollThumb.Height - 1
    $path.AddArc(1, 1, $diameter, $diameter, 180, 90)
    $path.AddArc($width - $diameter, 1, $diameter, $diameter, 270, 90)
    $path.AddArc($width - $diameter, $height - $diameter, $diameter, $diameter, 0, 90)
    $path.AddArc(1, $height - $diameter, $diameter, $diameter, 90, 90)
    $path.CloseFigure()
    $event.Graphics.DrawPath($pen, $path)
    $pen.Dispose()
    $path.Dispose()
  }
  catch {}
})

$footer = New-Object System.Windows.Forms.TableLayoutPanel
$footer.Dock = [System.Windows.Forms.DockStyle]::Fill
$footer.ColumnCount = 3
$footer.RowCount = 1
$footer.BackColor = $palette.card
$footer.Padding = New-Object System.Windows.Forms.Padding(0, 10, 0, 14)
$footer.Margin = New-Object System.Windows.Forms.Padding(0, 6, 0, 0)
$footer.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::AutoSize)))
$footer.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Percent, 100)))
$footer.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::AutoSize)))
$root.Controls.Add($footer, 0, 4)

$open = New-Object System.Windows.Forms.Button
$open.Text = '查看对话 →'
$open.Font = FontOf 23 $true
$open.ForeColor = $palette.open
$open.BackColor = $palette.card
$open.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat
$open.FlatAppearance.BorderSize = 0
$open.FlatAppearance.BorderColor = $palette.card
$open.FlatAppearance.MouseOverBackColor = $palette.detail
$open.UseVisualStyleBackColor = $false
$open.Cursor = [System.Windows.Forms.Cursors]::Hand
$open.AutoSize = $true
$open.Anchor = [System.Windows.Forms.AnchorStyles]::Left
$open.TextAlign = [System.Drawing.ContentAlignment]::MiddleLeft
$footer.Controls.Add($open, 0, 0)

$duration = New-Object System.Windows.Forms.Label
$duration.Text = ''
$duration.Font = FontOf 19
$duration.ForeColor = $palette.tertiary
$duration.AutoSize = $true
$duration.Anchor = [System.Windows.Forms.AnchorStyles]::Right
$footer.Controls.Add($duration, 2, 0)

# 卡片 1px 边线，让白卡在浅色背景上也有轮廓。
$card.Add_Paint({
  param($sender, $event)
  try {
    $event.Graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $pen = New-Object System.Drawing.Pen($palette.border, 1)
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $diameter = 56
    $width = $card.Width - 1
    $height = $card.Height - 1
    $path.AddArc(1, 1, $diameter, $diameter, 180, 90)
    $path.AddArc($width - $diameter, 1, $diameter, $diameter, 270, 90)
    $path.AddArc($width - $diameter, $height - $diameter, $diameter, $diameter, 0, 90)
    $path.AddArc(1, $height - $diameter, $diameter, $diameter, 90, 90)
    $path.CloseFigure()
    $event.Graphics.DrawPath($pen, $path)

    # 底边和右边的内阴影，让卡片看起来是“厚”的，不是一张薄纸。
    $edgePen = New-Object System.Drawing.Pen($palette.edgeShadow, 2)
    $event.Graphics.DrawLine($edgePen, 30, $height - 2, $width - 30, $height - 2)
    $event.Graphics.DrawLine($edgePen, $width - 2, 30, $width - 2, $height - 30)
    $edgePen.Dispose()

    $pen.Dispose()
    $path.Dispose()
  }
  catch {}
})

function Apply-Theme([string]$theme) {
  $script:isLight = $theme -ne 'dark'
  if ($script:isLight) {
    $palette.card = ColorOf 255 255 255
    $palette.border = ColorOf 221 225 231
    $palette.edgeShadow = ColorOf 216 220 226
    $palette.shadowOuter = ColorOf 230 232 236
    $palette.shadowMid = ColorOf 218 222 227
    $palette.shadowInner = ColorOf 206 211 218
    $palette.scrollTrack = ColorOf 227 230 235
    $palette.scrollThumbBorder = ColorOf 199 204 212
    $palette.title = ColorOf 17 24 39
    $palette.secondary = ColorOf 75 85 99
    $palette.tertiary = ColorOf 156 163 175
    $palette.detail = ColorOf 243 244 246
    $palette.detailText = ColorOf 107 114 128
    $palette.open = ColorOf 17 24 39
    $script:toneBg = @{ success = ColorOf 231 246 238; error = ColorOf 253 236 236; warn = ColorOf 255 244 219; muted = ColorOf 243 244 246 }
    $script:toneFg = @{ success = ColorOf 34 160 107; error = ColorOf 229 72 77; warn = ColorOf 217 155 0; muted = ColorOf 138 143 152 }
  }
  else {
    $palette.card = ColorOf 35 36 40
    $palette.border = ColorOf 52 54 60
    $palette.edgeShadow = ColorOf 24 25 28
    $palette.shadowOuter = ColorOf 28 29 32
    $palette.shadowMid = ColorOf 24 25 28
    $palette.shadowInner = ColorOf 20 21 24
    $palette.scrollTrack = ColorOf 52 53 59
    $palette.scrollThumbBorder = ColorOf 74 76 84
    $palette.title = ColorOf 243 244 246
    $palette.secondary = ColorOf 183 188 196
    $palette.tertiary = ColorOf 138 143 152
    $palette.detail = ColorOf 42 43 48
    $palette.detailText = ColorOf 183 188 196
    $palette.open = ColorOf 125 155 255
    $script:toneBg = @{ success = ColorOf 30 58 45; error = ColorOf 58 32 34; warn = ColorOf 58 48 32; muted = ColorOf 46 48 53 }
    $script:toneFg = @{ success = ColorOf 74 222 128; error = ColorOf 248 113 113; warn = ColorOf 251 191 36; muted = ColorOf 156 163 175 }
  }

  $card.BackColor = $palette.card
  $shadowOuter.BackColor = $palette.shadowOuter
  $shadowMid.BackColor = $palette.shadowMid
  $shadowInner.BackColor = $palette.shadowInner
  $root.BackColor = $palette.card
  $header.BackColor = $palette.card
  $bodyPanel.BackColor = $palette.card
  $stats.BackColor = $palette.card
  $detailPanel.BackColor = $palette.detail
  $detailViewport.BackColor = $palette.detail
  $scrollTrack.BackColor = $palette.scrollTrack
  $detailLabel.BackColor = $palette.detail
  $scrollThumb.BackColor = [System.Drawing.Color]::White
  $footer.BackColor = $palette.card
  $title.ForeColor = $palette.title
  $session.ForeColor = $palette.title
  $body.ForeColor = $palette.secondary
  $time.ForeColor = $palette.tertiary
  $close.ForeColor = $palette.tertiary
  $close.BackColor = $palette.detail
  $open.ForeColor = $palette.open
  $open.BackColor = $palette.card
  $duration.ForeColor = $palette.tertiary
  $turnLabel.ForeColor = $palette.tertiary
  $turnTokens.ForeColor = $palette.title
  $turnCost.ForeColor = $palette.title
  $totalLabel.ForeColor = $palette.tertiary
  $totalTokens.ForeColor = $palette.title
  $totalCost.ForeColor = $palette.title
  $detailLabel.ForeColor = $palette.detailText
  $scrollThumb.Invalidate()
  $card.Invalidate()
}

function Apply-Tone([string]$tone) {
  $key = 'success'
  $glyph = '✓'
  switch ($tone) {
    'error' { $key = 'error'; $glyph = '!' }
    'warn' { $key = 'warn'; $glyph = '!' }
    'muted' { $key = 'muted'; $glyph = '■' }
  }
  $fg = $script:toneFg[$key]
  $bg = $script:toneBg[$key]
  $script:toneColor = $fg
  $accent.BackColor = $fg
  $progress.BackColor = $fg
  $icon.BackColor = $bg
  $icon.ForeColor = $fg
  $icon.Text = $glyph
}

function Apply-Rounded {
  Set-RoundedControl $shadowOuter 36
  Set-RoundedControl $shadowMid 34
  Set-RoundedControl $shadowInner 32
  Set-RoundedControl $card 28
  Set-RoundedControl $detailPanel 12
  Set-RoundedControl $icon 9
  Set-RoundedControl $close 8
  Update-DetailMetrics
}

function Update-DetailMetrics {
  if ($null -eq $detailLabel) { return }
  if ($detailViewport.ClientSize.Width -le 30 -or $detailViewport.ClientSize.Height -le 30) { return }
  $width = [Math]::Max(120, $detailViewport.ClientSize.Width - 34)
  $detailLabel.MaximumSize = New-Object System.Drawing.Size($width, 0)
  $detailLabel.Width = $width
  $detailLabel.PerformLayout()
  $detailLabel.Left = 9
  $visible = [Math]::Max(1, $detailViewport.ClientSize.Height - 14)
  $script:detailMax = [Math]::Max(0, $detailLabel.Height - $visible)
  if ($script:detailOffset -gt $script:detailMax) { $script:detailOffset = $script:detailMax }
  if ($script:detailOffset -lt 0) { $script:detailOffset = 0 }
  $detailLabel.Top = 7 - $script:detailOffset
  Update-ScrollThumb
}

function Update-ScrollThumb {
  $trackHeight = $detailPanel.ClientSize.Height
  $viewHeight = [Math]::Max(1, $detailViewport.ClientSize.Height - 14)
  $scrollTrack.Left = [Math]::Max(0, $detailPanel.ClientSize.Width - 16)
  $scrollTrack.Top = 0
  $scrollTrack.Width = 16
  $scrollTrack.Height = $trackHeight
  if ($trackHeight -le 0 -or $detailLabel.Height -le $viewHeight) {
    $scrollThumb.Visible = $false
    $scrollTrack.Visible = $false
    return
  }
  $scrollThumb.Visible = $true
  $scrollTrack.Visible = $true
  $thumbHeight = [Math]::Max(28, [int]($trackHeight * $viewHeight / [Math]::Max(1, $detailLabel.Height)))
  if ($thumbHeight -gt $trackHeight) { $thumbHeight = $trackHeight }
  $scrollThumb.Height = $thumbHeight
  $scrollThumb.Width = 10
  $scrollThumb.Left = [Math]::Max(0, $detailPanel.ClientSize.Width - 13)
  $travel = [Math]::Max(0, $trackHeight - $thumbHeight)
  $fraction = if ($script:detailMax -gt 0) { $script:detailOffset / $script:detailMax } else { 0 }
  $scrollThumb.Top = [int]($travel * $fraction)
  Set-RoundedControl $scrollThumb 4
  $scrollThumb.Invalidate()
  $scrollTrack.BringToFront()
  $scrollThumb.BringToFront()
}

function Scroll-Detail([int]$delta) {
  if ($script:detailMax -le 0) { return }
  $step = 64
  $script:detailOffset -= [Math]::Sign($delta) * $step
  if ($script:detailOffset -lt 0) { $script:detailOffset = 0 }
  if ($script:detailOffset -gt $script:detailMax) { $script:detailOffset = $script:detailMax }
  $detailLabel.Top = 7 - $script:detailOffset
  Update-ScrollThumb
}

function Write-Action($action) {
  try {
    $json = @($action) | ConvertTo-Json -Compress
    $tmp = "$ActionPath.tmp"
    [IO.File]::WriteAllText($tmp, $json, (New-Object System.Text.UTF8Encoding($false)))
    if (Test-Path -LiteralPath $ActionPath) {
      Remove-Item -LiteralPath $ActionPath -Force -ErrorAction SilentlyContinue
    }
    Move-Item -LiteralPath $tmp -Destination $ActionPath -Force
  }
  catch {}
}

function Read-State {
  try {
    if (-not (Test-Path -LiteralPath $StatePath)) { return $null }
    $raw = [IO.File]::ReadAllText($StatePath, [Text.Encoding]::UTF8)
    if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
    return $raw | ConvertFrom-Json
  }
  catch {
    return $null
  }
}

function Position-Form {
  $screen = [System.Windows.Forms.Screen]::FromPoint([System.Windows.Forms.Cursor]::Position)
  $area = $screen.WorkingArea
  $top = $area.Bottom - $form.Height - ([Math]::Max(0, $Slot) * $form.Height)
  if ($top -lt $area.Top) { $top = $area.Top }
  $form.Location = New-Object System.Drawing.Point(($area.Right - $form.Width - 20), $top)
}

function Show-Overlay {
  Position-Form
  $script:targetTop = $form.Top
  $form.Top = $script:targetTop + 20
  $form.TopMost = $true
  Log ("show before: visible={0} loc={1},{2} target={3} size={4}x{5}" -f $form.Visible, $form.Left, $form.Top, $script:targetTop, $form.Width, $form.Height)
  if (-not $form.Visible) { $form.Show() }
  [ToastWin32]::ShowWindow($form.Handle, 5) | Out-Null
  [ToastWin32]::SetWindowPos($form.Handle, [IntPtr]::new(-1), 0, 0, 0, 0, 0x0001 -bor 0x0002 -bor 0x0010 -bor 0x0040) | Out-Null
  try {
    $style = [ToastWin32]::GetClassLongPtr($form.Handle, -26).ToInt64()
    [ToastWin32]::SetClassLongPtr($form.Handle, -26, [IntPtr]($style -bor 0x00020000)) | Out-Null
  }
  catch {}
  $form.BringToFront()
  Apply-Rounded
  Update-DetailMetrics
  $script:progressElapsed = 0
  $script:progressDuration = [Math]::Max(3000, $timer.Interval)
  $progress.Width = $card.Width
  $progressTimer.Stop()
  $progressTimer.Start()
  Log ("show after: visible={0} winVisible={1}" -f $form.Visible, [ToastWin32]::IsWindowVisible($form.Handle))
  $timer.Stop()
  $timer.Start()

  # 180ms 滑入：从目标位置下方 12px 缓出到目标位置。
  $script:animStart = [DateTime]::UtcNow
  $animTimer.Stop()
  $animTimer.Start()
}

function Hide-Overlay {
  if ($script:hiding) { return }
  $script:hiding = $true
  $timer.Stop()
  $progressTimer.Stop()
  $animTimer.Stop()
  try { $poll.Stop() } catch {}
  Log ("hide: visible={0} slot={1}" -f $form.Visible, $Slot)
  Log 'process exit'
  try {
    [System.Diagnostics.Process]::GetCurrentProcess().Kill()
  }
  catch {}
  [Environment]::Exit(0)
}

function Focus-Dsh {
  try {
    $target = Get-Process -ErrorAction SilentlyContinue |
      Where-Object {
        $_.MainWindowHandle -ne 0 -and
        ($_.ProcessName -match 'DeepSeek' -or $_.MainWindowTitle -match 'DeepSeek')
      } |
      Select-Object -First 1
    if ($null -ne $target) {
      [ToastWin32]::ShowWindow($target.MainWindowHandle, 9) | Out-Null
      [ToastWin32]::SetForegroundWindow($target.MainWindowHandle) | Out-Null
    }
  }
  catch {}
}

function Apply-State($state) {
  if ($null -eq $state) { return }
  if ($state.visible -eq $false) {
    Hide-Overlay
    return
  }
  $id = [string]$state.id
  if ($id -eq $script:lastId) { return }
  $script:lastId = $id
  $script:sessionId = [string]$state.sessionId
  Log ("apply id={0} tone={1} theme={2}" -f $id, $state.tone, $state.theme)

  Apply-Theme ([string]$state.theme)
  Apply-Tone ([string]$state.tone)

  $title.Text = [string]$state.title
  $time.Text = [string]$state.timeLabel
  $sessionTitle = [string]$state.sessionTitle
  if ($sessionTitle -and -not $sessionTitle.StartsWith('「')) {
    $sessionTitle = "「${sessionTitle}」"
  }
  $session.Text = $sessionTitle
  $body.Text = [string]$state.body
  $turnLabel.Text = [string]$state.labels.turn
  $totalLabel.Text = [string]$state.labels.total
  $open.Text = [string]$state.labels.open + ' →'
  $turnTokens.Text = [string]$state.stats.turnTokensText
  $turnCost.Text = [string]$state.stats.turnCostText
  $totalTokens.Text = [string]$state.stats.totalTokensText
  $totalCost.Text = [string]$state.stats.totalCostText
  $duration.Text = [string]$state.durationText

  $ms = 5000
  if ($null -ne $state.durationMs) { $ms = [int]$state.durationMs }
  if ($ms -lt 3000) { $ms = 3000 }
  if ($ms -gt 120000) { $ms = 120000 }
  $timer.Interval = $ms

  $detailLabel.Text = [string]$state.detail
  $script:detailOffset = 0
  $detailLabel.Top = 7
  if ([string]::IsNullOrWhiteSpace([string]$state.detail)) {
    $detailPanel.Visible = $false
  }
  else {
    $detailPanel.Visible = $true
  }

  Show-Overlay
}

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 5000
$timer.Add_Tick({
  $timer.Stop()
  $progressTimer.Stop()
  Write-Action @{ type = 'dismiss'; id = $script:lastId }
  Hide-Overlay
})

$progressTimer = New-Object System.Windows.Forms.Timer
$progressTimer.Interval = 50
$script:progressElapsed = 0
$script:progressDuration = 5000
$progressTimer.Add_Tick({
  if (-not $form.Visible) { return }
  $script:progressElapsed += $progressTimer.Interval
  $duration = [Math]::Max(1, $script:progressDuration)
  $fraction = 1 - ($script:progressElapsed / $duration)
  if ($fraction -le 0) {
    $progress.Width = 0
    $progressTimer.Stop()
    $timer.Stop()
    Write-Action @{ type = 'dismiss'; id = $script:lastId }
    Hide-Overlay
    return
  }
  $progress.Width = [int]($card.Width * $fraction)
})

$animTimer = New-Object System.Windows.Forms.Timer
$animTimer.Interval = 15
$script:animStart = [DateTime]::UtcNow
$animTimer.Add_Tick({
  $elapsed = ([DateTime]::UtcNow - $script:animStart).TotalMilliseconds
  $t = [Math]::Min(1.0, $elapsed / 180.0)
  $ease = 1 - [Math]::Pow(1 - $t, 3)
  $form.Top = $script:targetTop + [int](20 * (1 - $ease))
  if ($t -ge 1) {
    $animTimer.Stop()
    $form.Top = $script:targetTop
  }
})

$hideTimer = $null

$poll = New-Object System.Windows.Forms.Timer
$poll.Interval = 250
$poll.Add_Tick({
  $script:tick += 1
  if ($script:tick % 20 -eq 0) {
    if (-not (Get-Process -Id $script:parentPid -ErrorAction SilentlyContinue)) {
      $form.Close()
      return
    }
  }
  Apply-State (Read-State)
})

$form.Add_Shown({ Apply-Rounded })
$form.Add_Resize({ Apply-Rounded })

$wheelHandler = {
  param($sender, $event)
  Scroll-Detail $event.Delta
}
$form.Add_MouseWheel($wheelHandler)
$detailPanel.Add_MouseWheel($wheelHandler)
$detailViewport.Add_MouseWheel($wheelHandler)
$detailLabel.Add_MouseWheel($wheelHandler)
$scrollThumb.Add_MouseWheel($wheelHandler)

$scrollThumb.Add_MouseDown({
  param($sender, $event)
  if ($script:detailMax -le 0) { return }
  $script:dragging = $true
  $scrollThumb.Capture = $true
  $script:dragY = [System.Windows.Forms.Cursor]::Position.Y
  $script:dragOffset = $script:detailOffset
})
$scrollThumb.Add_MouseMove({
  param($sender, $event)
  if (-not $script:dragging) { return }
  $travel = [Math]::Max(1, $detailPanel.ClientSize.Height - $scrollThumb.Height)
  $deltaY = [System.Windows.Forms.Cursor]::Position.Y - $script:dragY
  $script:detailOffset = [int]($script:dragOffset + ($deltaY / $travel) * $script:detailMax)
  if ($script:detailOffset -lt 0) { $script:detailOffset = 0 }
  if ($script:detailOffset -gt $script:detailMax) { $script:detailOffset = $script:detailMax }
  $detailLabel.Top = 7 - $script:detailOffset
  Update-ScrollThumb
})
$scrollThumb.Add_MouseUp({
  $script:dragging = $false
  $scrollThumb.Capture = $false
})
$open.Add_Click({
  Write-Action @{ type = 'open'; id = $script:lastId; sessionId = $script:sessionId }
  Focus-Dsh
  Hide-Overlay
})
$close.Add_Click({
  Write-Action @{ type = 'dismiss'; id = $script:lastId }
  Hide-Overlay
})

$script:lastId = ''
$script:sessionId = ''
$script:parentPid = $ParentPid
$script:tick = 0
$script:detailOffset = 0
$script:detailMax = 0
$script:dragging = $false
$script:dragY = 0
$script:dragOffset = 0
$script:closed = $false
$script:hiding = $false
$script:targetTop = 0

Apply-State (Read-State)
$poll.Start()
[System.Windows.Forms.Application]::Run($form)
Log 'application run returned'
[Environment]::Exit(0)
