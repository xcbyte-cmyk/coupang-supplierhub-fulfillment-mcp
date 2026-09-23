[CmdletBinding()]
param([switch]$SkipBuild, [switch]$NoBrowser, [switch]$Portable)
$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$dataDir = Join-Path $projectRoot 'data'
$pidPath = Join-Path $dataDir 'server.pid'
$stdoutPath = Join-Path $dataDir 'server.stdout.log'
$stderrPath = Join-Path $dataDir 'server.stderr.log'
$dashboardUrl = 'http://127.0.0.1:4310/fulfillment'

New-Item -ItemType Directory -Force -Path $dataDir | Out-Null

$nodeCommand = Get-Command node -ErrorAction Stop
$npmCommand = Get-Command npm.cmd -ErrorAction Stop
if ([int](& $nodeCommand.Source -p 'process.versions.node.split(".")[0]') -lt 24) { throw 'Node.js 24 이상이 필요합니다.' }

if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'node_modules'))) {
    & $npmCommand.Source ci --prefix $projectRoot
    if ($LASTEXITCODE -ne 0) { throw '의존성 설치에 실패했습니다.' }
}

if (-not $SkipBuild) {
    & $npmCommand.Source run build --prefix $projectRoot
    if ($LASTEXITCODE -ne 0) { throw '프로그램 빌드에 실패했습니다.' }
}

$running = $false
try {
    $health = Invoke-RestMethod -Uri 'http://127.0.0.1:4310/health' -TimeoutSec 2
    $running = [bool]$health.ok
}
catch {
    $running = $false
}

if (-not $running) {
    if (Get-NetTCPConnection -LocalPort 4310 -State Listen -ErrorAction SilentlyContinue) { throw '4310 포트를 다른 프로그램이 사용하고 있습니다.' }
    if ($Portable) { $env:SUPPLIERHUB_PORTABLE = '1' }
    $serverPath = Join-Path $projectRoot 'dist\server.js'
    $serverProcess = Start-Process `
        -FilePath $nodeCommand.Source `
        -ArgumentList @(('"' + $serverPath + '"')) `
        -WorkingDirectory $projectRoot `
        -WindowStyle Hidden `
        -RedirectStandardOutput $stdoutPath `
        -RedirectStandardError $stderrPath `
        -PassThru
    Set-Content -LiteralPath $pidPath -Value $serverProcess.Id -Encoding ascii

    $ready = $false
    for ($attempt = 0; $attempt -lt 20; $attempt += 1) {
        Start-Sleep -Milliseconds 250
        try {
            $health = Invoke-RestMethod -Uri 'http://127.0.0.1:4310/health' -TimeoutSec 1
            if ($health.ok) {
                $ready = $true
                break
            }
        }
        catch {}
    }
    if (-not $ready) {
        throw "대시보드가 시작되지 않았습니다. 로그를 확인하세요: $stderrPath"
    }
}

if ($Portable -and [string]$health.projectRoot -ne $projectRoot) { throw '다른 폴더의 서버가 실행 중입니다. 해당 서버를 종료한 뒤 다시 시작하세요.' }
if (-not $NoBrowser) { Start-Process $dashboardUrl }
