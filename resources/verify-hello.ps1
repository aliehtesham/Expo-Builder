# Expo Builder — Windows Hello consent prompt (fingerprint / PIN / face).
# Invoked by main.ts before decrypting the saved signing passwords:
#   powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File verify-hello.ps1 "<message>"
# Exit codes: 0 = verified, 1 = declined/failed, 2 = Windows Hello not configured, 3 = error
param(
  [string]$Message = 'Confirm it is you',
  # Only run the availability probe (no consent UI) — used by tests.
  [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'

try {
  # Load the WinRT type (works in Windows PowerShell 5.1, which is why main.ts
  # always spawns powershell.exe and never pwsh).
  $null = [Windows.Security.Credentials.UI.UserConsentVerifier, Windows.Security.Credentials.UI, ContentType = WindowsRuntime]

  # Bridge WinRT IAsyncOperation -> .NET Task so we can block on it.
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
      $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
      $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    })[0]
  if (-not $asTaskGeneric) { exit 3 }

  function Await($WinRtOperation, [Type]$ResultType) {
    $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
    $netTask = $asTask.Invoke($null, @($WinRtOperation))
    $netTask.Wait(-1) | Out-Null
    $netTask.Result
  }

  $availability = Await ([Windows.Security.Credentials.UI.UserConsentVerifier]::CheckAvailabilityAsync()) ([Windows.Security.Credentials.UI.UserConsentVerifierAvailability])
  if ($availability -ne [Windows.Security.Credentials.UI.UserConsentVerifierAvailability]::Available) { exit 2 }
  if ($CheckOnly) { exit 0 }

  $result = Await ([Windows.Security.Credentials.UI.UserConsentVerifier]::RequestVerificationAsync($Message)) ([Windows.Security.Credentials.UI.UserConsentVerificationResult])
  if ($result -eq [Windows.Security.Credentials.UI.UserConsentVerificationResult]::Verified) { exit 0 }
  exit 1
}
catch {
  exit 3
}
