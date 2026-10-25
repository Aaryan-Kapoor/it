"""Paired diagnostics; one block per variant and round, never pooled across rounds."""
import json,random,statistics
from pathlib import Path
from importlib.util import spec_from_file_location,module_from_spec
root=Path('/tmp/it-perf/followup-evidence')
spec=spec_from_file_location('summary',root/'benchmark/summarize-followup.py');m=module_from_spec(spec);spec.loader.exec_module(m)
rows=json.loads((root/'results/followup.json').read_text())['rows']
assert len(rows)==24
out={}
for key in ['startMs','local.loadMs','local.gridInteractiveMs','local.openMs','local.diagnostic.domClickToStateMs']:
 def value(row):
  v=row
  for p in key.split('.'):v=v[p]
  return v
 pairs=[]
 for i in range(12):
  by={r['label']:r for r in rows if r['round']==i};pairs.append(value(by['candidate'])-value(by['baseline']))
 rng=random.Random(277)
 boots=sorted(statistics.median(rng.choices(pairs,k=12)) for _ in range(10000))
 out[key]={'candidateMinusBaselineMs':pairs,'pairedDelta':m.summary(pairs),'candidateFasterPairs':sum(x<0 for x in pairs),'percentileBootstrapMedian95':[m.quantile(boots,.025),m.quantile(boots,.975)],'bootstrapReplicates':10000,'seed':277}
(root/'paired.json').write_text(json.dumps(out,indent=2)+'\n')
