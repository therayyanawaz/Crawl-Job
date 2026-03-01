# Benchmark Profiles

Deterministic benchmark inputs live under `testdata/benchmark/`:

- `small.json`
- `medium.json`
- `large.json`

Run benchmarks locally (no network calls):

```bash
npm run benchmark:small
npm run benchmark:medium
npm run benchmark:large
```

Each run emits KPI output JSON to:

- `storage/benchmarks/kpi-<profile>.json`

Reported KPIs:

- jobs/min
- dedup ratio (%)
- p95 latency (ms)
- proxy pass rate (%)
- 429 rate (%)
