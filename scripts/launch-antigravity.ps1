param(
    [switch]$Restart,
    [int]$ListenPort = 17890
)
$ErrorActionPreference = 'Stop'

$scriptsDir = $PSScriptRoot
$daemonScript = Join-Path $scriptsDir 'daemon.ps1'

# 1. Ensure background daemon is running on :17890 / :17891
if (Test-Path $daemonScript) {
    & $daemonScript -Action start | Out-Null
}

# 2. Ensure User env vars point to gateway
$proxyUrl = "http://127.0.0.1:$ListenPort"
$curHttps = [Environment]::GetEnvironmentVariable('HTTPS_PROXY', 'User')
$curHttp = [Environment]::GetEnvironmentVariable('HTTP_PROXY', 'User')
$curNo = [Environment]::GetEnvironmentVariable('NO_PROXY', 'User')

if ($curHttps -ne $proxyUrl) {
    [Environment]::SetEnvironmentVariable('HTTPS_PROXY', $proxyUrl, 'User')
}
if ($curHttp -ne $proxyUrl) {
    [Environment]::SetEnvironmentVariable('HTTP_PROXY', $proxyUrl, 'User')
}
$noParts = @($curNo -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
foreach ($must in @('127.0.0.1', 'localhost', '::1')) {
    if ($noParts -notcontains $must) { $noParts += $must }
}
$finalNo = $noParts -join ','
if ($curNo -ne $finalNo) {
    [Environment]::SetEnvironmentVariable('NO_PROXY', $finalNo, 'User')
}

# 3. Inject directly into child process environment (bypasses stale explorer/StartMenu env cache)
$env:HTTPS_PROXY = $proxyUrl
$env:HTTP_PROXY = $proxyUrl
$env:NO_PROXY = $finalNo

# 4. Restart Antigravity processes cleanly if requested (never touches node.exe --daemon)
if ($Restart) {
    Get-Process -Name 'Antigravity' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Get-Process -Name 'language_server' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    for ($w = 0; $w -lt 20; $w++) {
        if (-not (Get-Process -Name 'Antigravity' -ErrorAction SilentlyContinue)) { break }
        Start-Sleep -Milliseconds 100
    }
    Start-Sleep -Milliseconds 250
}

# 5. Locate Antigravity.exe and launch with injected proxy env
$candidates = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\antigravity\Antigravity.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\Antigravity IDE\Antigravity IDE.exe')
)
$agyExe = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $agyExe) {
    throw 'Antigravity.exe not found under LocalAppData\Programs\antigravity'
}

Start-Process -FilePath $agyExe -ArgumentList '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1' -WorkingDirectory (Split-Path $agyExe -Parent) | Out-Null
Write-Host "[OK] Launched Antigravity with HTTPS_PROXY=$proxyUrl"
