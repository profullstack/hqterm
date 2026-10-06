# hqterm installer for Windows: https://hqterm.sh
#
#   irm https://hqterm.sh/install.ps1 | iex
#
# Installs hqsh (the client and the host side of hqterm sessions) from the
# latest GitHub release of profullstack/hqsh into ~\.local\bin (or
# $env:HQTERM_BIN), checks it against SHA256SUMS, and puts that directory on
# your user PATH so ssh sessions find it. No admin rights. Safe to run again.
# Pin a version with $env:HQSH_VERSION = "v0.3.0".
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Say($msg) { Write-Host "hqterm install: $msg" }

$bin = if ($env:HQTERM_BIN) { $env:HQTERM_BIN } else { Join-Path $HOME '.local\bin' }
$arch = switch ($env:PROCESSOR_ARCHITECTURE) {
  'AMD64' { 'amd64' }
  'ARM64' { 'arm64' }
  default { throw "hqterm install: unsupported CPU $($env:PROCESSOR_ARCHITECTURE) (x64 and arm64 only)" }
}
$base = if ($env:HQSH_VERSION) {
  "https://github.com/profullstack/hqsh/releases/download/$($env:HQSH_VERSION)"
} else {
  'https://github.com/profullstack/hqsh/releases/latest/download'
}

New-Item -ItemType Directory -Force -Path $bin | Out-Null
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("hqterm-" + [Guid]::NewGuid())
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  $asset = "hqsh-windows-$arch.exe"
  Say "downloading $asset from github.com/profullstack/hqsh"
  try {
    Invoke-WebRequest -UseBasicParsing "$base/$asset" -OutFile (Join-Path $tmp $asset)
  } catch {
    if ($arch -eq 'arm64') {
      # Older releases have no arm64 build; Windows on ARM runs x64 binaries.
      $asset = 'hqsh-windows-amd64.exe'
      Say "no arm64 build in this release; using $asset (runs under emulation)"
      Invoke-WebRequest -UseBasicParsing "$base/$asset" -OutFile (Join-Path $tmp $asset)
    } else { throw }
  }
  $file = Join-Path $tmp $asset
  try {
    Invoke-WebRequest -UseBasicParsing "$base/SHA256SUMS" -OutFile (Join-Path $tmp 'SHA256SUMS')
    $line = Get-Content (Join-Path $tmp 'SHA256SUMS') | Where-Object { $_ -match "\s\*?$([regex]::Escape($asset))$" } | Select-Object -First 1
    if (-not $line) {
      Say "warning: $asset is not listed in SHA256SUMS; not verified"
    } else {
      $want = ($line -split '\s+')[0].ToLower()
      $got = (Get-FileHash -Algorithm SHA256 $file).Hash.ToLower()
      if ($want -ne $got) { throw "hqterm install: checksum mismatch for $asset (expected $want, got $got)" }
      Say "verified $asset (sha256 $got)"
    }
  } catch [System.Net.WebException] {
    Say 'warning: no SHA256SUMS in the release; not verified'
  }

  $dest = Join-Path $bin 'hqsh.exe'
  # A running hqsh.exe (a live session's daemon) cannot be overwritten, but it
  # can be renamed: move it aside, then put the new one in place.
  if (Test-Path $dest) {
    $old = "$dest.old"
    Remove-Item -Force $old -ErrorAction SilentlyContinue
    try { Move-Item -Force $dest $old } catch { Say "warning: could not move the old hqsh.exe aside: $_" }
  }
  Move-Item -Force $file $dest
  Say "installed $dest"
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}

# On the user PATH, so `ssh this-pc hqsh server attach` finds it.
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not (($userPath -split ';') -contains $bin)) {
  [Environment]::SetEnvironmentVariable('Path', ($(if ($userPath) { "$userPath;" } else { '' }) + $bin), 'User')
  Say "added $bin to your user PATH (new terminals and ssh sessions pick it up)"
}
$env:Path = "$env:Path;$bin"

& (Join-Path $bin 'hqsh.exe') server setup 2>$null
if ($LASTEXITCODE -ne 0) { Say "note: this hqsh has no 'server setup' yet; sessions start as detached processes" }

if (-not (Get-Service -Name sshd -ErrorAction SilentlyContinue)) {
  Say 'note: to connect TO this PC, enable the OpenSSH server (as Administrator):'
  Say '  Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0'
  Say "  Start-Service sshd; Set-Service sshd -StartupType Automatic"
}
Say 'done. Connect from here with: hqsh <host>   (or hqterm on Linux/macOS)'
