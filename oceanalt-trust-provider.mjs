// OceanAlt × x402 Trust-Provider — 参考适配器 (Draft v0.1)
// 把 OceanAlt 的合规风险筛查(/api/risk)接进 x402 的 trust-provider 扩展
// (issue #2299 / PR #2300 的 onBeforeSettle 钩子)。定位:regulatory(监管/合规)类信任提供方,
// 与 behavioral(行为)类互补——一笔支付可能行为过关但合规不过关,反之亦然。
//
// 诚实边界(不过度承诺):这是「compliance risk screening(合规风险筛查)」信号——
// 命中制裁/混币器/诈骗名单、发行方(USDT/USDC)冻结、链上启发式风险,并给可核验证据。
// 它不是「完整 AML 合规认证」;PASS 表示"本提供方未发现拦截理由",不等于"绝对安全"。
//
// 跑法(实打 oceanalt.com 生产接口,非 PPT):node oceanalt-trust-provider.mjs
// 接法:const provider = oceanAltTrustProvider(); registerTrustProvider(provider) …(见 README)

const DEFAULT_BASE = "https://oceanalt.com";

/**
 * @typedef {"PASS"|"FAIL"|"UNCERTAIN"} TrustDecision  // #2300:fail-closed
 * @typedef {"behavioral"|"regulatory"|"self-attested"|"third-party"|"cryptographic"|"observational"|"delivery"} EvidenceType
 *
 * @typedef {Object} TrustQuery                          // #2300 输入(节选)
 * @property {string} [schema]
 * @property {{ agent_id?: string, address?: string }} [payer]   // agent_id 为 DID;address=付款来源地址(若可得)
 * @property {{ url?: string, method?: string, amount?: string|number, payTo?: string, network?: string }} [resource]
 * @property {{ category?: string, risk_band?: string }} [context]
 * @property {string} [requested_at]
 *
 * @typedef {Object} TrustEvaluation                     // #2300 输出
 * @property {string} schema
 * @property {string} provider
 * @property {string} provider_url
 * @property {TrustDecision} decision
 * @property {number} score                               // 0..1,1=最可信(= 1 - risk/100)
 * @property {EvidenceType} evidenceType
 * @property {string} reason_code
 * @property {string} evidence_uri                        // 可点开自核的证据 URL(/api/risk 原始返回)
 * @property {number} ttl_seconds
 * @property {string} evaluated_at
 * @property {Object} [subject]                           // 被评估对象(此处=被筛查地址)
 */

const SCHEMA = "x402-trust-provider/0.1";

// 默认地址提取:从 TrustQuery 里找出「要做合规筛查的地址」。
// 合规筛查看的是【资金对手方/来源地址】(收到/付出的是不是黑钱),不是 agent 的行为——
// 与 behavioral 提供方看 payer.agent_id 的行为分不同。实际字段以最终 wire type 为准,这里可配置覆盖。
function defaultExtractAddress(query) {
  return (
    query?.payer?.address ||
    query?.subject?.address ||
    query?.resource?.payTo ||
    query?.resource?.address ||
    null
  );
}

// verdict → TrustDecision(fail-closed:拿不到结论一律 UNCERTAIN,绝不静默 PASS)
function mapDecision(verdict) {
  if (verdict === "risky") return "FAIL";
  if (verdict === "clear") return "PASS";
  return "UNCERTAIN"; // caution / 未知 / 错误
}

function reasonCode(r) {
  const s = (r?.signals || []).join(" ");
  if (/制裁|sanction|OFAC/i.test(s)) return "SANCTIONS_MATCH";
  if (/混币|mixer|Tornado/i.test(s)) return "MIXER_TAINT";
  if (/冻结|frozen|blacklist/i.test(s)) return "ISSUER_FROZEN";
  if (/沾染|taint/i.test(s)) return "ONCHAIN_TAINT";
  if (r?.verdict === "risky") return "ONCHAIN_HIGH_RISK";
  if (r?.verdict === "caution") return "RISK_SIGNALS_PRESENT";
  if (r?.verdict === "clear") return "NO_RISK_SIGNAL"; // 注意:未见信号 ≠ 绝对安全
  return "SCREENING_UNAVAILABLE";
}

/**
 * 直接对一个地址做评估并返回符合 #2300 的 TrustEvaluation。fail-closed。
 * @param {string} address
 * @param {{ baseUrl?: string, network?: string, ttlSeconds?: number, timeoutMs?: number }} [opts]
 * @returns {Promise<TrustEvaluation>}
 */
