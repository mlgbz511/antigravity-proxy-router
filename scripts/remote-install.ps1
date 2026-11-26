$ErrorActionPreference = 'Stop'

$RepoOwner = 'mlgbz511'
$RepoName = 'antigravity-proxy-router'
$Branch = 'main'
$ZipUrl = "https://github.com/$RepoOwner/$RepoName/archive/refs/heads/$Branch.zip"

$TmpDir = Join-Path $env:TEMP "agy-proxy-router-install-$([guid]::NewGuid().ToString('N').Substring(0,8))"
$ZipPath = Join-Path $TmpDir "$RepoName.zip"

try {
    New-Item -ItemType Directory -Path $TmpDir -Force | Out-Null
    Write-Host "[1/3] Downloading $RepoOwner/$RepoName ($Branch)..."
    Invoke-WebRequest -Uri $ZipUrl -OutFile $ZipPath -UseBasicParsing

    Write-Host "[2/3] Extracting archive..."
    Expand-Archive -Path $ZipPath -DestinationPath $TmpDir -Force
    $ExtractedDir = Join-Path $TmpDir "$RepoName-$Branch"
    $InstallScript = Join-Path $ExtractedDir 'scripts\install.ps1'
    if (-not (Test-Path $InstallScript)) {
        throw "install.ps1 not found in downloaded archive."
    }

    Write-Host "[3/3] Running install.ps1..."
    & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $InstallScript
} finally {
    if (Test-Path $TmpDir) {
        Remove-Item -Path $TmpDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}
