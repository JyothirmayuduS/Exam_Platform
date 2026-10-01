param([Parameter(Mandatory = $true)][string]$Path)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# Read the package database only. Do NOT install or launch the kiosk.
$installer = New-Object -ComObject WindowsInstaller.Installer
$database = $installer.OpenDatabase((Resolve-Path -LiteralPath $Path).Path, 0)
function Read-Rows([string]$Query, [string[]]$Names) {
    $view = $database.OpenView($Query)
    # COM void methods can emit null pipeline values in PowerShell 7. Suppress
    # them and emit named row objects, never arrays that the pipeline can flatten.
    $null = $view.Execute()
    try {
        while ($null -ne ($record = $view.Fetch())) {
            $row = [ordered]@{}
            for ($i = 0; $i -lt $Names.Count; $i++) {
                $row[$Names[$i]] = [string]$record.StringData($i + 1)
            }
            [pscustomobject]$row
        }
    } finally { $null = $view.Close() }
}

$registry = @(Read-Rows 'SELECT `Root`, `Key`, `Name`, `Value` FROM `Registry`' @('Root', 'Key', 'Name', 'Value'))
$protocol = @($registry | Where-Object {
    $_.Key -match '^Software\\Classes\\+vignan-exam$' -and $_.Name -eq 'URL Protocol' -and $_.Root -in @('1', '2')
})
$command = @($registry | Where-Object {
    $_.Key -match '^Software\\Classes\\+vignan-exam\\shell\\open\\command$' -and
    $_.Value -eq '"[!Path]" "%1"' -and $_.Root -in @('1', '2')
})
if ($protocol.Count -ne 1 -or $command.Count -ne 1) {
    throw 'MSI lacks the vignan-exam URL Protocol entry or quoted executable/URL command'
}
$files = @(Read-Rows 'SELECT `File`, `FileName`, `FileSize` FROM `File`' @('File', 'FileName', 'FileSize'))
$main = @($files | Where-Object { $_.File -eq 'Path' -and ($_.FileName -split '\|')[-1] -eq 'vignan-lockdown.exe' })
if ($main.Count -ne 1 -or [long]$main[0].FileSize -lt 1MB) {
    throw 'MSI protocol command does not resolve to a plausible main executable'
}
$summary = $database.SummaryInformation(0)
if ($summary.Property(7) -notmatch '^x64;') { throw 'Expected an x64 MSI package' }
$properties = @(Read-Rows 'SELECT `Property`, `Value` FROM `Property`' @('Property', 'Value'))
$product = @($properties | Where-Object { $_.Property -eq 'ProductName' })
if ($product.Count -ne 1 -or $product[0].Value -ne 'Vignan Exam Browser') { throw 'Unexpected MSI product' }
@{ package = 'msi'; architecture = 'x64'; protocol = 'vignan-exam'; installed = $false } | ConvertTo-Json -Compress