export async function evaluateAddress(address, opts = {}) {
  const baseUrl = (opts.baseUrl || DEFAULT_BASE).replace(/\/$/, "");
  const network = opts.network || "";
  const ttl = opts.ttlSeconds ?? 3600; // 保守 1h(制裁名单可能更新);比 12h 缓存更短
  const now = new Date().toISOString();
  const q = new URLSearchParams({ addr: String(address || "") });
  if (network) q.set("network", network);
  const evidence_uri = `${baseUrl}/api/risk?${q.toString()}`;

  const base = {
    schema: SCHEMA, provider: "OceanAlt", provider_url: baseUrl,
    evidenceType: /** @type {EvidenceType} */ ("regulatory"),
    evidence_uri, ttl_seconds: ttl, evaluated_at: now,
    subject: { address, network: network || "auto" },
  };
  if (!address) return { ...base, decision: "UNCERTAIN", score: 0, reason_code: "NO_ADDRESS" };

  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 12000);
    const res = await fetch(evidence_uri, { signal: ctrl.signal, headers: { accept: "application/json" } }).finally(() => clearTimeout(t));
    if (!res.ok) return { ...base, decision: "UNCERTAIN", score: 0, reason_code: "SCREENING_UNAVAILABLE" };
    const r = await res.json();
    const risk = Number.isFinite(r.risk) ? r.risk : 50;
    return {
      ...base,
      decision: mapDecision(r.verdict),
      score: +(1 - Math.min(100, Math.max(0, risk)) / 100).toFixed(2),
      reason_code: reasonCode(r),
      subject: { address, network: network || "auto", verdict: r.verdict, risk: r.risk, evidence: r.evidence },
    };
  } catch {
    // fail-closed:抓取失败 → UNCERTAIN,绝不当作 PASS 放行
    return { ...base, decision: "UNCERTAIN", score: 0, reason_code: "SCREENING_UNAVAILABLE" };
  }
}

/**
 * 构造一个符合 #2300 TrustProviderConfig 的合规信任提供方:{ name, evaluate(query) }。
 * @param {{ baseUrl?: string, network?: string, extractAddress?: (q: TrustQuery)=>(string|null) }} [opts]
 */
export function oceanAltTrustProvider(opts = {}) {
  const extract = opts.extractAddress || defaultExtractAddress;
  return {
    name: "oceanalt-compliance",
    /** @param {TrustQuery} query @returns {Promise<TrustEvaluation>} */
    evaluate: (query) => evaluateAddress(extract(query), { baseUrl: opts.baseUrl, network: opts.network || query?.resource?.network }),
  };
}

export default oceanAltTrustProvider;

// ── 可跑 demo(实打 oceanalt.com /api/risk)────────────────────────────────
// node oceanalt-trust-provider.mjs  → 打印三个真实用例的 TrustEvaluation。
const isMain = (() => { try { return import.meta.url === `file://${process.argv[1]}` || import.meta.url.endsWith(process.argv[1]?.replace(/\\/g, "/")); } catch { return false; } })();
if (isMain) {
  const CASES = [
    { label: "PASS · 干净活跃地址", addr: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", network: "ethereum" },
    { label: "FAIL · 制裁/混币器(Tornado Cash)", addr: "0x8589427373d6d84e98730d7795d8f6f8731fda16", network: "ethereum" },
    { label: "UNCERTAIN · 筛查不可用(fail-closed 演示,故意打不通的 base)", addr: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", network: "ethereum", baseUrl: "https://oceanalt.invalid" },
  ];
  console.log("OceanAlt × x402 Trust-Provider 参考适配器 — 实打生产接口 demo\n");
  for (const c of CASES) {
    const ev = await evaluateAddress(c.addr, { network: c.network, baseUrl: c.baseUrl });
    console.log(`【${c.label}】`);
    console.log(`  decision=${ev.decision}  score=${ev.score}  evidenceType=${ev.evidenceType}  reason=${ev.reason_code}`);
    console.log(`  evidence_uri=${ev.evidence_uri}`);
    if (ev.subject?.verdict) console.log(`  (OceanAlt verdict=${ev.subject.verdict} risk=${ev.subject.risk})`);
    console.log("");
  }
  console.log("要点:regulatory 类 FAIL 在 aggregateByEvidenceType 下应【中止结算】;筛查不可用→UNCERTAIN(绝不静默 PASS)。");
  console.log("这不是 PPT,是能跑的代码——每个 decision 都可用 evidence_uri 点开自核。");
}
