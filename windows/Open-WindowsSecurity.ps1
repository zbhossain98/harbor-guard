#Requires -Version 5.1
<#
.SYNOPSIS
Opens the built-in Windows Security app without changing settings.
#>
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw 'This helper supports Windows only.'
}

try {
    Start-Process -FilePath 'windowsdefender:' -ErrorAction Stop
} catch {
    throw ('Windows Security could not be opened. Search the Start menu for Windows Security instead. Details: {0}' -f $_.Exception.Message)
}
