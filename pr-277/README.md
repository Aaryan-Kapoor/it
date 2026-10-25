# It performance evidence

This compares baseline `71b888ac` with `ced91a21`. `manifest.json` identifies immutable bundles, the backend executable, and the host. `summary.json` contains recalculated medians, quartiles, minima, maxima, host-load statistics, and server timing match counts. `results/` retains numeric samples and profile summaries.

The [benchmark README](benchmark/README.md) describes the real-service comparison, fresh-home starts, browser work, backend calls, and connector delivery. The [functions-only audit](benchmark/audit/README.md) reproduces the diagnostic CPU experiment. Benchmark source remains outside the product tree.

`performance.png` and `chart.html` show the deterministic byte reductions and emulated-network gains. The pull request includes every measured path, including slower candidate local-browser and warm-start medians. Wall times on this heavily shared machine do not establish improvements on all paths. No samples from the completed comparisons were discarded.

The original partial comparison ended when the shared disk filled and is excluded in full. Raw service records, browser pairing state, logs, binaries, and raw profiles are not published. CPU profile summaries omit local paths; they are diagnostic samples, not precise causal accounting.
