[CmdletBinding()]
param(
    [switch]$Elevated,
    [ValidateRange(1024, 65535)]
    [int]$Port = 4311,
    [string]$PrinterName = $env:FULFILLMENT_WAYBILL_PRINTER
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$tokenPath = Join-Path $projectRoot 'data\logen-windows-mcp.token'
$pidPath = Join-Path $projectRoot 'data\logen-windows-mcp.pid'
$stdoutPath = Join-Path $projectRoot 'data\logen-windows-mcp.stdout.log'
$stderrPath = Join-Path $projectRoot 'data\logen-windows-mcp.stderr.log'
$entryPath = Join-Path $projectRoot 'dist\logen-windows-print-mcp.js'

function Test-Administrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not $Elevated) {
    $self = $MyInvocation.MyCommand.Path
    $arguments = @(
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', ('"' + $self + '"'),
        '-Elevated',
        '-Port', [string]$Port
    )
    if (-not [string]::IsNullOrWhiteSpace($PrinterName)) {
        $arguments += @('-PrinterName', ('"' + $PrinterName + '"'))
    }
    Start-Process -FilePath 'pwsh.exe' -Verb RunAs -WindowStyle Hidden -ArgumentList $arguments
    [pscustomobject]@{
        status = 'uac_requested'
        message = 'Approve the Windows UAC prompt to start the Logen Windows Print MCP.'
        port = $Port
    } | ConvertTo-Json -Compress
    exit 0
}

if (-not (Test-Administrator)) {
    throw 'The Logen Windows Print MCP must run with administrator privileges.'
}
if ([string]::IsNullOrWhiteSpace($PrinterName)) {
    throw 'Set FULFILLMENT_WAYBILL_PRINTER or pass -PrinterName with the exact Windows printer name.'
}
if (-not (Test-Path -LiteralPath $entryPath -PathType Leaf)) {
    throw "Build output is missing: $entryPath"
}

New-Item -ItemType Directory -Path (Split-Path -Parent $tokenPath) -Force | Out-Null
if (-not (Test-Path -LiteralPath $tokenPath -PathType Leaf)) {
    $bytes = [Security.Cryptography.RandomNumberGenerator]::GetBytes(32)
    [Convert]::ToHexString($bytes).ToLowerInvariant() |
        Set-Content -LiteralPath $tokenPath -NoNewline -Encoding ascii
}

$token = (Get-Content -LiteralPath $tokenPath -Raw).Trim()
if ($token.Length -lt 32) { throw 'The Logen Windows MCP token is invalid.' }

$env:LOGEN_WINDOWS_MCP_TOKEN = $token
$env:LOGEN_WINDOWS_MCP_PORT = [string]$Port
$env:LOGEN_WINDOWS_PRINTER = $PrinterName.Trim()

$node = (Get-Command node.exe -ErrorAction Stop).Source
$startParameters = @{
    FilePath = $node
    ArgumentList = @(('"' + $entryPath + '"'))
    WorkingDirectory = $projectRoot
    WindowStyle = 'Hidden'
    RedirectStandardOutput = $stdoutPath
    RedirectStandardError = $stderrPath
    PassThru = $true
}
$process = Start-Process @startParameters

$process.Id | Set-Content -LiteralPath $pidPath -NoNewline -Encoding ascii

for ($attempt = 0; $attempt -lt 30; $attempt += 1) {
    Start-Sleep -Milliseconds 200
    try {
        $headers = @{ Authorization = "Bearer $token" }
        $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -Headers $headers -TimeoutSec 2
        if ($health.status -eq 'ready') {
            [pscustomobject]@{
                status = 'ready'
                pid = $process.Id
                port = $Port
                printerName = $health.printerName
            } | ConvertTo-Json -Compress
            exit 0
        }
    }
    catch {
        if ($process.HasExited) { break }
    }
}

throw "The Logen Windows Print MCP did not become ready. See $stderrPath"
