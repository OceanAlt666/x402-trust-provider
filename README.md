# OceanAlt × x402 Trust-Provider (reference adapter, Draft v0.1)

A **regulatory / compliance-risk-screening** trust provider for the x402 trust-provider extension proposed in [#2299](https://github.com/x402-foundation/x402/issues/2299) / [#2300](https://github.com/x402-foundation/x402/pull/2300). It conforms to the `TrustEvaluation` output shape and plugs into the `onBeforeSettle` hook.

**It is complementary to behavioral scoring, not a competitor.** Behavioral trust answers *"has this agent misbehaved?"*; this provider answers *"is this counterparty sanctioned / mixer-tainted / issuer-frozen / on-chain risky?"* — a payment can pass one and fail the other. Declared as `evidenceType: "regulatory"`, so under `aggregateByEvidenceType` a **FAIL aborts settlement** while behavioral FAILs stay informational.

> **Honest scope.** This is *compliance risk screening* — a signal (sanctions/mixer/scam lists, USDT/USDC issuer freeze, on-chain heuristics) with click-through evidence. It is **not** full AML-compliance certification. `PASS` means "this provider found no reason to block," **not** "absolutely safe."

## Conformance to #2300

Returns a `TrustEvaluation`:

| field | value |
|-------|-------|
| `schema` | `x402-trust-provider/0.1` |
| `provider` / `provider_url` | `OceanAlt` / `https://oceanalt.com` |
| `decision` | `PASS \| FAIL \| UNCERTAIN` (**fail-closed**) |
| `evidenceType` | `regulatory` |
| `score` | `0..1`, 1 = most trusted (`1 − risk/100`) |
| `reason_code` | `SANCTIONS_MATCH` / `MIXER_TAINT` / `ISSUER_FROZEN` / `ONCHAIN_TAINT` / `ONCHAIN_HIGH_RISK` / `RISK_SIGNALS_PRESENT` / `NO_RISK_SIGNAL` / `SCREENING_UNAVAILABLE` |
| `evidence_uri` | the `/api/risk` URL — click through to verify (which list, which on-chain path) |
| `ttl_seconds` | `3600` (conservative — sanctions lists change) |
| `evaluated_at` | ISO timestamp |

### Decision mapping (fail-closed)

| OceanAlt verdict | `decision` |
|---|---|
| `risky` (sanctions / mixer / frozen / high on-chain) | **FAIL** |
| `caution` (risk signals present) | **UNCERTAIN** |
| `clear` (no risk signal) | **PASS** |
| screening error / unreachable / bad input | **UNCERTAIN** (never a silent PASS) |

## Runnable — not a slide deck

```bash
node oceanalt-trust-provider.mjs
```

hits the live `oceanalt.com/api/risk` and prints three real evaluations:

```
【PASS · clean active address】       decision=PASS  score=0.97  reason=NO_RISK_SIGNAL   (verdict=clear risk=3)
【FAIL · Tornado Cash mixer】         decision=FAIL  score=0     reason=MIXER_TAINT       (verdict=risky risk=100)
【UNCERTAIN · screening unavailable】 decision=UNCERTAIN score=0 reason=SCREENING_UNAVAILABLE  (fail-closed)
```

## Use

```js
import { oceanAltTrustProvider } from "./oceanalt-trust-provider.mjs";

// register alongside behavioral providers; the resource server queries all in parallel on onBeforeSettle
const provider = oceanAltTrustProvider({ network: "base" });
// provider = { name: "oceanalt-compliance", evaluate: (query) => Promise<TrustEvaluation> }

// or screen an address directly:
import { evaluateAddress } from "./oceanalt-trust-provider.mjs";
const ev = await evaluateAddress("0x…", { network: "optimism" });
```

`evaluate(query)` extracts the counterparty address to screen from the `TrustQuery` (default tries `payer.address` / `subject.address` / `resource.payTo`; override via `extractAddress`). The exact field depends on the final wire type — happy to align once #2300 lands.

## Interface questions this raises (from the #2299 comment)

1. Should `TrustEvaluation` responses carry a **category/evidenceType** (already in #2300 — 👍) so aggregation can require "≥1 regulatory PASS"?
2. Standardize an **evidence** field (list of `{label, source, url}`) alongside the decision, so settlement decisions are auditable rather than opaque?

Backed by **RAP (Responsible Agentic Payments)**: https://oceanalt.com/en/rap · callable API & docs: https://oceanalt.com/en/api-docs

MIT © OceanAlt
