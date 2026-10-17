<#
.SYNOPSIS
Installs or updates Seyirlik Control, the settings and services dashboard,
reachable over Tailscale only.

.DESCRIPTION
Run as Administrator on the server, from a checkout of this repository:

    powershell -ExecutionPolicy Bypass -File deploy\windows\install-control.ps1

Re-running it is safe and is how the dashboard is updated: the code is
replaced, control.json and its password are kept (only the listen address is
refreshed from Tailscale), and every grant is re-applied idempotently.

What it grants, and nothing else (see docs/control-dashboard.md):

  NT SERVICE\SeyirlikControl
    C:\ProgramData\Seyirlik             traverse only, not inherited
    ...\control\                        modify (its own data: history, audit, config)
    ...\config\ and settings.env        modify (to replace settings.env)
    ...\secrets\ and secrets.env        modify (to replace secrets.env)
    ...\logs\                           read
    SeyirlikServer, SeyirlikWorker,
    SeyirlikPostgres                    query, start, stop

The main services' own rights are not touched: the secrets folder still does
not admit SeyirlikServer or SeyirlikWorker, so a file added beside secrets.env
is still not exposed to them.
#>
[CmdletBinding()]
param(
  [string] $Source = (Join-Path $PSScriptRoot '..\..\control'),
  [string] $InstallDir = 'C:\Program Files\Seyirlik\control',
  [string] $DataRoot = 'C:\ProgramData\Seyirlik',
  [string] $Nssm = 'C:\Program Files\Seyirlik\bin\nssm.exe',
  [string] $Node = 'C:\Program Files\nodejs\node.exe',
  [string] $Tailscale = 'C:\Program Files\Tailscale\tailscale.exe',
  [int] $Port = 43200,
  [string] $ServiceName = 'SeyirlikControl',
  [string[]] $ManagedServices = @('SeyirlikServer', 'SeyirlikWorker', 'SeyirlikPostgres'),
  [string[]] $RestartOnApply = @('SeyirlikServer', 'SeyirlikWorker'),
  [string] $HealthUrl = 'http://127.0.0.1:43111/ownAPI/v1/health',

  # Install without asking for the dashboard password, for a non-interactive
  # session. Set it afterwards with the set-password command in the docs.
  [switch] $SkipPassword
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Run this from an elevated PowerShell (Run as administrator).'
}

$dataDir = Join-Path $DataRoot 'control'
$configDir = Join-Path $DataRoot 'config'
$secretsDir = Join-Path $DataRoot 'secrets'
$logsDir = Join-Path $DataRoot 'logs'
$settingsFile = Join-Path $configDir 'settings.env'
$secretsFile = Join-Path $secretsDir 'secrets.env'
$configPath = Join-Path $dataDir 'control.json'
$account = "NT SERVICE\$ServiceName"

# --- prerequisites -----------------------------------------------------------
foreach ($p in @($Nssm, $Node, $Tailscale, (Join-Path $Source 'server.mjs'))) {
  if (-not (Test-Path -LiteralPath $p)) { throw "not found: $p" }
}
$nodeVersion = (& $Node --version).Trim()
if ([int]($nodeVersion.TrimStart('v').Split('.')[0]) -lt 20) { throw "Node 20 or newer is required (found $nodeVersion)." }
foreach ($p in @($settingsFile, $secretsFile)) {
  if (-not (Test-Path -LiteralPath $p)) { throw "not found: $p (install Seyirlik first)" }
}

$tsIp = (& $Tailscale ip -4 | Select-Object -First 1)
if (-not $tsIp) { throw 'Tailscale has no IPv4 address. Is Tailscale signed in?' }
$tsIp = $tsIp.Trim()
$tsName = $null
try { $tsName = ((& $Tailscale status --json | Out-String | ConvertFrom-Json).Self.DNSName).TrimEnd('.') } catch { }
Write-Output "TAILSCALE_IP=$tsIp"
if ($tsName) { Write-Output "TAILSCALE_NAME=$tsName" }

