param(
    [Parameter(Mandatory = $true)]
    [string]$ManifestBase64
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$excel = $null
$workbook = $null

try {
    $manifestJson = [System.Text.Encoding]::UTF8.GetString(
        [System.Convert]::FromBase64String($ManifestBase64)
    )
    $manifest = $manifestJson | ConvertFrom-Json

    if (-not $manifest.files -or @($manifest.files).Count -eq 0) {
        throw '인쇄할 XLSX 파일이 없습니다.'
    }

    $copies = [int]$manifest.copies
    if ($copies -lt 1 -or $copies -gt 5) {
        throw '인쇄 부수는 1~5 사이여야 합니다.'
    }

    $targetPrinter = Get-Printer -Name ([string]$manifest.printerName) -ErrorAction Stop
    $defaultPrinter = Get-CimInstance Win32_Printer |
        Where-Object { $_.Default -eq $true } |
        Select-Object -First 1

    if (-not $defaultPrinter) {
        throw 'Windows 기본 프린터를 찾지 못했습니다.'
    }
    if ($defaultPrinter.Name -ne $targetPrinter.Name) {
        throw "안전한 Excel 자동 인쇄를 위해 설정 프린터를 Windows 기본 프린터로 지정해야 합니다. 현재 기본값: $($defaultPrinter.Name)"
    }
    if ($defaultPrinter.WorkOffline) {
        throw "프린터가 오프라인입니다: $($targetPrinter.Name)"
    }

    $excel = New-Object -ComObject Excel.Application
    $excel.Visible = $false
    $excel.DisplayAlerts = $false
    $excel.AskToUpdateLinks = $false

    $submitted = @()
    foreach ($file in @($manifest.files)) {
        $resolved = (Resolve-Path -LiteralPath ([string]$file) -ErrorAction Stop).Path
        if ([System.IO.Path]::GetExtension($resolved).ToLowerInvariant() -ne '.xlsx') {
            throw "XLSX가 아닌 파일은 인쇄할 수 없습니다: $resolved"
        }

        try {
            $workbook = $excel.Workbooks.Open($resolved, 0, $true)
            $printLayout = [string]$manifest.layout
            if (-not $printLayout -and $resolved -match '[\\/]orders[\\/]') {
                # Running servers from before this option was added do not include layout yet.
                $printLayout = 'landscape_fit_one_page'
            }
            if ($printLayout -eq 'landscape_fit_one_page') {
                for ($sheetIndex = 1; $sheetIndex -le $workbook.Worksheets.Count; $sheetIndex += 1) {
                    $worksheet = $null
                    try {
                        $worksheet = $workbook.Worksheets.Item($sheetIndex)
                        # Excel constants: xlLandscape = 2, xlPaperA4 = 9
                        $worksheet.PageSetup.Orientation = 2
                        $worksheet.PageSetup.PaperSize = 9
                        $worksheet.PageSetup.Zoom = $false
                        $worksheet.PageSetup.FitToPagesWide = 1
                        $worksheet.PageSetup.FitToPagesTall = 1
                    }
                    finally {
                        if ($worksheet) {
                            [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($worksheet)
                        }
                    }
                }
            }
            $missing = [System.Type]::Missing
            $workbook.PrintOut($missing, $missing, $copies, $false)
            $submitted += [System.IO.Path]::GetFileName($resolved)
        }
        finally {
            if ($workbook) {
                $workbook.Close($false)
                [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($workbook)
                $workbook = $null
            }
        }
    }

    Start-Sleep -Seconds 2
    $errorJobs = @(Get-PrintJob -PrinterName $targetPrinter.Name -ErrorAction SilentlyContinue |
        Where-Object { $_.JobStatus -match 'Error|Offline|PaperOut|Blocked' })
    if ($errorJobs.Count -gt 0) {
        throw "인쇄 큐 오류가 감지되었습니다: $($errorJobs[0].JobStatus)"
    }

    [pscustomobject]@{
        success = $true
        submittedFiles = $submitted
        message = "$($targetPrinter.Name)에 XLSX $($submitted.Count)개를 각 ${copies}부 제출했습니다."
    } | ConvertTo-Json -Compress
}
catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
finally {
    if ($workbook) {
        try { $workbook.Close($false) } catch {}
        try { [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($workbook) } catch {}
    }
    if ($excel) {
        try { $excel.Quit() } catch {}
        try { [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($excel) } catch {}
    }
    [GC]::Collect()
    [GC]::WaitForPendingFinalizers()
}
