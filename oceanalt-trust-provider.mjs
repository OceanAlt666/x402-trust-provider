// OceanAlt x402 trust-provider adapter v0.3 (experimental)
// Targets the draft TrustProviderConfig / TrustEvaluation types proposed in x402 PR #2300 (head 9e38112).
// The extension is not merged; field names may change. See README.md.
//
// PASS means no reason to block was found, not that the wallet is safe.
// Anything unreadable becomes UNCERTAIN, never PASS.
//
// Run: node oceanalt-trust-provider.mjs

const DEFAULT_BASE = "https://oceanalt.com";
const SCHEMA = "x402-trust-evaluation-v0.1";
export const VERSION = "0.3.0";

/** @typedef {"PASS"|"FAIL"|"UNCERTAIN"} TrustDecision */

// evidence_as_of keys from /api/decide -> evidence source. The "ofac" key covers every government
// sanctions or seizure list the API checks, not only OFAC SDN, so it maps to a generic source.
const SOURCE_OF = {
  ofac: "government-sanctions-lists",
  mixer: "oceanalt-risk-list:mixer",
  phish: "oceanalt-risk-list:phishing",
  "phish-domain": "oceanalt-risk-list:phishing-domain",
  ransomware: "oceanalt-risk-list:ransomware",
  hack: "oceanalt-risk-list:exploit",
  scam: "oceanalt-risk-list:scam",
};

// OceanAlt decision -> draft TrustDecision (fail-closed)
const DECISION = { decline: "FAIL", review: "UNCERTAIN", allow: "PASS" };

/** One evidence item per list; the anchor is the date that list was read (as_of), plus a publisher digest when available. */
function toEvidence(r) {
  const asOf = r?.evidence_as_of && typeof r.evidence_as_of === "object" ? r.evidence_as_of : {};
  const hitKinds = new Set((r?.signal_keys || []).filter((k) => k.startsWith("list.")).map((k) => k.slice(5)));
  const lists = Object.entries(asOf).map(([kind, date]) => ({
    evidenceType: "list_membership",
    source: SOURCE_OF[kind] || `oceanalt-risk-list:${kind}`,
    anchor: { as_of: date, ...(r?.list_digests?.[kind] ? { digest: r.list_digests[kind] } : {}) },
    status: hitKinds.has(kind) ? "listed" : "not_listed",
  }));
  return lists;
}

function uncertain(base, reason_code) {
  return { ...base, decision: "UNCERTAIN", reason_code, evidence: [] };
}

/**
 * Screen one wallet and return a draft TrustEvaluation plus evidence[]. Fail-closed.
 * @param {string|null|undefined} address
 * @param {{ baseUrl?: string, network?: string, ttlSeconds?: number, timeoutMs?: number }} [opts]
 */
export async function evaluateWallet(address, opts = {}) {
  const baseUrl = (opts.baseUrl || DEFAULT_BASE).replace(/\/$/, "");
  const evaluated_at = new Date().toISOString();
  const base = {
    schema: SCHEMA,
    provider: "oceanalt",
    provider_url: baseUrl,
    ttl_seconds: opts.ttlSeconds ?? 3600,
    evaluated_at,
  };
  if (!address) return uncertain(base, "no_wallet_in_query");

  const q = new URLSearchParams({ to: String(address) });
  if (opts.network) q.set("network", opts.network);
  try {
    const res = await fetch(`${baseUrl}/api/decide?${q}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 12000),
    });
    if (!res.ok) return uncertain(base, `screening_unavailable_http_${res.status}`);
    const r = await res.json();
    const decision = DECISION[r?.decision];
    if (!decision) return uncertain(base, "screening_unreadable");
    return {
      ...base,
      decision,
      ...(Number.isFinite(r.risk) ? { score: +(1 - Math.min(100, Math.max(0, r.risk)) / 100).toFixed(2) } : {}),
      reason_code: r.reason_code || "unspecified",
      // Ed25519-signed evidence bundle for this address, verifiable offline
      evidence_uri: `${baseUrl}/api/evidence/bundle?address=${encodeURIComponent(address)}`,
      evidence: toEvidence(r),
      screened_network: r.screened_network || opts.network || null,
    };
  } catch {
    return uncertain(base, "screening_request_failed");
  }
}

/**
 * Draft TrustProviderConfig. Screens query.payer.wallet by default.
 * @param {{ baseUrl?: string, network?: string, pickWallet?: (q:any)=>string|null }} [opts]
 */
export function oceanaltTrustProvider(opts = {}) {
  const pick = opts.pickWallet || ((q) => q?.payer?.wallet || null);
  return {
    name: "oceanalt",
    evaluate: (query) => evaluateWallet(pick(query), {
      baseUrl: opts.baseUrl,
      // the API infers the chain from the address format unless a network is given
      network: opts.network,
    }),
  };
}

export default oceanaltTrustProvider;

// demo: node oceanalt-trust-provider.mjs
const isMain = (() => { try { return import.meta.url.endsWith(process.argv[1]?.replace(/\\/g, "/")); } catch { return false; } })();
if (isMain) {
  const provider = oceanaltTrustProvider({ network: "ethereum" });
  const query = (wallet) => ({
    schema: "x402-trust-query-v0.1",
    payer: { wallet },
    resource: { url: "https://example.com/paid", amount: { value: "0.85", currency: "USDC", chain: "eip155:1" } },
    requested_at: new Date().toISOString(),
  });
  const cases = [
    ["clean active wallet", provider, "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"],
    ["mixer contract", provider, "0x8589427373d6d84e98730d7795d8f6f8731fda16"],
    ["upstream unreachable (fail-closed)", oceanaltTrustProvider({ baseUrl: "https://oceanalt.invalid" }), "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"],
    ["no wallet in query", provider, null],
  ];
  for (const [label, p, w] of cases) {
    const ev = await p.evaluate(query(w));
    console.log(`\n# ${label}\n` + JSON.stringify(ev, null, 2));
  }
}
