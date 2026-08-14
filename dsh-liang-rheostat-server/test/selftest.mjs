/**
 * 无依赖自检脚本(不派生子进程,可在受限沙箱内运行)。
 * 运行:node test/selftest.mjs
 * 与 test/engine.test.js(node --test 套件)覆盖同一组断言。
 */
import assert from "node:assert/strict";
import {
	DIAL_DELTAS,
	TIER_LABELS,
	TIER_ORDER,
	callCost,
	cacheRateOf,
	clamp,
	dialMaxTokens,
	formatTokens,
	formatUSD,
	matchesAny,
	matchesTarget,
	nextDial,
	rankOf,
	renderRheostat,
	resolvePrice,
	scoreCall,
	usageTokens,
	wildcardMatch
} from "../lib/engine.js";

const OPTIONS = {
	baseMaxTokens: 131072,
	tinyOutputTokens: 200,
	tinyCostCap: 0.01,
	wasteOutputTokens: 400,
	expensiveThreshold: 0.05,
	referenceCostPerKOutput: 0.02,
	tiers: { liangzu: 85, liangshen: 70, liangsheng: 55, liangzi: 35, laoliang: 18 }
};
const DEFAULT_PRICE = { inputPerM: 0.27, cacheReadPerM: 0.07, cacheWritePerM: 0.27, outputPerM: 1.1 };
const usage = ({ input = 1000, read = 0, write = 0, output = 500 } = {}) => ({ inputTokens: input, cacheReadTokens: read, cacheWriteTokens: write, outputTokens: output });

let passed = 0;
const check = (label, fn) => {
	fn();
	passed += 1;
	console.log(`  ok  ${label}`);
};

console.log("dsh-liang-rheostat 引擎自检");

check("clamp 夹紧", () => {
	assert.equal(clamp(1.5, 0, 1), 1);
	assert.equal(clamp(-1, 0, 1), 0);
	assert.equal(clamp(0.5, 0, 1), 0.5);
});

check("通配符 deepseek-*", () => {
	assert.equal(wildcardMatch("deepseek-*", "deepseek-v4-flash"), true);
	assert.equal(wildcardMatch("deepseek-*", "deepseek-reasoner"), true);
	assert.equal(wildcardMatch("deepseek-*", "deepseek"), false);
	assert.equal(wildcardMatch("deepseek-*", "gpt-4o"), false);
	assert.equal(wildcardMatch("*", "anything"), true);
	assert.equal(wildcardMatch("deepseek-v4-?", "deepseek-v4-f"), true);
});

check("matchesAny / matchesTarget", () => {
	assert.equal(matchesAny(["deepseek-*", "glm-*"], "deepseek-chat"), true);
	assert.equal(matchesAny(["deepseek-*"], "gpt-4o"), false);
	assert.equal(matchesTarget({ provider: "deepseek-official", model: "deepseek-v4-flash" }, ["deepseek-official"], ["deepseek-*"]), true);
	assert.equal(matchesTarget({ provider: "opencode-go", model: "deepseek-v4-flash" }, ["deepseek-official"], ["deepseek-*"]), false);
	assert.equal(matchesTarget({ provider: "deepseek-official", model: "gpt-4o" }, ["deepseek-official"], ["deepseek-*"]), false);
});

check("缓存率与 token 汇总", () => {
	assert.equal(cacheRateOf(usage({ input: 1000, read: 9000 })), 0.9);
	assert.equal(cacheRateOf(usage({ input: 100, read: 0 })), 0);
	assert.equal(cacheRateOf(usage({ input: 0, read: 0, write: 0 })), 0);
	assert.equal(usageTokens(usage({ input: 100, read: 50, write: 25, output: 10 })), 185);
});

check("费用折算", () => {
	const cost = callCost(usage({ input: 1000, read: 1000, output: 500 }), DEFAULT_PRICE);
	assert.ok(Math.abs(cost - (1000 * 0.27 + 1000 * 0.07 + 500 * 1.1) / 1e6) < 1e-12);
});

