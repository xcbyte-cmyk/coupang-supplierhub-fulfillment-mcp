$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$dataDir = Join-Path $projectRoot 'data'
$pidPath = Join-Path $dataDir 'server.pid'
$stdoutPath = Join-Path $dataDir 'server.stdout.log'
$stderrPath = Join-Path $dataDir 'server.stderr.log'
$dashboardUrl = 'http://127.0.0.1:4310/'

New-Item -ItemType Directory -Force -Path $dataDir | Out-Null

$nodeCommand = Get-Command node -ErrorAction Stop
$npmCommand = Get-Command npm.cmd -ErrorAction Stop

if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'node_modules'))) {
    & $npmCommand.Source install --prefix $projectRoot
}

& $npmCommand.Source run build --prefix $projectRoot

$running = $false
try {
    $health = Invoke-RestMethod -Uri 'http://127.0.0.1:4310/health' -TimeoutSec 2
    $running = [bool]$health.ok
}
catch {
    $running = $false
}

if (-not $running) {
    $serverPath = Join-Path $projectRoot 'dist\server.js'
    $serverProcess = Start-Process `
        -FilePath $nodeCommand.Source `
        -ArgumentList @($serverPath) `
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

Start-Process $dashboardUrl
