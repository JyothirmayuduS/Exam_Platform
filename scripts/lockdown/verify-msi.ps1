param([Parameter(Mandatory = $true)][string]$Path)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# Read the package database only. Do NOT install or launch the kiosk.
$installer = New-Object -ComObject WindowsInstaller.Installer
$database = $installer.OpenDatabase((Resolve-Path -LiteralPath $Path).Path, 0)
function Read-Rows([string]$Query, [int]$Columns) {
    $view = $database.OpenView($Query)
    $view.Execute()
    try {
        while ($null -ne ($record = $view.Fetch())) {
            $values = @()
            for ($i = 1; $i -le $Columns; $i++) { $values += $record.StringData($i) }
            # Prevent PowerShell from flattening rows into individual strings.
            Write-Output -NoEnumerate $values
        }
    } finally { $view.Close() }
}

$registry = @(Read-Rows 'SELECT `Root`, `Key`, `Name`, `Value` FROM `Registry`' 4)
$protocol = @($registry | Where-Object {
    $_[1] -match '^Software\\Classes\\+vignan-exam$' -and $_[2] -eq 'URL Protocol' -and $_[0] -in @('1', '2')
})
$command = @($registry | Where-Object {
    $_[1] -match '^Software\\Classes\\+vignan-exam\\shell\\open\\command$' -and
    $_[3] -eq '"[!Path]" "%1"' -and $_[0] -in @('1', '2')
})
if ($protocol.Count -ne 1 -or $command.Count -ne 1) {
    throw 'MSI lacks the vignan-exam URL Protocol entry or quoted executable/URL command'
}
$files = @(Read-Rows 'SELECT `File`, `FileName`, `FileSize` FROM `File`' 3)
$main = @($files | Where-Object { $_[0] -eq 'Path' -and ($_[1] -split '\|')[-1] -eq 'vignan-lockdown.exe' })
if ($main.Count -ne 1 -or [long]$main[0][2] -lt 1MB) {
    throw 'MSI protocol command does not resolve to a plausible main executable'
}
$summary = $database.SummaryInformation(0)
if ($summary.Property(7) -notmatch '^x64;') { throw 'Expected an x64 MSI package' }
$properties = @(Read-Rows 'SELECT `Property`, `Value` FROM `Property`' 2)
$product = @($properties | Where-Object { $_[0] -eq 'ProductName' })
if ($product.Count -ne 1 -or $product[0][1] -ne 'Vignan Exam Browser') { throw 'Unexpected MSI product' }
@{ package = 'msi'; architecture = 'x64'; protocol = 'vignan-exam'; installed = $false } | ConvertTo-Json -Compress
