"""Summarize the completed encoding comparison and cold-file serving experiment."""
import json
from pathlib import Path
from importlib.util import spec_from_file_location,module_from_spec
root=Path('/tmp/it-perf/followup-evidence');spec=spec_from_file_location('summary',root/'benchmark/summarize-followup.py');m=module_from_spec(spec);spec.loader.exec_module(m)
r=json.loads((root/'results/encoding.json').read_text())['rows'];expected=[(i,e) for i in range(6) for e in (['identity','gzip'] if i%2 else ['gzip','identity'])];assert [(x['round'],x['encoding']) for x in r]==expected
out={'encoding':{},'siteCost':{}}
for encoding in ['gzip','identity']:
 a=[x for x in r if x['encoding']==encoding];values={}
 for k in ['loadMs','gridInteractiveMs','openMs']:values[k]=m.summary([x['metrics'][k] for x in a])
 for k in ['domClickToStateMs','clickCallMs','preClickMs','postReadyMs']:values[k]=m.summary([x['metrics']['diagnostic'][k] for x in a])
 failed=sum(not e['success'] for x in a for e in x['metrics']['diagnostic']['events']);assert failed==0
 values['failedBackendCalls']=failed;values['oneMinuteLoad']=m.span([h['load'][0] for x in a for h in x['host']]);out['encoding'][encoding]=values
r=json.loads((root/'results/site-cost.json').read_text())['rows']
for kind in ['baselineIdentity','candidateGzip','candidateIdentity']:
 a=[x for x in r if x['kind']==kind and not x['warmup']];assert len(a)==50
 out['siteCost'][kind]={key:m.summary([x[key] for x in a]) for key in ['wallMs','cpuMs']}
(root/'diagnostic-summary.json').write_text(json.dumps(out,indent=2)+'\n')
