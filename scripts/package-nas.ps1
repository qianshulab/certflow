[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$releaseVersion = (Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json).version
$releaseDirectory = Join-Path $projectRoot 'dist'
$null = New-Item -ItemType Directory -Path $releaseDirectory -Force
$releasePath = Join-Path $releaseDirectory ("CertFlow-NAS-v" + $releaseVersion + '.zip')
if (Test-Path -LiteralPath $releasePath) { throw "Release already exists: $releasePath. Choose a new version or move the previous generated archive first." }
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.IO.Compression
$archive = [System.IO.Compression.ZipFile]::Open($releasePath, [System.IO.Compression.ZipArchiveMode]::Create)
try {
    $releaseFiles = @('Dockerfile', 'compose.yaml', 'compose.build.yaml', 'compose.host-network.yaml', 'compose.dns-compat.yaml', '.dockerignore', '.env.example', 'package.json', 'server.mjs', 'cli.mjs', 'cert-config.example.json', 'launch-gui.ps1', '启动图形界面.cmd', '停止图形界面.cmd', 'README.md', 'SECURITY.md', 'docs/docker-nas.md', 'docs/configuration.md', 'docs/remote-pull.md', "docs/RELEASE-$releaseVersion.md", 'docs/gui-preview.jpg', 'docs/gui-credentials.jpg', 'examples/nginx-docker-config.json', 'scripts/certflow-pull.py')
    $imageEvidence = "docs/releases/v$releaseVersion-image.json"
    if (Test-Path -LiteralPath (Join-Path $projectRoot $imageEvidence)) { $releaseFiles += $imageEvidence }
    foreach ($folder in @('src', 'web')) {
        $releaseFiles += Get-ChildItem -LiteralPath (Join-Path $projectRoot $folder) -File | ForEach-Object { $folder + '/' + $_.Name }
    }
    foreach ($relative in $releaseFiles) {
        $source = Join-Path $projectRoot $relative
        $null = [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $source, $relative, [System.IO.Compression.CompressionLevel]::Optimal)
    }
} finally { $archive.Dispose() }
Write-Output $releasePath
Get-FileHash -LiteralPath $releasePath -Algorithm SHA256 | Select-Object Hash
