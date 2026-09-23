param([switch]$NoPause)
. (Join-Path $PSScriptRoot 'portable-common.ps1')
$problems = 0
function Show-Check([string]$Label, [bool]$Ok, [string]$Detail) {
    if (-not $Ok) { $script:problems++ }
    $state = if ($Ok) { '확인' } else { '설정 필요' }
    Write-Host "[$state] $Label : $Detail"
}
try { $node = Assert-PortableNode; Show-Check 'Node.js' $true $node } catch { Show-Check 'Node.js' $false $_.Exception.Message }
$settings = Read-PortableEnvironment
$python = Join-Path $portableRoot '.venv/Scripts/python.exe'
Show-Check 'Python 환경' (Test-Path -LiteralPath $python) '처음설정.cmd에서 프로그램 전용 환경을 만듭니다.'
if (Test-Path -LiteralPath $python) {
    & $python -c 'import openpyxl, pypdfium2' 2>$null
    Show-Check '엑셀·PDF 처리 라이브러리' ($LASTEXITCODE -eq 0) 'openpyxl / pypdfium2'
}
$chrome = Find-PortableChrome
Show-Check 'Google Chrome' ([bool]$chrome) $(if ($chrome) { $chrome } else { 'Chrome을 설치하세요.' })
Show-Check 'PowerShell 7' ([bool](Get-Command pwsh.exe -ErrorAction SilentlyContinue)) '로젠 송장 출력 보조 프로그램에 필요합니다.'
Show-Check '데스크톱 Excel' (Test-Path 'Registry::HKEY_CLASSES_ROOT\Excel.Application') '발주서 XLSX 인쇄에 필요합니다.'
$printers = @(Get-Printer -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name)
foreach ($key in @('FULFILLMENT_ORDER_PRINTER','FULFILLMENT_WAYBILL_PRINTER','FULFILLMENT_SHIPMENT_PRINTER')) {
    $name = [string]$settings[$key]
    Show-Check $key ([bool]($name -and $printers -contains $name)) $(if ($name) { $name } else { '처음 설정에서 프린터를 선택하세요.' })
}
$defaultPrinter = Get-CimInstance Win32_Printer -ErrorAction SilentlyContinue | Where-Object Default | Select-Object -First 1
Show-Check 'Windows 기본 프린터' ([bool]$defaultPrinter -and $defaultPrinter.Name -eq $settings['FULFILLMENT_ORDER_PRINTER']) '발주서 프린터와 같아야 Excel 자동 인쇄가 가능합니다.'
Show-Check '이전 업무 기록' (Test-Path -LiteralPath (Join-Path $portableRoot 'data/fulfillment.db')) '처음 설정에서 기존 업무 기록을 가져옵니다.'
$template = [string]$settings['FULFILLMENT_SHIPMENT_UPLOAD_TEMPLATE']
$templatePath = if ([IO.Path]::IsPathRooted($template)) { $template } else { Join-Path $portableRoot $template }
Show-Check '쉽먼트 양식' ([bool]($template -and (Test-Path -LiteralPath $templatePath))) '새 PC에서 접근할 수 있는 엑셀 양식이 필요합니다.'
Write-Host "`n설정 필요 항목: $problems"
Write-Host '이 점검은 로그인, 실제 주문 등록, 인쇄 성공을 확인하는 작업이 아닙니다.'
if (-not $NoPause) { [void](Read-Host 'Enter를 누르면 닫습니다') }
if ($problems) { exit 1 }
