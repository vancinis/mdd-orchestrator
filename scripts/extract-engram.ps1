param([Parameter(Mandatory=$true)][string]$Archive, [Parameter(Mandatory=$true)][string]$Destination)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead($Archive)
try {
    if ($zip.Entries.Count -gt 32) { throw 'Too many archive entries.' }
    $seen = @{}
    $total = 0L
    $binary = $null
    foreach ($entry in $zip.Entries) {
        $name = $entry.FullName
        # The pinned release contains flat regular files only. Never extract supplied paths.
        if ($name -notmatch '^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$' -or $seen.ContainsKey($name)) { throw 'Unsafe or duplicate archive entry.' }
        $seen[$name] = $true
        $kind = ($entry.ExternalAttributes -shr 16) -band 61440
        if (($kind -ne 0 -and $kind -ne 32768) -or ($entry.ExternalAttributes -band 1040) -ne 0) { throw 'Archive links/directories are not allowed.' }
        $total += $entry.Length
        if ($entry.Length -gt 67108864 -or $total -gt 83886080) { throw 'Archive exceeds extraction limits.' }
        if ($name -ceq 'engram.exe') { $binary = $entry }
    }
    if ($null -eq $binary -or $binary.Length -eq 0) { throw 'Missing Engram binary.' }
    $inputStream = $binary.Open()
    try {
        $outputStream = [System.IO.File]::Open($Destination, [System.IO.FileMode]::CreateNew)
        try {
            $buffer = New-Object byte[] 65536
            $written = 0L
            while (($count = $inputStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
                $written += $count
                if ($written -gt $binary.Length -or $written -gt 67108864) { throw 'Expanded binary exceeds declared size.' }
                $outputStream.Write($buffer, 0, $count)
            }
            if ($written -ne $binary.Length) { throw 'Truncated binary.' }
        } finally { $outputStream.Dispose() }
    } finally { $inputStream.Dispose() }
} finally { $zip.Dispose() }
