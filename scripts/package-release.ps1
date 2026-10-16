param(
  [ValidateSet("Production", "Recovery")]
  [string]$Mode = "Production"
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$outputName = if ($Mode -eq "Production") { "dist" } else { "recovery-dist" }
$outputPath = [IO.Path]::GetFullPath((Join-Path $repoRoot $outputName))
$expectedPrefix = $repoRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar

if (-not $outputPath.StartsWith($expectedPrefix, [StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to package outside the repository."
}

$runtimeFiles = @(
  "index.html",
  "feedback-config.js",
  "auth-config.js",
  "auth-service.js",
  "learning-sync.js",
  "remote-assessment-repository.js",
  "sw.js",
  "manifest.json"
)
$iconFiles = @(
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/maskable-512.png"
)
$allowedFiles = @($runtimeFiles + $iconFiles | Sort-Object)

if (Test-Path -LiteralPath $outputPath) {
  Remove-Item -LiteralPath $outputPath -Recurse -Force
}
New-Item -ItemType Directory -Path (Join-Path $outputPath "icons") -Force | Out-Null

foreach ($relativePath in $runtimeFiles + $iconFiles) {
  $sourcePath = Join-Path $repoRoot $relativePath
  if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
    throw "Required runtime asset is missing: $relativePath"
  }
  $destinationPath = Join-Path $outputPath $relativePath
  Copy-Item -LiteralPath $sourcePath -Destination $destinationPath
}

if ($Mode -eq "Recovery") {
  $utf8NoBom = [Text.UTF8Encoding]::new($false)
  $productionVersion = "v=26"
  $recoveryVersion = "v=26-recovery-3"

  $indexPath = Join-Path $outputPath "index.html"
  $index = [IO.File]::ReadAllText($indexPath)
  $versionedScriptCount = ([regex]::Matches($index, [regex]::Escape($productionVersion))).Count
  if ($versionedScriptCount -ne 5) {
    throw "Expected five production script-version references; found $versionedScriptCount."
  }
  $index = $index.Replace($productionVersion, $recoveryVersion)
  [IO.File]::WriteAllText($indexPath, $index, $utf8NoBom)

  $workerPath = Join-Path $outputPath "sw.js"
  $worker = [IO.File]::ReadAllText($workerPath)
  if (-not $worker.Contains('const CACHE_VERSION = "aiml-deck-v26";')) {
    throw "The recovery package expected production cache version aiml-deck-v26."
  }
  $worker = $worker.Replace('const CACHE_VERSION = "aiml-deck-v26";', 'const CACHE_VERSION = "aiml-deck-recovery-v3";')
  $worker = $worker.Replace($productionVersion, $recoveryVersion)
  [IO.File]::WriteAllText($workerPath, $worker, $utf8NoBom)

  $recoveryConfig = @'
/* Emergency recovery build: authentication and cloud synchronization are disabled.
 * Existing schema-5 local history remains stored without a downgrade or destructive rewrite.
 */
window.AIML_AUTH_CONFIG = Object.freeze({
  supabaseUrl: "",
  supabasePublishableKey: ""
});
'@
  [IO.File]::WriteAllText((Join-Path $outputPath "auth-config.js"), $recoveryConfig + "`n", $utf8NoBom)
}

$actualFiles = Get-ChildItem -LiteralPath $outputPath -File -Recurse | ForEach-Object {
  $_.FullName.Substring($outputPath.Length + 1).Replace([IO.Path]::DirectorySeparatorChar, "/")
} | Sort-Object

if (Compare-Object -ReferenceObject $allowedFiles -DifferenceObject $actualFiles) {
  throw "The generated $outputName directory does not match the runtime allowlist."
}

Write-Host "$Mode package created at $outputPath with $($actualFiles.Count) allowlisted files."
