param(
  [Parameter(Mandatory = $true)][string]$Root,
  [Parameter(Mandatory = $true)][int]$Port
)

$rootPath = (Resolve-Path -LiteralPath $Root).Path
$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
$listener.Start()
try {
  while ($true) {
    $client = $listener.AcceptTcpClient()
    try {
      $stream = $client.GetStream()
      $reader = [System.IO.StreamReader]::new($stream, [Text.Encoding]::ASCII, $false, 1024, $true)
      $requestLine = $reader.ReadLine()
      while ($reader.ReadLine()) { }
      $requestPath = ($requestLine -split " ")[1].Split("?")[0]
      $relative = [Uri]::UnescapeDataString($requestPath.TrimStart("/")).Replace("/", [IO.Path]::DirectorySeparatorChar)
      if (-not $relative -or $relative.EndsWith([IO.Path]::DirectorySeparatorChar)) { $relative += "index.html" }
      $filePath = [IO.Path]::GetFullPath((Join-Path $rootPath $relative))
      if (-not $filePath.StartsWith($rootPath, [StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path -LiteralPath $filePath -PathType Leaf)) {
        $body = [Text.Encoding]::UTF8.GetBytes("Not found")
        $header = "HTTP/1.1 404 Not Found`r`nContent-Length: $($body.Length)`r`nConnection: close`r`n`r`n"
      } else {
        $body = [IO.File]::ReadAllBytes($filePath)
        $contentType = if ($filePath.EndsWith(".html")) { "text/html; charset=utf-8" } elseif ($filePath.EndsWith(".js")) { "text/javascript; charset=utf-8" } else { "application/octet-stream" }
        $header = "HTTP/1.1 200 OK`r`nContent-Type: $contentType`r`nContent-Length: $($body.Length)`r`nConnection: close`r`n`r`n"
      }
      $headerBytes = [Text.Encoding]::ASCII.GetBytes($header)
      $stream.Write($headerBytes, 0, $headerBytes.Length)
      $stream.Write($body, 0, $body.Length)
    } finally {
      $client.Dispose()
    }
  }
} finally {
  $listener.Stop()
}
