param(
  [Parameter(Mandatory=$true)][string]$MasterUrl,
  [Parameter(Mandatory=$false)][string]$EnrollmentCode = "",
  [string]$InstallRoot = "$env:LOCALAPPDATA\AvatarRunner",
  [string]$LivePortraitRoot = "$env:USERPROFILE\.cache\avatar-studio\LivePortrait"
)

$ErrorActionPreference = "Stop"

$runnerSourceRoot = $PSScriptRoot
if (-not (Test-Path $LivePortraitRoot)) { throw "LivePortrait runtime not found: $LivePortraitRoot" }
New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null
Copy-Item -Recurse -Force "$runnerSourceRoot" "$InstallRoot\runner"
Remove-Item -Recurse -Force "$InstallRoot\runner\.venv", "$InstallRoot\.runtime" -ErrorAction SilentlyContinue

$python = (Get-Command python -ErrorAction SilentlyContinue).Source
if (-not $python) { throw "python is required" }
if (-not (Test-Path "$InstallRoot\.venv\Scripts\python.exe")) { & $python -m venv "$InstallRoot\.venv" }
& "$InstallRoot\.venv\Scripts\python.exe" -m pip install -r "$InstallRoot\runner\requirements.txt"

[Environment]::SetEnvironmentVariable("AVATAR_MASTER_URL", $MasterUrl, "User")
[Environment]::SetEnvironmentVariable("AVATAR_RUNTIME_CODE_ROOT", "$InstallRoot\runner\runtime", "User")
[Environment]::SetEnvironmentVariable("AVATAR_RUNNER_RUNTIME_ROOT", "$InstallRoot\.runtime", "User")
[Environment]::SetEnvironmentVariable("AVATAR_RUNTIME_ROOT", "$InstallRoot\.runtime", "User")
[Environment]::SetEnvironmentVariable("AVATAR_RUNNER_CREDENTIALS", "$InstallRoot\credentials.json", "User")
[Environment]::SetEnvironmentVariable("LIVEPORTRAIT_ROOT", $LivePortraitRoot, "User")
[Environment]::SetEnvironmentVariable("LIVEPORTRAIT_PYTHON", "$LivePortraitRoot\.venv\Scripts\python.exe", "User")
[Environment]::SetEnvironmentVariable("AVATAR_PIPELINE_MODE", "staged", "User")
if ($EnrollmentCode) {
  $env:AVATAR_MASTER_URL = $MasterUrl
  $env:AVATAR_RUNTIME_CODE_ROOT = "$InstallRoot\runner\runtime"
  $env:AVATAR_RUNNER_RUNTIME_ROOT = "$InstallRoot\.runtime"
  $env:AVATAR_RUNTIME_ROOT = "$InstallRoot\.runtime"
  $env:AVATAR_RUNNER_CREDENTIALS = "$InstallRoot\credentials.json"
  $env:LIVEPORTRAIT_ROOT = $LivePortraitRoot
  $env:LIVEPORTRAIT_PYTHON = "$LivePortraitRoot\.venv\Scripts\python.exe"
  $env:AVATAR_PIPELINE_MODE = "staged"
  $env:AVATAR_RUNNER_ENROLL_CODE = $EnrollmentCode
  $process = Start-Process -FilePath "$InstallRoot\.venv\Scripts\python.exe" -ArgumentList "-m runner.agent.main" -WorkingDirectory $InstallRoot -PassThru
  for ($i = 0; $i -lt 30; $i++) {
    if (Test-Path "$InstallRoot\credentials.json") { break }
    Start-Sleep -Seconds 1
  }
  if (-not $process.HasExited) { Stop-Process -Id $process.Id -Force }
}
if (-not (Test-Path "$InstallRoot\credentials.json")) { throw "Runner enrollment did not complete. Provide -EnrollmentCode." }

$action = New-ScheduledTaskAction -Execute "$InstallRoot\.venv\Scripts\python.exe" -Argument "-m runner.agent.main" -WorkingDirectory $InstallRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn
Register-ScheduledTask -TaskName "Avatar Runner" -Action $action -Trigger $trigger -Description "Avatar LivePortrait runner" -Force | Out-Null
Start-ScheduledTask -TaskName "Avatar Runner"
Write-Output "Avatar Runner installed at $InstallRoot"
