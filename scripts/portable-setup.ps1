. (Join-Path $PSScriptRoot 'portable-common.ps1')
try {
    $node = Assert-PortableNode
    Write-Host '새 PC에서 사용할 환경을 준비합니다. 기존 업무 기록이 있으면 덮어쓰지 않습니다.'
    if (-not (Test-Path -LiteralPath (Join-Path $portableRoot '.env'))) { Copy-Item -LiteralPath (Join-Path $portableRoot '.env.portable') -Destination (Join-Path $portableRoot '.env') }
    Push-Location $portableRoot
    try {
        & npm.cmd ci
        if ($LASTEXITCODE -ne 0) { throw 'Node 의존성 설치에 실패했습니다. 인터넷 연결과 오류 내용을 확인하세요.' }
        $python = Join-Path $portableRoot '.venv/Scripts/python.exe'
        if (-not (Test-Path -LiteralPath $python)) {
            $systemPython = Get-Command python.exe -ErrorAction SilentlyContinue
            if ($systemPython) { & $systemPython.Source -m venv .venv }
            else {
                $launcher = Get-Command py.exe -ErrorAction SilentlyContinue
                if (-not $launcher) { throw 'Python 3.10 이상을 설치한 뒤 다시 실행하세요. https://www.python.org/' }
                & $launcher.Source -3 -m venv .venv
            }
            if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $python)) { throw 'Python 환경을 만들지 못했습니다. 설치된 Python을 확인하세요.' }
        }
        & $python -m pip install -r scripts/portable-requirements.txt
        if ($LASTEXITCODE -ne 0) { throw 'Python 라이브러리 설치에 실패했습니다.' }
        Set-PortableEnvironmentValue 'FULFILLMENT_PYTHON_EXECUTABLE' ($python.Replace('\','/'))
        if (Test-Path -LiteralPath (Join-Path $portableRoot 'migration/manifest.json')) {
            $result = & $node scripts/portable-data.mjs restore $portableRoot
            if ($LASTEXITCODE -ne 0) { throw '업무 기록 이전에 실패했습니다. 위 오류를 확인하세요.' }
            Write-Host $result
            $import = Get-Content -LiteralPath (Join-Path $portableRoot 'data/portable-import.json') -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($import.templatePath) { Set-PortableEnvironmentValue 'FULFILLMENT_SHIPMENT_UPLOAD_TEMPLATE' (([string]$import.templatePath).Replace('\','/')) }
        }
        $chrome = Find-PortableChrome
        if ($chrome) { Set-PortableEnvironmentValue 'SUPPLIERHUB_CHROME_EXECUTABLE' ($chrome.Replace('\','/')) }
        else { Write-Host 'Google Chrome을 설치한 뒤 처음 설정을 다시 실행하세요.' }
        $printers = @(Get-Printer -ErrorAction SilentlyContinue | Sort-Object Name)
        if ($printers.Count) {
            Write-Host "`n설치된 프린터"
            for ($i=0; $i -lt $printers.Count; $i++) { Write-Host "$($i+1). $($printers[$i].Name)" }
            foreach ($item in @(@('FULFILLMENT_ORDER_PRINTER','발주서'),@('FULFILLMENT_WAYBILL_PRINTER','로젠 송장'),@('FULFILLMENT_SHIPMENT_PRINTER','입고 라벨·내역서'))) {
                $answer = Read-Host "$($item[1]) 프린터 번호 (Enter: 현재 설정 유지)"
                if ($answer) {
                    $number = 0
                    if (-not [int]::TryParse($answer,[ref]$number) -or $number -lt 1 -or $number -gt $printers.Count) { throw '올바른 프린터 번호를 입력하세요.' }
                    Set-PortableEnvironmentValue $item[0] $printers[$number-1].Name
                }
            }
        } else { Write-Host '프린터 드라이버 설치 후 처음 설정을 다시 실행하여 프린터를 선택하세요.' }
        Write-Host "`n준비를 마쳤습니다. 실행환경확인.cmd로 빠진 설정을 확인한 뒤 업무시작.cmd를 실행하세요."
        Write-Host '발주서 프린터를 Windows 기본 프린터로 지정하고, 새 PC의 Chrome에서 Supplier Hub와 로젠에 다시 로그인하세요.'
    } finally { Pop-Location }
} catch { Write-Host $_.Exception.Message -ForegroundColor Red; [void](Read-Host 'Enter'); exit 1 }
[void](Read-Host 'Enter를 누르면 닫습니다')
