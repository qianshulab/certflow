[CmdletBinding()]
param(
    [switch]$Stop,
    [switch]$NoBrowser,
    [ValidateRange(1, 65535)]
    [int]$Port = 3390,
    [string]$Config = ''
)

$ErrorActionPreference = 'Stop'
$baseUrl = "http://127.0.0.1:$Port"
$expectedApp = 'https-cert-manager'
$expectedVersion = '0.4.1'

function Get-GuiHealth {
    try {
        return Invoke-RestMethod -Uri "$baseUrl/api/health" -Method Get -TimeoutSec 2
    }
    catch {
        return $null
    }
}

function Test-LocalPort {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $connection = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
        if (-not $connection.AsyncWaitHandle.WaitOne(500)) { return $false }
        $client.EndConnect($connection)
        return $true
    }
    catch {
        return $false
    }
    finally {
        $client.Dispose()
    }
}

try {
    $health = Get-GuiHealth
    if ($Stop) {
        if ($null -eq $health -or $health.app -ne $expectedApp) {
            if (Test-LocalPort) {
                throw "Port $Port is used by another service. No process was stopped."
            }
            Write-Host 'The certificate manager is already stopped.'
            exit 0
        }
        $state = Invoke-RestMethod -Uri "$baseUrl/api/state" -Method Get -TimeoutSec 5
        if ([string]::IsNullOrWhiteSpace($state.csrfToken)) {
            throw 'The running service did not provide its shutdown token. No process was stopped.'
        }
        $headers = @{ 'Origin' = $baseUrl; 'X-CSRF-Token' = $state.csrfToken }
        $null = Invoke-RestMethod -Uri "$baseUrl/api/shutdown" -Method Post -Headers $headers -ContentType 'application/json' -Body '{}' -TimeoutSec 10
        Write-Host 'Shutdown requested. Wait for any running certificate task to finish.'
        exit 0
    }

    if ($null -ne $health -and $health.app -eq $expectedApp) {
        if ($health.version -ne $expectedVersion) {
            throw "A different certificate manager version is running on port $Port. Stop it before restarting."
        }
        if (-not $NoBrowser) { Start-Process -FilePath $baseUrl }
        exit 0
    }
    if (Test-LocalPort) {
        throw "Port $Port is already in use. Stop that service or use launch-gui.ps1 -Port <number>."
    }

    $nodeCommand = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $nodeCommand) {
        throw 'Node.js 22 or newer is required. Install Node.js and run this launcher again.'
    }
    $nodePath = $nodeCommand.Source
    $nodeVersion = (& $nodePath --version).Trim()
    if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 22) {
        throw "Node.js 22 or newer is required. Detected: $nodeVersion"
    }

    $serverPath = Join-Path $PSScriptRoot 'server.mjs'
    if (-not (Test-Path -LiteralPath $serverPath -PathType Leaf)) {
        throw "Server file is missing: $serverPath"
    }
    if ([string]::IsNullOrWhiteSpace($Config)) {
        $configPath = Join-Path $PSScriptRoot 'cert-config.json'
    }
    elseif ([System.IO.Path]::IsPathRooted($Config)) {
        $configPath = [System.IO.Path]::GetFullPath($Config)
    }
    else {
        $configPath = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot $Config))
    }
    # Windows paths cannot contain quotes; neither path ends in a directory separator.
    # Start-Process joins ArgumentList, so quote each path explicitly for paths with spaces.
    if ($configPath.Contains('"') -or $configPath.EndsWith('\') -or $configPath.EndsWith('/')) {
        throw 'Config must be a file path.'
    }
    $logDir = Join-Path $PSScriptRoot 'data'
    $null = New-Item -ItemType Directory -Path $logDir -Force
    $stdoutPath = Join-Path $logDir 'gui-server.stdout.log'
    $stderrPath = Join-Path $logDir 'gui-server.stderr.log'
    $serverArgs = @(('"' + $serverPath + '"'), '--port', $Port.ToString(), '--config', ('"' + $configPath + '"'))
    $process = Start-Process -FilePath $nodePath -ArgumentList $serverArgs -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -PassThru
    $watch = [System.Diagnostics.Stopwatch]::StartNew()
    do {
        $health = Get-GuiHealth
        if ($null -ne $health -and $health.app -eq $expectedApp -and $health.version -eq $expectedVersion) {
            if (-not $NoBrowser) { Start-Process -FilePath $baseUrl }
            exit 0
        }
        $process.Refresh()
        if ($process.HasExited) {
            throw "The server exited during startup. See $stderrPath"
        }
        Start-Sleep -Milliseconds 250
    } while ($watch.Elapsed.TotalSeconds -lt 15)
    throw "The server did not become ready within 15 seconds. See $stderrPath and $stdoutPath"
}
catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}