# --- stop for the update ------------------------------------------------------
$existing = Get-CimInstance Win32_Service -Filter "Name='$ServiceName'" -ErrorAction SilentlyContinue
if ($existing -and $existing.State -ne 'Stopped') {
  & $Nssm stop $ServiceName | Out-Null
}

# --- code ---------------------------------------------------------------------
# Under Program Files, so the service can read its code and cannot change it.
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
& robocopy.exe $Source $InstallDir /MIR /XD test node_modules /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "copying the dashboard failed (robocopy $LASTEXITCODE)" }
$global:LASTEXITCODE = 0
Write-Output "CODE=$InstallDir"

# --- service ------------------------------------------------------------------
if (-not $existing) {
  & $Nssm install $ServiceName $Node | Out-Null
}
& $Nssm set $ServiceName Application $Node | Out-Null
& $Nssm set $ServiceName AppParameters "`"$InstallDir\server.mjs`" --config `"$configPath`"" | Out-Null
& $Nssm set $ServiceName AppDirectory $InstallDir | Out-Null
# Its own log goes in its own data folder: NSSM opens the file as the service
# account, which may only read logs\.
$controlLog = Join-Path $dataDir 'control.log'
& $Nssm set $ServiceName AppStdout $controlLog | Out-Null
& $Nssm set $ServiceName AppStderr $controlLog | Out-Null
& $Nssm set $ServiceName AppRotateFiles 1 | Out-Null
& $Nssm set $ServiceName AppRotateBytes 5242880 | Out-Null
& $Nssm set $ServiceName AppStdoutCreationDisposition 4 | Out-Null
& $Nssm set $ServiceName AppStderrCreationDisposition 4 | Out-Null
& $Nssm set $ServiceName AppExit Default Restart | Out-Null
& $Nssm set $ServiceName AppRestartDelay 5000 | Out-Null
& $Nssm set $ServiceName AppThrottle 10000 | Out-Null
& $Nssm set $ServiceName AppStopMethodConsole 5000 | Out-Null
& $Nssm set $ServiceName Start SERVICE_AUTO_START | Out-Null
& $Nssm set $ServiceName DisplayName 'Seyirlik Control' | Out-Null
& $Nssm set $ServiceName Description 'Settings and services dashboard for Seyirlik, reachable over Tailscale only.' | Out-Null
# Its own virtual account. `sc config obj=` rejects the empty password a
# virtual account needs (1639); NSSM sets it. Windows PowerShell 5.1 drops an
# empty-string argument to a native program, so it has to be spelled '""'.
$emptyPassword = if ($PSVersionTable.PSVersion.Major -ge 7) { '' } else { '""' }
& $Nssm set $ServiceName ObjectName $account $emptyPassword | Out-Null
$startName = (Get-CimInstance Win32_Service -Filter "Name='$ServiceName'").StartName
if ($startName -ne $account) { throw "the service runs as '$startName', not $account; refusing to continue" }

$sid = (New-Object Security.Principal.NTAccount($account)).Translate([Security.Principal.SecurityIdentifier]).Value
Write-Output "SERVICE=$ServiceName SID=$sid"

# --- file permissions ---------------------------------------------------------
function Grant([string] $path, [string] $rights, [string] $inherit) {
  $acl = Get-Acl -LiteralPath $path
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($account, $rights, $inherit, 'None', 'Allow')
  $acl.AddAccessRule($rule)
  Set-Acl -LiteralPath $path -AclObject $acl
}

# Created under the protected root and left to inherit its ACL: setting an
# explicit one with /inheritance:r has produced folders their own writer could
# not read back.
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
Grant $DataRoot 'ReadAndExecute' 'None'
Grant $dataDir 'Modify' 'ContainerInherit,ObjectInherit'
Grant $configDir 'Modify' 'ContainerInherit,ObjectInherit'
Grant $settingsFile 'Modify' 'None'
# Folder modify is what lets the dashboard put a new secrets.env in place of
# the old one. The file keeps its own ACL across that replacement: the
# dashboard copies it onto the new file before the rename, and refuses to save
# if it cannot.
Grant $secretsDir 'Modify' 'ContainerInherit,ObjectInherit'
Grant $secretsFile 'Modify' 'None'
if (Test-Path -LiteralPath $logsDir) { Grant $logsDir 'ReadAndExecute' 'ContainerInherit,ObjectInherit' }
Write-Output 'FILE_GRANTS=ok'

