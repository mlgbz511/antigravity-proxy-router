param([switch]$Uninstall)
$ErrorActionPreference = 'Stop'
$pluginName = 'antigravity-proxy-router'
$src = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$dst = Join-Path $env:USERPROFILE (".gemini\config\plugins\" + $pluginName)

function Remove-TargetIfExists($path) {
    if (-not (Test-Path $path)) { return }
    $item = Get-Item $path -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        [IO.Directory]::Delete($path)
    } else {
        Remove-Item -Path $path -Recurse -Force
    }
}

if ($Uninstall) {
    $daemonScript = Join-Path $dst 'scripts\daemon.ps1'
    if (Test-Path $daemonScript) {
        try { & $daemonScript -Action disable-autostart | Out-Null } catch {}
        try { & $daemonScript -Action stop | Out-Null } catch {}
    }
    if (Test-Path $dst) {
        Remove-TargetIfExists $dst
        Write-Host "[OK] Uninstalled: $dst"
    } else {
        Write-Host "[OK] Nothing to uninstall"
    }
    return
}

$parent = Split-Path $dst -Parent
if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }

# Go os.ReadDir skips Windows Junctions/ReparsePoints (DirEntry.IsDir() == false),
# so deploy as a real directory copy rather than a symlink/junction.
if (Test-Path $dst) {
    $item = Get-Item $dst -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        [IO.Directory]::Delete($dst)
    }
}
if (-not (Test-Path $dst)) {
    New-Item -ItemType Directory -Path $dst -Force | Out-Null
}

foreach ($rel in @('plugin.json', 'README.md', 'assets', 'skills', 'sidecars', 'scripts')) {
    $from = Join-Path $src $rel
    if (Test-Path $from) {
        if ((Get-Item $from) -is [IO.DirectoryInfo]) {
            Copy-Item -Path $from -Destination $dst -Recurse -Force
        } else {
            Copy-Item -Path $from -Destination (Join-Path $dst $rel) -Force
        }
    }
}

Write-Host "[OK] Installed plugin to: $dst"
