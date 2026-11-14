# Optional Windows protection helpers

These PowerShell scripts use Windows' built-in security tools on Windows 10 and 11. They do not install an antivirus, change protection settings, add exclusions, schedule scans, or request administrator access. The browser extension does not execute these scripts; you choose when to run them.

Open **Windows PowerShell** in the project folder. PowerShell 5.1 or later is required; Windows PowerShell 5.1 has the broadest compatibility with the built-in Defender cmdlets.

## Check protection status

```powershell
.\windows\Get-ProtectionStatus.ps1
```

This read-only report shows:

- Defender's reported running mode, actual `WinDefend` service status, antivirus and real-time protection flags, and antivirus signature update date and age.
- Windows Firewall's actual service status and effective Domain, Private, and Public profile settings.
- Antivirus product names registered with Windows Security Center. Registration does not prove a product is running or up to date.

For machine-readable output:

```powershell
.\windows\Get-ProtectionStatus.ps1 -AsJson
```

JSON uses UTC timestamps, explicit query-success flags, nullable unavailable values, and query errors. `AntivirusSignatureAgeDays` is the number of whole days since the reported update, or `null` if unavailable or the update date is in the future. Firewall `Enabled` values preserve Windows' reported text, such as `True`, `False`, or `NotConfigured`.

A stopped or passive Defender service can be expected when another antivirus provides protection. Use Windows Security to confirm which provider is active. If cmdlets, Windows Security Center, or permissions are unavailable, the report includes the available sections and explains missing data. It never assumes missing information means protection is enabled.

SmartScreen is not reported because its effective behavior varies across Windows policy, reputation protection, and browser settings. Review **Windows Security > App & browser control** and the browser's security settings directly.

## Start a quick scan when you choose

Preview the action without starting a scan:

```powershell
.\windows\Start-QuickScan.ps1 -WhatIf
```

Start it explicitly and answer the PowerShell confirmation prompt:

```powershell
.\windows\Start-QuickScan.ps1
```

The helper first reads Defender status. It refuses to start when Defender is inactive or reports a non-normal running mode. If another antivirus is in charge, use that app's scan. Permission or cmdlet failures are reported; the helper does not enable Defender, bypass policy, or elevate itself.

After the scan command returns, review **Windows Security > Virus & threat protection** and **Protection history** for status and findings. A successful command is not evidence that no threats exist. A quick scan checks common malware locations; it does not replace a full or offline scan when those are needed.

## Open Windows Security

```powershell
.\windows\Open-WindowsSecurity.ps1
```

You can also open **Windows Security** from the Start menu. If your organization blocks PowerShell scripts, use the Windows Security interface and follow your administrator's policy. No execution-policy changes are needed by these helpers.

Keep Windows and your antivirus updated. Browser ad blocking reduces some unwanted content and network requests, but cannot inspect all downloaded files or protect every app on the PC. For a suspected infection, use your antivirus' supported scans and remediation guidance.
