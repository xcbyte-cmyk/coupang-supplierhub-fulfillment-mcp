. (Join-Path $PSScriptRoot 'portable-common.ps1')
try {
    $node = Assert-PortableNode
    if (-not (Test-Path -LiteralPath (Join-Path $portableRoot '.env')) -or -not (Test-Path -LiteralPath (Join-Path $portableRoot '.venv/Scripts/python.exe'))) { throw '먼저 처음설정.cmd를 실행하세요.' }
    if (-not (Test-Path -LiteralPath (Join-Path $portableRoot 'data/fulfillment.db'))) { throw '기존 업무 자료를 가져오지 않았습니다. 처음 설정의 이전 결과를 확인하세요.' }
    & (Join-Path $portableRoot 'start-dashboard.ps1') -Portable -SkipBuild -NoBrowser
    $settings = Read-PortableEnvironment
    $printer = [string]$settings['FULFILLMENT_WAYBILL_PRINTER']
    $pwsh = Get-Command pwsh.exe -ErrorAction SilentlyContinue
    if ($printer -and $pwsh -and $settings['LOGEN_INTEGRATION_METHOD'] -ne 'api') {
        $ready = $false
        $tokenPath = Join-Path $portableRoot 'data/logen-windows-mcp.token'
        if (Test-Path -LiteralPath $tokenPath) {
            try {
                $token = (Get-Content -LiteralPath $tokenPath -Raw).Trim()
                $health = Invoke-RestMethod -Uri 'http://127.0.0.1:4311/health' -Headers @{ Authorization = "Bearer $token" } -TimeoutSec 2
                $ready = $health.status -eq 'ready' -and $health.printerName -eq $printer
            } catch {}
        }
        if (-not $ready) {
            if (Get-NetTCPConnection -LocalPort 4311 -State Listen -ErrorAction SilentlyContinue) { throw '다른 로젠 출력 보조 프로그램이 실행 중입니다. 해당 프로그램을 종료한 뒤 다시 실행하세요.' }
            & $pwsh.Source -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'start-logen-windows-mcp.ps1') -PrinterName $printer
            if ($LASTEXITCODE -ne 0) { throw '로젠 출력 보조 프로그램을 시작하지 못했습니다.' }
            Write-Host 'Windows 권한 확인 창이 나오면 승인하세요. 출력 보조 프로그램이 준비된 뒤 송장 출력을 진행하세요.'
        }
    } else { Write-Host '송장 프린터 및 PowerShell 7 설정은 실행환경확인.cmd에서 확인하세요.' }
    Start-Process 'http://127.0.0.1:4310/fulfillment/beginner'
} catch { Write-Host $_.Exception.Message -ForegroundColor Red; [void](Read-Host 'Enter'); exit 1 }
