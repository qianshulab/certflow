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
    $releaseFiles = @('Dockerfile', 'compose.yaml', 'compose.build.yaml', '.dockerignore', '.env.example', 'package.json', 'server.mjs', 'cli.mjs', 'cert-config.example.json', 'README.md', 'SECURITY.md', 'docs/docker-nas.md', 'docs/RELEASE-0.4.0.md', 'docs/gui-preview.jpg', 'examples/nginx-docker-config.json')
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
