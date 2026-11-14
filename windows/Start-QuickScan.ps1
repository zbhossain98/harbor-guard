#Requires -Version 5.1
<#
.SYNOPSIS
Starts a Microsoft Defender quick scan after an explicit confirmation.
.EXAMPLE
.\Start-QuickScan.ps1 -WhatIf
.EXAMPLE
.\Start-QuickScan.ps1
#>
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw 'This helper supports Windows only.'
}

try {
    $statusCommand = Get-Command -Name Get-MpComputerStatus -ErrorAction Stop
    $scanCommand = Get-Command -Name Start-MpScan -ErrorAction Stop
    $status = & $statusCommand -ErrorAction Stop
} catch {
    throw ('Microsoft Defender scanning is unavailable or access was denied. Open Windows Security, or your installed antivirus app, to run its scan. Details: {0}' -f $_.Exception.Message)
}

if ($status.AMServiceEnabled -ne $true -or $status.AntivirusEnabled -ne $true) {
    throw 'Microsoft Defender Antivirus is not active. Open Windows Security or your installed antivirus app to run a scan. This helper will not enable Defender or change your antivirus settings.'
}

$runningModeProperty = $status.PSObject.Properties['AMRunningMode']
if ($null -ne $runningModeProperty -and -not [string]::IsNullOrWhiteSpace([string]$runningModeProperty.Value) -and $runningModeProperty.Value -ne 'Normal') {
    throw ('Microsoft Defender reports running mode "{0}". Use Windows Security or your installed antivirus app to select an available scan.' -f $runningModeProperty.Value)
}

if ($PSCmdlet.ShouldProcess('Microsoft Defender Antivirus on this PC', 'Start a quick malware scan')) {
    try {
        & $scanCommand -ScanType QuickScan -ErrorAction Stop
        Write-Output 'The Defender quick-scan command completed. Check Windows Security > Virus & threat protection > Protection history for results. Command completion does not certify that this PC is free of malware.'
    } catch {
        throw ('Defender could not complete the scan command. Open Windows Security to check its status and permissions. This helper does not request elevation. Details: {0}' -f $_.Exception.Message)
    }
}
