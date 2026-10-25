# Isolate backend-functions packing

These diagnostic scripts transform only the deployment literal in the immutable baseline Node bundle. They create eager and lazy gzip variants, check the uncompressed text roundtrip, and report its SHA-256. They do not edit product source or contact a service.

With Node 24 selected and the baseline at `/tmp/it-perf/baseline/it.mjs`, run `node functions-variants.mjs`, then `node compare-functions.mjs` from this directory. The output is `/tmp/it-perf/cli-audit/functions-comparison.json`. The runner rotates baseline, eager and lazy variants for three warmups and ten retained rounds per command. `resource.cjs` records child user plus system CPU time and maximum RSS through a private pipe. The offline `displays` command uses an unconfigured isolated home.

The recorded experiment ran before the complete service comparison. It had no host-load sampler. Its wall times should not be treated as a stable speedup. The published results retain every CPU, wall-time and RSS sample; only local path labels were normalized.
