# Log sink for the WR multi-monitor PoC.
#
# A Chrome extension cannot write into the project folder, so it POSTs batched log
# entries here and this appends them to logs/wrmm.log where they can be read.
#
# Start it with:
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools/logsink.ps1
#
# Stop it with Ctrl+C, or just close the window. Nothing depends on it - if the
# sink is not running the extension keeps working and simply drops the log lines.

param(
  [int]$Port = 4200,
  [string]$LogDir = "$PSScriptRoot\..\logs"
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }
$LogDir = (Resolve-Path $LogDir).Path
$logFile = Join-Path $LogDir 'wrmm.log'

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
try {
  $listener.Start()
} catch {
  Write-Host "Could not bind port $Port. Is a sink already running?" -ForegroundColor Red
  exit 1
}

Write-Host "WRMM log sink listening on http://localhost:$Port/" -ForegroundColor Cyan
Write-Host "Appending to $logFile" -ForegroundColor Cyan
Write-Host "Ctrl+C to stop." -ForegroundColor DarkGray

# Fresh run marker, so separate sessions are easy to tell apart.
Add-Content -Path $logFile -Encoding utf8 -Value ("`n===== sink started $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') =====")

while ($listener.IsListening) {
  try {
    $ctx = $listener.GetContext()
    $req = $ctx.Request
    $res = $ctx.Response

    # The extension service worker is cross-origin to localhost.
    $res.Headers.Add('Access-Control-Allow-Origin', '*')
    $res.Headers.Add('Access-Control-Allow-Headers', 'Content-Type')
    $res.Headers.Add('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')

    if ($req.HttpMethod -eq 'OPTIONS') {
      $res.StatusCode = 204
      $res.OutputStream.Close()
      continue
    }

    if ($req.HttpMethod -eq 'GET') {
      # Health check, so the extension can tell whether logging is available.
      $body = [Text.Encoding]::UTF8.GetBytes('{"ok":true,"sink":"wrmm"}')
      $res.ContentType = 'application/json'
      $res.ContentLength64 = $body.Length
      $res.OutputStream.Write($body, 0, $body.Length)
      $res.OutputStream.Close()
      continue
    }

    if ($req.HttpMethod -eq 'POST') {
      $reader = New-Object IO.StreamReader($req.InputStream, [Text.Encoding]::UTF8)
      $raw = $reader.ReadToEnd()
      $reader.Close()

      if ($req.Url.AbsolutePath -eq '/clear') {
        Set-Content -Path $logFile -Encoding utf8 -Value "===== cleared $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ====="
        Write-Host "log cleared" -ForegroundColor Yellow
      } else {
        $lines = @()
        try {
          $parsed = $raw | ConvertFrom-Json
          foreach ($e in @($parsed.entries)) {
            $ts = if ($e.t) { $e.t } else { (Get-Date -Format 'HH:mm:ss.fff') }
            $lvl = if ($e.level) { $e.level.ToUpper() } else { 'INFO' }
            $src = if ($e.src) { $e.src } else { '-' }
            $msg = $e.msg
            if ($e.data) { $msg = "$msg  $($e.data | ConvertTo-Json -Compress -Depth 8)" }
            $lines += "$ts [$lvl] ($src) $msg"
          }
        } catch {
          # Not JSON, or a shape we did not expect - keep it rather than lose it.
          $lines += "$(Get-Date -Format 'HH:mm:ss.fff') [RAW] $raw"
        }
        if ($lines.Count) {
          Add-Content -Path $logFile -Encoding utf8 -Value $lines
          Write-Host "+$($lines.Count) line(s)" -ForegroundColor DarkGray
        }
      }

      $ok = [Text.Encoding]::UTF8.GetBytes('{"ok":true}')
      $res.ContentType = 'application/json'
      $res.ContentLength64 = $ok.Length
      $res.OutputStream.Write($ok, 0, $ok.Length)
      $res.OutputStream.Close()
      continue
    }

    $res.StatusCode = 405
    $res.OutputStream.Close()
  } catch {
    try { $ctx.Response.StatusCode = 500; $ctx.Response.OutputStream.Close() } catch {}
  }
}