# --- service permissions ------------------------------------------------------
# CC query config, LC query status, SW enumerate dependents, RP start, WP stop,
# LO interrogate, CR user control, RC read permissions.
$ace = "(A;;CCLCSWRPWPLOCRRC;;;$sid)"
foreach ($name in $ManagedServices) {
  if (-not (Get-CimInstance Win32_Service -Filter "Name='$name'" -ErrorAction SilentlyContinue)) {
    Write-Output "SKIP_SERVICE_GRANT=$name (not installed)"
    continue
  }
  $sddl = ((& sc.exe sdshow $name) -join '').Trim()
  if ($sddl -like "*$sid*") { Write-Output "SERVICE_GRANT=$name (already)"; continue }
  $at = $sddl.IndexOf('S:')
  $next = if ($at -ge 0) { $sddl.Insert($at, $ace) } else { $sddl + $ace }
  & sc.exe sdset $name $next | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "could not grant $account control of $name (sc sdset $LASTEXITCODE)" }
  Write-Output "SERVICE_GRANT=$name"
}

# --- configuration ------------------------------------------------------------
$config = [ordered]@{}
if (Test-Path -LiteralPath $configPath) {
  $current = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
  foreach ($p in $current.PSObject.Properties) { $config[$p.Name] = $p.Value }
}
$hosts = @($env:COMPUTERNAME.ToLower())
if ($tsName) { $hosts += $tsName.ToLower(); $hosts += $tsName.Split('.')[0].ToLower() }
$config['listen'] = @($tsIp, '127.0.0.1')
$config['port'] = $Port
$config['allowedHosts'] = @($hosts | Select-Object -Unique)
$config['settingsFile'] = $settingsFile
$config['secretsFile'] = $secretsFile
$config['dataDir'] = $dataDir
$config['logsDir'] = $logsDir
$config['healthUrl'] = $HealthUrl
$config['services'] = $ManagedServices
$config['restartOnApply'] = $RestartOnApply
$config['platform'] = 'windows'
# UTF-8 without a BOM; JSON.parse would reject one.
[IO.File]::WriteAllText($configPath, ($config | ConvertTo-Json -Depth 4), (New-Object Text.UTF8Encoding $false))
Write-Output "CONFIG=$configPath"

# --- firewall -----------------------------------------------------------------
# Inbound on the Tailscale address only, from Tailscale addresses only.
$ruleName = 'Seyirlik Control (Tailscale)'
Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port `
  -LocalAddress $tsIp -RemoteAddress '100.64.0.0/10' -Profile Any | Out-Null
Write-Output 'FIREWALL=ok'

# --- password -----------------------------------------------------------------
if (-not $config['passwordHash'] -and $SkipPassword) {
  Write-Output 'PASSWORD=not set; the dashboard refuses sign-in until set-password is run'
} elseif (-not $config['passwordHash']) {
  Write-Output ''
  Write-Output 'Choose the dashboard password (at least 12 characters).'
  & $Node "$InstallDir\server.mjs" set-password --config $configPath
  if ($LASTEXITCODE -ne 0) { throw 'the password was not set' }
}

# --- start and check ----------------------------------------------------------
& $Nssm start $ServiceName | Out-Null
$ok = $false
for ($i = 0; $i -lt 20 -and -not $ok; $i++) {
  Start-Sleep -Seconds 1
  try {
    $r = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/api/session" -TimeoutSec 3
    $ok = $r.StatusCode -eq 200
  } catch { }
}
if (-not $ok) { throw "the dashboard did not answer on 127.0.0.1:$Port; see $controlLog" }

Write-Output ''
Write-Output 'Seyirlik Control is running. Open it from any device on your tailnet:'
Write-Output "  http://${tsIp}:$Port"
if ($tsName) { Write-Output "  http://${tsName}:$Port" }
