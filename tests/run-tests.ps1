$ErrorActionPreference = "Stop"

$edgeCandidates = @(
  "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
  "C:\Program Files\Microsoft\Edge\Application\msedge.exe"
)
$edge = $edgeCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $edge) { throw "Microsoft Edge was not found." }

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$port = Get-Random -Minimum 18000 -Maximum 28000
$profile = Join-Path $repoRoot (".edge-test-" + [guid]::NewGuid().ToString("N"))
$server = $null
try {
  $serverScript = Join-Path $PSScriptRoot "test-server.ps1"
  $serverArgs = "-NoProfile -ExecutionPolicy Bypass -File `"$serverScript`" -Root `"$repoRoot`" -Port $port"
  $server = Start-Process powershell -ArgumentList $serverArgs -PassThru -WindowStyle Hidden
  $ready = $false
  for ($attempt = 0; $attempt -lt 20 -and -not $ready; $attempt++) {
    try {
      $null = Invoke-WebRequest "http://127.0.0.1:$port/tests/" -UseBasicParsing -TimeoutSec 1
      $ready = $true
    } catch { Start-Sleep -Milliseconds 100 }
  }
  if (-not $ready) { throw "The local test server did not start." }
  $browserOut = Join-Path $repoRoot (".edge-test-output-" + [guid]::NewGuid().ToString("N") + ".txt")
  $browserErr = Join-Path $repoRoot (".edge-test-error-" + [guid]::NewGuid().ToString("N") + ".txt")
  $browserArgs = "--headless=new --disable-gpu --disable-software-rasterizer --no-sandbox --no-first-run --user-data-dir=`"$profile`" --virtual-time-budget=10000 --dump-dom http://127.0.0.1:$port/tests/"
  $browser = Start-Process -FilePath $edge -ArgumentList $browserArgs -RedirectStandardOutput $browserOut -RedirectStandardError $browserErr -PassThru -Wait
  $html = Get-Content -LiteralPath $browserOut -Raw
  $summary = [regex]::Match(($html -join "`n"), '<p id="summary">([^<]+)</p>').Groups[1].Value
  if (-not $summary) {
    $preview = ($html -join "`n")
    Write-Host $preview.Substring(0, [Math]::Min(1000, $preview.Length))
    throw "The browser test page did not finish."
  }
  Write-Host $summary
  if (($html -join "`n") -notmatch '<body data-status="passed">') { exit 1 }
}
finally {
  if ($server -and -not $server.HasExited) { Stop-Process -Id $server.Id -Force }
  if ($browserOut -and (Test-Path -LiteralPath $browserOut)) { Remove-Item -LiteralPath $browserOut -Force }
  if ($browserErr -and (Test-Path -LiteralPath $browserErr)) { Remove-Item -LiteralPath $browserErr -Force }
  if (Test-Path -LiteralPath $profile) {
    $resolvedProfile = (Resolve-Path -LiteralPath $profile).Path
    if ($resolvedProfile.StartsWith($repoRoot, [StringComparison]::OrdinalIgnoreCase)) {
      Remove-Item -LiteralPath $resolvedProfile -Recurse -Force
    }
  }
}
