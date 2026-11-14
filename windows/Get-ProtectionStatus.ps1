#Requires -Version 5.1
<#
.SYNOPSIS
Reports Microsoft Defender and Windows Firewall status without changing settings.
.EXAMPLE
.\Get-ProtectionStatus.ps1
.EXAMPLE
.\Get-ProtectionStatus.ps1 -AsJson
#>
[CmdletBinding()]
param(
    [switch]$AsJson
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw 'This helper supports Windows only.'
}

function Get-ReportedValue {
    param($InputObject, [string]$PropertyName)

    if ($null -eq $InputObject) { return $null }
    $property = $InputObject.PSObject.Properties[$PropertyName]
    if ($null -eq $property) { return $null }
    return $property.Value
}

function Format-ReportedValue {
    param($Value)

    if ($null -eq $Value -or [string]::IsNullOrWhiteSpace([string]$Value)) {
        return 'Not reported'
    }
    if ($Value -is [bool]) {
        if ($Value) { return 'Enabled' }
        return 'Disabled'
    }
    return [string]$Value
}

$report = [ordered]@{
    GeneratedAtUtc = [DateTime]::UtcNow.ToString('o')
    Defender = [ordered]@{
        QuerySucceeded = $false
        RunningMode = $null
        ServiceStatus = $null
        AMServiceEnabled = $null
        AntivirusEnabled = $null
        RealTimeProtectionEnabled = $null
        AntivirusSignatureLastUpdatedUtc = $null
        AntivirusSignatureAgeDays = $null
        Errors = @()
    }
    Firewall = [ordered]@{
        QuerySucceeded = $false
        ServiceStatus = $null
        Profiles = @()
        Errors = @()
    }
    RegisteredAntivirus = [ordered]@{
        QuerySucceeded = $false
        ProductNames = @()
        Error = $null
    }
}

try {
    $report.Defender.ServiceStatus = (Get-Service -Name WinDefend).Status.ToString()
} catch {
    $report.Defender.Errors += 'Defender service status: ' + $_.Exception.Message
}

try {
    $statusCommand = Get-Command -Name Get-MpComputerStatus -ErrorAction Stop
    $status = & $statusCommand -ErrorAction Stop
    $report.Defender.RunningMode = Get-ReportedValue $status 'AMRunningMode'
    $report.Defender.AMServiceEnabled = Get-ReportedValue $status 'AMServiceEnabled'
    $report.Defender.AntivirusEnabled = Get-ReportedValue $status 'AntivirusEnabled'
    $report.Defender.RealTimeProtectionEnabled = Get-ReportedValue $status 'RealTimeProtectionEnabled'

    $lastUpdated = Get-ReportedValue $status 'AntivirusSignatureLastUpdated'
    if ($null -ne $lastUpdated) {
        $updatedUtc = ([DateTime]$lastUpdated).ToUniversalTime()
        # Defender may return a sentinel date when no signature information exists.
        if ($updatedUtc.Year -ge 2000) {
            $report.Defender.AntivirusSignatureLastUpdatedUtc = $updatedUtc.ToString('o')
            $age = [DateTime]::UtcNow - $updatedUtc
            if ($age.TotalSeconds -ge 0) {
                $report.Defender.AntivirusSignatureAgeDays = [Math]::Floor($age.TotalDays)
            } else {
                $report.Defender.Errors += 'The signature date is in the future; check the system clock.'
            }
        }
    }
    $report.Defender.QuerySucceeded = $true
} catch {
    $report.Defender.Errors += 'Defender status query: ' + $_.Exception.Message
}

try {
    $report.Firewall.ServiceStatus = (Get-Service -Name mpssvc).Status.ToString()
} catch {
    $report.Firewall.Errors += 'Windows Firewall service status: ' + $_.Exception.Message
}

try {
    $firewallCommand = Get-Command -Name Get-NetFirewallProfile -ErrorAction Stop
    # ActiveStore reports the effective policy, including applicable Group Policy.
    $profiles = @(& $firewallCommand -PolicyStore ActiveStore -ErrorAction Stop)
    $report.Firewall.Profiles = @($profiles | ForEach-Object {
        [ordered]@{
            Name = [string]$_.Name
            Enabled = [string]$_.Enabled
        }
    })
    $report.Firewall.QuerySucceeded = $true
} catch {
    $report.Firewall.Errors += 'Windows Firewall profile query: ' + $_.Exception.Message
}

try {
    $products = @(Get-CimInstance -Namespace 'root/SecurityCenter2' -ClassName AntivirusProduct -OperationTimeoutSec 10)
    # Registration alone does not establish whether an antivirus product is active.
    $report.RegisteredAntivirus.ProductNames = @($products | ForEach-Object { $_.displayName } | Sort-Object -Unique)
    $report.RegisteredAntivirus.QuerySucceeded = $true
} catch {
    $report.RegisteredAntivirus.Error = $_.Exception.Message
}

if ($AsJson) {
    $report | ConvertTo-Json -Depth 6
    return
}

Write-Output ('Windows protection status - {0}' -f $report.GeneratedAtUtc)
Write-Output ''
Write-Output 'Microsoft Defender Antivirus'
Write-Output ('  Status query succeeded: {0}' -f $report.Defender.QuerySucceeded)
Write-Output ('  Running mode: {0}' -f (Format-ReportedValue $report.Defender.RunningMode))
Write-Output ('  WinDefend service: {0}' -f (Format-ReportedValue $report.Defender.ServiceStatus))
Write-Output ('  Antivirus: {0}' -f (Format-ReportedValue $report.Defender.AntivirusEnabled))
Write-Output ('  Real-time protection: {0}' -f (Format-ReportedValue $report.Defender.RealTimeProtectionEnabled))
Write-Output ('  Signatures updated (UTC): {0}' -f (Format-ReportedValue $report.Defender.AntivirusSignatureLastUpdatedUtc))
Write-Output ('  Signature age (whole days): {0}' -f (Format-ReportedValue $report.Defender.AntivirusSignatureAgeDays))
foreach ($statusError in $report.Defender.Errors) { Write-Output ('  Could not fully report: {0}' -f $statusError) }

Write-Output ''
Write-Output 'Windows Firewall'
Write-Output ('  Windows Firewall service: {0}' -f (Format-ReportedValue $report.Firewall.ServiceStatus))
foreach ($profile in $report.Firewall.Profiles) {
    Write-Output ('  {0} profile enabled: {1}' -f $profile.Name, $profile.Enabled)
}
foreach ($statusError in $report.Firewall.Errors) { Write-Output ('  Could not fully report: {0}' -f $statusError) }

Write-Output ''
Write-Output 'Registered antivirus products (names only; registration does not confirm protection)'
if ($report.RegisteredAntivirus.QuerySucceeded) {
    if ($report.RegisteredAntivirus.ProductNames.Count -eq 0) {
        Write-Output '  None reported by Windows Security Center.'
    } else {
        foreach ($productName in $report.RegisteredAntivirus.ProductNames) { Write-Output ('  {0}' -f $productName) }
    }
} else {
    Write-Output ('  Not available: {0}' -f $report.RegisteredAntivirus.Error)
}
Write-Output ''
Write-Output 'This is a status report, not a malware scan. A third-party antivirus can place Defender in passive mode.'
Write-Output 'Use Windows Security or your antivirus app to review reported problems.'
