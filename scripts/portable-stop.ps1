. (Join-Path $PSScriptRoot 'portable-common.ps1')
try {
    foreach ($item in @(@('server.pid','server.js'),@('logen-windows-mcp.pid','logen-windows-print-mcp.js'))) {
        $pidFile = Join-Path $portableRoot ('data/' + $item[0])
        if (-not (Test-Path -LiteralPath $pidFile)) { continue }
        $taskProcessId = 0
        if (-not [int]::TryParse((Get-Content -LiteralPath $pidFile -Raw).Trim(),[ref]$taskProcessId)) { continue }
        $process = Get-CimInstance Win32_Process -Filter "ProcessId=$taskProcessId" -ErrorAction SilentlyContinue
        $entry = Join-Path $portableRoot ('dist\' + $item[1])
        if ($process -and $process.CommandLine -and $process.CommandLine.IndexOf($entry,[StringComparison]::OrdinalIgnoreCase) -ge 0) {
            Stop-Process -Id $taskProcessId -ErrorAction Stop
            Write-Host "$($item[1]) 종료 요청 완료"
        }
    }
} catch { Write-Host '관리자 권한의 보조 프로그램은 관리자 권한으로 업무종료를 실행해야 종료할 수 있습니다.'; Write-Host $_.Exception.Message; [void](Read-Host 'Enter'); exit 1 }
