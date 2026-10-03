# OceanAlt x402 trust-provider adapter (experimental)

> **Experimental reference adapter.** It targets the trust-provider extension *proposed* in [x402 PR #2300](https://github.com/x402-foundation/x402/pull/2300). That extension is not merged or standardized, and its wire types may change. This is not an official x402 integration.

It implements the draft `TrustProviderConfig` (`{ name, evaluate }`) from the PR's `types.ts` at head `9e38112`. `evaluate()` screens the payer's wallet with OceanAlt's public decision API and returns a draft `TrustEvaluation`.

## What it returns

| field | value |
|---|---|
| `schema` | `x402-trust-evaluation-v0.1` |
| `provider` / `provider_url` | `oceanalt` / `https://oceanalt.com` |
| `decision` | `PASS` / `FAIL` / `UNCERTAIN` |
| `score` | `0..1` when the API returns a risk value; omitted otherwise |
| `reason_code` | the API's `reason_code` (e.g. `clear`, `sanctioned_or_high_risk_payee`) |
| `evidence_uri` | a signed evidence bundle for the screened address (Ed25519, verifiable offline) |
| `ttl_seconds` | `3600` |
| `evaluated_at` | when the evaluation ran |

It also returns an `evidence[]` array. This is **not** in the PR's current types. It follows the shape discussed in the thread: one item per list, each with `evidenceType`, `source`, and an `anchor` that says when that list was read (`as_of`). The field names will follow whatever the schema refresh settles on.

```json
{ "evidenceType": "list_membership", "source": "government-sanctions-lists", "anchor": { "as_of": "2026-10-01" }, "status": "not_listed" }
```

## Decision mapping (fail-closed)

| OceanAlt decision | `decision` |
|---|---|
| `decline` | `FAIL` |
| `review` | `UNCERTAIN` |
| `allow` | `PASS` |
| no wallet in the query, HTTP error, timeout, unreadable response | `UNCERTAIN`, never `PASS` |

`PASS` means OceanAlt found no reason to block. It does not mean the wallet is safe. This is risk screening, not an AML compliance certification.

## Run

```bash
node oceanalt-trust-provider.mjs
```

This calls the live API and prints four cases: a clean wallet, a mixer contract, an unreachable upstream, and a query with no wallet.

## Use

```js
import { oceanaltTrustProvider } from "./oceanalt-trust-provider.mjs";

const provider = oceanaltTrustProvider();           // screens query.payer.wallet
// providers: [provider, ...] in the draft TrustProviderExtensionConfig

// screen something other than payer.wallet:
const payeeProvider = oceanaltTrustProvider({ pickWallet: (q) => q.resource?.payTo ?? null });
```

No API key is needed. Anonymous calls are rate limited and metered; see https://oceanalt.com/en/api-keys.

## Versions

- `v0.3` (2026-10-02): aligned to the PR's current types (`payer.wallet`, `x402-trust-evaluation-v0.1`), decision API instead of raw screening, per-list `evidence[]`.
- `v0.2` (2026-09): aligned with the #2299 discussion at the time, kept at tag `v0.2`.
- `v0.1` (2026-08-17): first draft, kept at tag `v0.1`.

MIT © OceanAlt