check("resolvePrice 精确 > 前缀 > 兜底", () => {
	const prices = [
		{ id: "deepseek-reasoner", inputPerM: 0.55 },
		{ id: "deepseek-v4-pro", inputPerM: 0.55 },
		{ id: "deepseek", inputPerM: 0.3 }
	];
	assert.equal(resolvePrice("deepseek-reasoner", prices, DEFAULT_PRICE).inputPerM, 0.55);
	assert.equal(resolvePrice("deepseek-v4-pro", prices, DEFAULT_PRICE).inputPerM, 0.55);
	assert.equal(resolvePrice("deepseek-v4-flash", prices, DEFAULT_PRICE).inputPerM, 0.3);
	assert.equal(resolvePrice("unknown-model", prices, DEFAULT_PRICE), DEFAULT_PRICE);
});

check("评级:梁祖 / 梁圣 / 梁子", () => {
	const god = scoreCall(usage({ input: 1000, read: 9000, output: 3000 }), DEFAULT_PRICE, OPTIONS);
	assert.ok(god.score >= 85, `score=${god.score}`);
	assert.equal(rankOf(god, OPTIONS), "liangzu");
	const saint = scoreCall(usage({ input: 3000, read: 1000, output: 800 }), DEFAULT_PRICE, OPTIONS);
	assert.equal(rankOf(saint, OPTIONS), "liangsheng");
	const mid = scoreCall(usage({ input: 20000, read: 1000, output: 300 }), DEFAULT_PRICE, OPTIONS);
	assert.equal(rankOf(mid, OPTIONS), "liangzi");
});

check("评级:牢梁(又贵又拉)与 小南梁(微小便宜)", () => {
	const jail = scoreCall(usage({ input: 200000, read: 0, output: 300 }), DEFAULT_PRICE, OPTIONS);
	assert.ok(jail.cost > OPTIONS.expensiveThreshold);
	assert.equal(rankOf(jail, OPTIONS), "laoliang");
	const tiny = scoreCall(usage({ input: 100, read: 0, output: 50 }), DEFAULT_PRICE, OPTIONS);
	assert.equal(rankOf(tiny, OPTIONS), "xiaonanliang");
	const poor = scoreCall(usage({ input: 500000, read: 0, output: 1200 }), DEFAULT_PRICE, OPTIONS);
	assert.equal(rankOf(poor, OPTIONS), "laoliang");
});

check("六档齐全且有标签", () => {
	assert.equal(TIER_ORDER.length, 6);
	for (const tier of TIER_ORDER) assert.ok(TIER_LABELS[tier].length > 0);
	assert.ok(Number.isFinite(DIAL_DELTAS.liangzu) && Number.isFinite(DIAL_DELTAS.laoliang));
});

check("滑动变阻器:推高/拉低/夹紧/缓存拉拽", () => {
	const DIAL_OPTIONS = { minDial: 0.25, maxDial: 1 };
	assert.ok(nextDial(0.6, "liangzu", 0.8, DIAL_OPTIONS) > 0.6);
	assert.ok(nextDial(0.6, "laoliang", 0.1, DIAL_OPTIONS) < 0.6);
	// 单步:牢梁 -0.06 且缓存拉拽 (0-0.5)*0.1 = -0.05 → 0.89
	assert.ok(Math.abs(nextDial(1, "laoliang", 0, DIAL_OPTIONS) - 0.89) < 1e-9);
	// 夹紧到下限/上限
	assert.equal(nextDial(0.25, "laoliang", 0, DIAL_OPTIONS), 0.25);
	assert.equal(nextDial(1, "liangzu", 1, DIAL_OPTIONS), 1);
	assert.ok(nextDial(0.6, "liangzi", 0.9, DIAL_OPTIONS) > 0.6);
	assert.ok(nextDial(0.6, "liangzi", 0.1, DIAL_OPTIONS) < 0.6);
	assert.equal(dialMaxTokens(131072, 0.5), 65536);
	assert.equal(dialMaxTokens(131072, 0.25), 32768);
	assert.equal(dialMaxTokens(131072, 0.001), 256);
});

check("展示格式化", () => {
	assert.equal(formatTokens(1234), "1.2k");
	assert.equal(formatTokens(1200000), "1.20M");
	assert.equal(formatUSD(0.00041), "$0.000410");
	assert.equal(renderRheostat(0.5, 10), "[=====|-----]");
	assert.equal(renderRheostat(0, 10), "[|----------]");
	assert.equal(renderRheostat(1, 10), "[==========|]");
});

console.log(`\n全部通过:${passed} 组断言`);
