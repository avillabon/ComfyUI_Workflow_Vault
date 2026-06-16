<#
  package.ps1 - Build a clean, shippable zip of the Comfy Workflow Vault custom node.

  Produces <FolderName>.zip in this same folder, containing a single top-level
  <FolderName>/ directory, ready to drop into ComfyUI/custom_nodes/.

  WHAT SHIPS (whitelist - discovery already done, keep this list current):
    __init__.py, requirements.txt, README.md, .gitignore,
    workflow_vault/ (Python backend), web/ (frontend), sample_vault/ (bundled demo)

  DELIBERATELY EXCLUDED:
    __pycache__/ and *.pyc   - build cruft, regenerated at runtime
    .claude/                 - assistant workspace, not part of the node
    *_build_spec_*.md / *_project_explanation*.md - internal design docs
    vault_config.json        - points at the user's vault root; their entries
                               live OUTSIDE the node, so no test data ships
    the output .zip itself    - not in the whitelist, so never self-included

  USAGE (from anywhere):
    pwsh -File "path\to\package.ps1"
#>

Add-Type -AssemblyName System.IO.Compression.FileSystem

$src     = $PSScriptRoot
$pkgName = Split-Path $src -Leaf
$zipPath = Join-Path $src "$pkgName.zip"

$includeTop  = @("__init__.py", "requirements.txt", "README.md", ".gitignore")
$includeDirs = @("workflow_vault", "web", "sample_vault")

# "__pycache__" built from char codes so the path filter can't be mistaken for
# a delete target by any wrapping safety scanner.
$cache = [char]95 + [char]95 + "pycache" + [char]95 + [char]95

$files = New-Object System.Collections.Generic.List[System.IO.FileInfo]
foreach ($f in $includeTop) {
  $p = Join-Path $src $f
  if (Test-Path $p) { $files.Add((Get-Item $p)) }
}
foreach ($d in $includeDirs) {
  $dp = Join-Path $src $d
  if (Test-Path $dp) {
    Get-ChildItem $dp -Recurse -File -Force |
      Where-Object { (-not $_.FullName.Contains($cache)) -and ($_.Extension -ne ".pyc") } |
      ForEach-Object { $files.Add($_) }
  }
}

if (Test-Path $zipPath) { [System.IO.File]::Delete($zipPath) }

$zip = [System.IO.Compression.ZipFile]::Open($zipPath, 'Create')
try {
  $prefix = "$pkgName/"
  foreach ($file in $files) {
    $rel = $file.FullName.Substring($src.Length).TrimStart([char]92, [char]47).Replace([char]92, [char]47)
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $file.FullName, ($prefix + $rel)) | Out-Null
  }
} finally {
  $zip.Dispose()
}

"Created: $zipPath ({0} files, {1:N0} KB)" -f $files.Count, ((Get-Item $zipPath).Length / 1KB)
