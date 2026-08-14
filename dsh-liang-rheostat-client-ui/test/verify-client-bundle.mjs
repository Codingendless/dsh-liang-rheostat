import { readFileSync } from "node:fs";
import vm from "node:vm";
import { zstdDecompressSync } from "node:zlib";

// 1) 加载服务端引擎与兜底价目表(真值)
const serverEngine = await import("../../dsh-liang-rheostat-server/lib/engine.js");
const serverPrices = await import("../../dsh-liang-rheostat-server/lib/prices.js");

// 2) 在 VM 里执行客户端 bundle,捕获 exports
let captured = null;
const sandbox = {
  window: {
    __ModuleLoader__: {
      load({ id, factory }) {
        const fakeRequire = (spec) => {
          if (spec === "react") return { useSyncExternalStore: () => {} };
          if (spec === "react/jsx-runtime") return { jsx: () => {}, jsxs: () => {}, Fragment: {} };
          throw new Error("unexpected require: " + spec);
        };
        const result = factory(fakeRequire);
        captured = { id, exports: result };
      }
    }
  },
  console,
  Symbol,
  Object,
  Math,
  RegExp,
  String,
  Number,
  Map,
  Set,
  Infinity,
  JSON,
  Error,
  Array,
  Date,
  fetch: async () => ({ ok: false, json: async () => null })
};
vm.createContext(sandbox);
const code = readFileSync("./lib/client.js", "utf8");
vm.runInContext(code, sandbox);
console.log("bundle id:", captured.id);
console.log("exports keys:", Object.keys(captured.exports));
console.log("apply type:", typeof captured.exports.apply, "| inject:", JSON.stringify(captured.exports.inject));

// 3) 引擎对拍:关键公式逐字比对(峰谷分段 + auto reference + 货币 + 费用压力口径)
const markers = {
  segment: code.includes("segments.filter((s) => s.effectiveAt <= time).at(-1)"),
  peak: code.includes('(hour >= 1 && hour < 4) || (hour >= 6 && hour < 10)'),
  autoRef: code.includes('options.referenceCostPerKOutput === "auto"'),
  cacheWrite: code.includes("write * resolved.inputPerM"),
  pressure: code.includes("(input * resolved.inputPerM + output * resolved.outputPerM) / 1e6"),
  money: code.includes('symbol = currency === "CNY" ? "¥" : "$"'),
  pricesFetch: code.includes('fetch("/liang-prices.json"')
};
console.log("engine parity markers:", JSON.stringify(markers));
const allMarkers = Object.values(markers).every(Boolean);
console.log(allMarkers ? "PARITY OK" : "PARITY MISMATCH");

// 4) 真实数据对拍:解压会话,对每个目标 assistant/message 用服务端引擎(兜底价+事件时间)
//    算出评级,确认全部可评级、无异常。
const ZSTD_MAGIC = 4247762216;
function scan(buf) {
  const frames = [];
  let o = 0;
  while (o < buf.length) {
    const s = o;
    if (buf.length - o < 4) break;
    if (buf.readUInt32LE(o) !== ZSTD_MAGIC) throw new Error("magic");
    o += 4;
    if (o === buf.length) break;
    const d = buf.readUInt8(o);
    o += 1;
    const csf = d >>> 6;
    const ss = (d & 32) !== 0;
    const ck = (d & 4) !== 0;
    const df = d & 3;
    const db = df === 3 ? 4 : df;
    const csb = csf === 0 ? (ss ? 1 : 0) : 1 << csf;
    const rhb = (ss ? 0 : 1) + db + csb;
    if (buf.length - o < rhb) break;
    o += rhb;
    for (;;) {
      if (buf.length - o < 3) return frames;
      const bh = buf.readUIntLE(o, 3);
      o += 3;
      const last = (bh & 1) !== 0;
      const bt = (bh >>> 1) & 3;
      const bs = bh >>> 3;
      if (bt === 3) throw new Error("bt");
      const pb = bt === 1 ? 1 : bs;
      if (buf.length - o < pb) return frames;
      o += pb;
      if (last) break;
    }
    if (ck) {
      if (buf.length - o < 4) break;
      o += 4;
    }
    frames.push({ s, e: o });
  }
  return frames;
}
const file = process.argv[2];
const buf = readFileSync(file);
const frames = scan(buf);
let text = "";
for (const f of frames) text += zstdDecompressSync(buf.subarray(f.s, f.e)).toString("utf8");
const opts = { baseMaxTokens: 131072, referenceCostPerKOutput: "auto", expensiveThreshold: 0.035, tinyOutputTokens: 200, tinyCostCap: 0.007, wasteOutputTokens: 400, tiers: { liangzu: 85, liangshen: 70, liangsheng: 55, liangzi: 35, laoliang: 18 } };
const defaultPrice = { inputPerM: 1, cacheReadPerM: 0.02, outputPerM: 2, currency: "CNY" };
let rated = 0;
let peak = 0;
let off = 0;
for (const l of text.split("\n").filter((x) => x.trim())) {
  let ev;
  try { ev = JSON.parse(l); } catch { continue; }
  if (ev.type !== "assistant/message") continue;
  const data = ev.data ?? {};
  const usage = data.usage;
  if (usage === void 0) continue;
  const source = data.message?.source ?? {};
  if (!(source.provider === "deepseek-official" && source.model?.startsWith("deepseek-"))) continue;
  const time = typeof ev.time === "number" ? ev.time : Date.now();
  const entry = serverEngine.resolvePrice(source.model, serverPrices.FALLBACK_PRICES, defaultPrice);
  const m = serverEngine.scoreCall(usage, entry, opts, time);
  const r = serverEngine.rankOf(m, opts);
  if (serverEngine.isPeakHour(time)) peak++; else off++;
  rated++;
}
console.log(`real-data engine run: rated=${rated} (peak=${peak}, off-peak=${off})`);
console.log(allMarkers && rated > 0 ? "SMOKE TEST PASSED" : "SMOKE TEST FAILED");
