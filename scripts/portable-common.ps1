$ErrorActionPreference = 'Stop'
$portableRoot = Split-Path -Parent $PSScriptRoot

function Read-PortableEnvironment {
    $settings = @{}
    $path = Join-Path $portableRoot '.env'
    if (Test-Path -LiteralPath $path) {
        foreach ($line in Get-Content -LiteralPath $path -Encoding UTF8) {
            if ($line -match '^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$') { $settings[$matches[1]] = $matches[2].Trim().Trim('"').Trim("'") }
        }
    }
    return $settings
}
function Set-PortableEnvironmentValue([string]$Name, [string]$Value) {
    if ($Value -match '[\r\n]') { throw '설정값에 줄바꿈을 사용할 수 없습니다.' }
    $path = Join-Path $portableRoot '.env'
    $lines = @(Get-Content -LiteralPath $path -Encoding UTF8 | Where-Object { $_ -notmatch ('^\s*' + [regex]::Escape($Name) + '\s*=') })
    $delimiter = '"'
    if ($Value.Contains('"')) { $delimiter = "'" }
    if ($Value.Contains($delimiter)) { throw '설정값에 두 종류의 따옴표가 있습니다. .env 파일에서 해당 설정을 직접 확인하세요.' }
    $lines += $Name + '=' + $delimiter + $Value + $delimiter
    [IO.File]::WriteAllLines($path, [string[]]$lines, [Text.UTF8Encoding]::new($false))
}
function Find-PortableChrome {
    $candidates = @((Join-Path $env:ProgramFiles 'Google/Chrome/Application/chrome.exe'), (Join-Path ${env:ProgramFiles(x86)} 'Google/Chrome/Application/chrome.exe'), (Join-Path $env:LOCALAPPDATA 'Google/Chrome/Application/chrome.exe'))
    return $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
}
function Assert-PortableNode {
    $node = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $node) { throw 'Node.js 24 이상을 설치한 뒤 다시 실행하세요. https://nodejs.org/' }
    $major = & $node.Source -p 'process.versions.node.split(".")[0]'
    if ($LASTEXITCODE -ne 0 -or [int]$major -lt 24) { throw 'Node.js 24 이상이 필요합니다.' }
    return $node.Source
}
