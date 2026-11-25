param(
    [ValidateSet('start', 'stop', 'status', 'restart', 'enable-autostart', 'disable-autostart')]
    [string]$Action = 'status'
)
$ErrorActionPreference = 'Stop'

$srcDir = Join-Path (Split-Path $PSScriptRoot -Parent) 'sidecars\proxy_router\src'
$mainJs = Join-Path $srcDir 'main.mjs'
$controlUrl = 'http://127.0.0.1:17891'

function Resolve-Node {
    $candidates = @(
        (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe')
    )
    foreach ($c in $candidates) {
        if ($c -and (Test-Path $c)) { return $c }
    }
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    throw 'Node.js executable not found.'
}

function Get-DaemonIdentity {
    try {
        $res = Invoke-RestMethod -Uri "$controlUrl/api/identity" -TimeoutSec 1
        if ($res.service -eq 'antigravity-proxy-router') { return $res }
    } catch {}
    return $null
}

switch ($Action) {
    'status' {
        $id = Get-DaemonIdentity
        if ($id) {
            Write-Host "[RUNNING] pid=$($id.pid) mode=$($id.mode) url=$controlUrl"
        } else {
            Write-Host '[STOPPED] Daemon is not running on 127.0.0.1:17891'
        }
    }
    'start' {
        $id = Get-DaemonIdentity
        if ($id) {
            Write-Host "[OK] Already running (pid=$($id.pid))"
            return
        }
        $node = Resolve-Node
        $si = ([wmiclass]'Win32_ProcessStartup').CreateInstance()
        $si.ShowWindow = 0
        $cmdLine = "`"$node`" `"$mainJs`" --daemon"
        $res = ([wmiclass]'Win32_Process').Create($cmdLine, $srcDir, $si)
        if ($res.ReturnValue -ne 0) {
            throw "Win32_Process.Create failed with code $($res.ReturnValue)"
        }
        for ($i = 0; $i -lt 30; $i++) {
            Start-Sleep -Milliseconds 200
            $id = Get-DaemonIdentity
            if ($id -and $id.proxyListening) {
                Write-Host "[OK] Daemon started (pid=$($id.pid)) -> $controlUrl"
                return
            }
        }
        $id = Get-DaemonIdentity
        if ($id) {
            Write-Host "[OK] Daemon control ready (pid=$($id.pid), proxyListening=$($id.proxyListening)) -> $controlUrl"
            return
        }
        Write-Warning "Process created (pid=$($res.ProcessId)) but $controlUrl did not respond in time."
    }
    'stop' {
        $id = Get-DaemonIdentity
        if (-not $id) {
            Write-Host '[OK] Daemon already stopped'
            return
        }
        try {
            Invoke-RestMethod -Uri "$controlUrl/api/shutdown" -Method Post -TimeoutSec 2 | Out-Null
            Write-Host "[OK] Daemon stop requested (pid=$($id.pid))"
        } catch {
            Stop-Process -Id $id.pid -Force -ErrorAction SilentlyContinue
            Write-Host "[OK] Daemon killed (pid=$($id.pid))"
        }
    }
    'restart' {
        & $PSCommandPath -Action stop
        Start-Sleep -Milliseconds 300
        & $PSCommandPath -Action start
    }
    'enable-autostart' {
        $node = Resolve-Node
        $dataDir = Join-Path $env:USERPROFILE '.gemini\config\plugin-data\antigravity-proxy-router'
        if (-not (Test-Path $dataDir)) { New-Item -ItemType Directory -Path $dataDir -Force | Out-Null }
        $vbsPath = Join-Path $dataDir 'start-hidden.vbs'
        $vbsContent = "Set sh = CreateObject(`"Wscript.Shell`")`r`nsh.Run `"`"`"$node`"`" `"`"$mainJs`"`" --daemon`", 0, False`r`n"
        Set-Content -Path $vbsPath -Value $vbsContent -Encoding ASCII
        $runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
        Set-ItemProperty -Path $runKey -Name 'AntigravityProxyRouter' -Value "wscript.exe //B //Nologo `"$vbsPath`""
        Write-Host "[OK] Logon autostart enabled -> $vbsPath"
    }
    'disable-autostart' {
        $runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
        Remove-ItemProperty -Path $runKey -Name 'AntigravityProxyRouter' -ErrorAction SilentlyContinue
        Write-Host '[OK] Logon autostart disabled'
    }
}
