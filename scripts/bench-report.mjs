// Summarizes scripts/bench.ps1 CSV files: node scripts/bench-report.mjs [dir]
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2] ?? 'bench-results';
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.csv')).sort();
const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0; };
const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
/** least-squares slope, MB per minute */
function growth(ts, ys) {
  if (ys.length < 5) return 0;
  const mx = avg(ts), my = avg(ys);
  let n = 0, d = 0;
  ts.forEach((t, i) => { n += (t - mx) * (ys[i] - my); d += (t - mx) ** 2; });
  return d ? (n / d) * 60 : 0;
}
const rows = [];
for (const f of files) {
  const lines = fs.readFileSync(path.join(dir, f), 'utf8').trim().split(/\r?\n/).slice(1).map((l) => l.split(',').map(Number));
  const valid = lines.filter((l) => l[1] > 0);
  if (!valid.length) continue;
  const col = (i) => valid.map((l) => l[i]);
  // the first two samples include the counters' warm-up; skip them when there is enough data
  const body = valid.length > 6 ? valid.slice(2) : valid;
  const c = (i) => body.map((l) => l[i]);
  rows.push({
    run: f.replace(/\.csv$/, ''), samples: body.length, procs: Math.round(avg(c(1))),
    'RAM avg MB': avg(c(2)).toFixed(0), 'RAM peak MB': Math.max(...col(2)).toFixed(0), 'RAM growth MB/min': growth(c(0), c(2)).toFixed(2),
    'CPU avg %': avg(c(3)).toFixed(2), 'CPU p95 %': pct(c(3), 95).toFixed(2),
    'GPU 3D avg %': avg(c(4)).toFixed(2), 'Enc avg %': avg(c(5)).toFixed(2), 'Dec avg %': avg(c(6)).toFixed(2),
    'GPU mem avg MB': avg(c(7)).toFixed(0),
  });
}
console.table(rows);
