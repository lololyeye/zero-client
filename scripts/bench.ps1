<#
  ZERO benchmark sampler: measures one Discord client's whole process tree with Windows performance counters.

  Usage (from the repo root, with the client already running and in the state you want to measure):
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\bench.ps1 -Exe ZERO.exe -Seconds 120 -Label zero-idle
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\bench.ps1 -Exe Discord.exe -Seconds 120 -Label stable-idle
  Then: node scripts/bench-report.mjs bench-results

  Every -Interval seconds, summed over every process of that executable:
    ramMb        private working set (Task Manager's "Memory" column)
    cpu          processor time as % of the WHOLE machine (100 = every core busy)
    gpu3d        GPU 3D engine utilization (%)
    videoEncode  GPU video encoder utilization (%): hardware stream encoding (NVENC / AMF / Quick Sync)
    videoDecode  GPU video decoder utilization (%): hardware decoding of streams you watch
    gpuMemMb     dedicated GPU memory in use
  Rates are real deltas between two samples (a fresh counter query per sample returns meaningless values). Nothing about accounts, messages or windows is read.
#>
param(
  [Parameter(Mandatory = $true)][string]$Exe,
  [int]$Seconds = 120,
  [int]$Interval = 2,
  [string]$Label = '',
  [string]$OutDir = 'bench-results'
)
$ErrorActionPreference = 'Stop'
$name = [IO.Path]::GetFileNameWithoutExtension($Exe)
if (-not $Label) { $Label = $name }
if (-not (Get-Process -Name $name -ErrorAction SilentlyContinue)) { throw "$Exe is not running" }
$cores = [Environment]::ProcessorCount
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$out = Join-Path $OutDir ("{0}-{1:yyyyMMdd-HHmmss}.csv" -f $Label, (Get-Date))
"t,procs,ramMb,cpu,gpu3d,videoEncode,videoDecode,gpuMemMb" | Out-File -Encoding ascii $out

# GPU counters are not localized and need one continuous session (rates are deltas between samples).
# CPU (processor-time deltas) and RAM (raw private working set) come from locale-independent sources.
$paths = @('\GPU Engine(*)\Utilization Percentage', '\GPU Process Memory(*)\Dedicated Usage')
$n = [Math]::Max(2, [int][Math]::Ceiling($Seconds / $Interval))
Write-Host "Sampling $Exe for $Seconds s ($n samples) -> $out"
$prevProcs = @(Get-Process -Name $name -ErrorAction SilentlyContinue)
$prevCpu = @{}; foreach ($p in $prevProcs) { try { $prevCpu[$p.Id] = $p.TotalProcessorTime.TotalMilliseconds } catch { } }
$prevT = [Diagnostics.Stopwatch]::StartNew(); $t = 0
Get-Counter -Counter $paths -SampleInterval $Interval -MaxSamples $n -ErrorAction SilentlyContinue | ForEach-Object {
  $procs = @(Get-Process -Name $name -ErrorAction SilentlyContinue)
  $elapsed = $prevT.Elapsed.TotalMilliseconds; $prevT.Restart()
  $set = @{}; $cpuMs = 0.0; $nowCpu = @{}
  foreach ($p in $procs) {
    $set[$p.Id] = $true
    try { $c = $p.TotalProcessorTime.TotalMilliseconds; $nowCpu[$p.Id] = $c; if ($prevCpu.ContainsKey($p.Id)) { $cpuMs += $c - $prevCpu[$p.Id] } } catch { }
  }
  $prevCpu = $nowCpu
  $ram = 0.0
  foreach ($r in (Get-CimInstance Win32_PerfRawData_PerfProc_Process -Filter ("Name LIKE '{0}%'" -f $name))) { if ($set[[int]$r.IDProcess]) { $ram += $r.WorkingSetPrivate } }
  $g3 = 0.0; $enc = 0.0; $dec = 0.0; $gm = 0.0
  foreach ($s in $_.CounterSamples) {
    if ($s.InstanceName -notmatch '^pid_(\d+)_') { continue }
    if (-not $set[[int]$Matches[1]]) { continue }
    if ($s.Path -like '*dedicated usage') { $gm += $s.CookedValue }
    elseif ($s.InstanceName -like '*engtype_3d') { $g3 += $s.CookedValue }
    elseif ($s.InstanceName -like '*engtype_videoencode*') { $enc += $s.CookedValue }
    elseif ($s.InstanceName -like '*engtype_videodecode*') { $dec += $s.CookedValue }
  }
  $t += $Interval
  if ($set.Count -gt 0 -and $elapsed -gt 0) {
    $cpu = 100.0 * $cpuMs / ($elapsed * $cores)
    # invariant culture: a French/German Windows would otherwise write "382,7" and break the CSV
    [string]::Format([Globalization.CultureInfo]::InvariantCulture, '{0},{1},{2:F1},{3:F2},{4:F2},{5:F2},{6:F2},{7:F1}', $t, $set.Count, ($ram / 1MB), $cpu, $g3, $enc, $dec, ($gm / 1MB)) | Out-File -Append -Encoding ascii $out
  }
}
Write-Host "Done: $out"
