param(
  [Parameter(Mandatory = $true)]
  [string]$Message,
  [string]$Repo = ""
)

$git = "C:\Program Files\Git\mingw64\bin\git.exe"
if (-not (Test-Path $git)) {
  $git = "C:\Program Files\Git\cmd\git.exe"
}

if ($Repo) {
  Set-Location $Repo
}

& $git add -A
$status = & $git status --porcelain
if (-not $status) {
  Write-Output "nothing to commit"
  exit 0
}

$tree = (& $git write-tree).Trim()
$parent = (& $git rev-parse HEAD).Trim()
$msgFile = Join-Path $env:TEMP "sdd-commit-msg.txt"
Set-Content -Path $msgFile -Value $Message -Encoding ascii

if (-not $env:GIT_AUTHOR_NAME) { $env:GIT_AUTHOR_NAME = "Interview Assistant" }
if (-not $env:GIT_AUTHOR_EMAIL) { $env:GIT_AUTHOR_EMAIL = "dev@local" }
$env:GIT_COMMITTER_NAME = $env:GIT_AUTHOR_NAME
$env:GIT_COMMITTER_EMAIL = $env:GIT_AUTHOR_EMAIL

$commit = (Get-Content $msgFile -Raw | & $git commit-tree $tree -p $parent).Trim()
if (-not $commit) {
  throw "commit-tree failed"
}
& $git update-ref HEAD $commit
& $git log -1 --oneline
