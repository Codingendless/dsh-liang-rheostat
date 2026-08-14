/**
 * dsh-liang-rheostat 引擎单测(无依赖,node:test)。
 * 运行:node --test test/engine.test.js
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	DIAL_DELTAS,
	TIER_LABELS,
	TIER_ORDER,
	callCost,
	cacheRateOf,
	clamp,
	dialMaxTokens,
	formatMoney,
	formatTokens,
	formatUSD,
	isPeakHour,
	matchesAny,
	matchesTarget,
	nextDial,
	rankOf,
	renderRheostat,
	resolvePrice,
	resolvePriceForTime,
	scoreCall,
	usageTokens,
	wildcardMatch
} from "../lib/engine.js";

/** 默认配置(options 里引擎用到的部分)。 */
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

/** 构造一个 usage 样例。 */
function usage({ input = 1000, read = 0, write = 0, output = 500 } = {}) {
	return { inputTokens: input, cacheReadTokens: read, cacheWriteTokens: write, outputTokens: output };
}

describe("clamp", () => {
	it("夹紧到区间内", () => {
		assert.equal(clamp(1.5, 0, 1), 1);
		assert.equal(clamp(-1, 0, 1), 0);
		assert.equal(clamp(0.5, 0, 1), 0.5);
	});
});

describe("通配符匹配", () => {
	it("deepseek-* 匹配常见模型", () => {
		assert.equal(wildcardMatch("deepseek-*", "deepseek-v4-flash"), true);
		assert.equal(wildcardMatch("deepseek-*", "deepseek-reasoner"), true);
		assert.equal(wildcardMatch("deepseek-*", "deepseek"), false);
		assert.equal(wildcardMatch("deepseek-*", "gpt-4o"), false);
		assert.equal(wildcardMatch("*", "anything"), true);
		assert.equal(wildcardMatch("deepseek-v4-?", "deepseek-v4-f"), true);
	});
	it("matchesAny 任一命中即可", () => {
		assert.equal(matchesAny(["deepseek-*", "glm-*"], "deepseek-chat"), true);
		assert.equal(matchesAny(["deepseek-*"], "gpt-4o"), false);
	});
	it("matchesTarget 同时校验 provider 与 model", () => {
		assert.equal(matchesTarget({ provider: "deepseek-official", model: "deepseek-v4-flash" }, ["deepseek-official"], ["deepseek-*"]), true);
		assert.equal(matchesTarget({ provider: "opencode-go", model: "deepseek-v4-flash" }, ["deepseek-official"], ["deepseek-*"]), false);
		assert.equal(matchesTarget({ provider: "deepseek-official", model: "gpt-4o" }, ["deepseek-official"], ["deepseek-*"]), false);
	});
});

describe("计量", () => {
	it("缓存率分母含未缓存输入/缓存读/缓存写", () => {
		assert.equal(cacheRateOf(usage({ input: 1000, read: 9000, write: 0 })), 0.9);
		assert.equal(cacheRateOf(usage({ input: 100, read: 0 })), 0);
		assert.equal(cacheRateOf(usage({ input: 0, read: 0, write: 0 })), 0);
	});
	it("usageTokens 汇总四桶", () => {
		assert.equal(usageTokens(usage({ input: 100, read: 50, write: 25, output: 10 })), 185);
	});
	it("callCost 按每百万 token 美元折算", () => {
		// 1000 未缓存输入 × 0.27 + 1000 缓存读 × 0.07 + 500 输出 × 1.1,全部 /1e6
		const cost = callCost(usage({ input: 1000, read: 1000, output: 500 }), DEFAULT_PRICE);
		assert.ok(Math.abs(cost - (1000 * 0.27 + 1000 * 0.07 + 500 * 1.1) / 1e6) < 1e-12);
	});
	it("resolvePrice:精确 id > 最长前缀 > 兜底", () => {
		const prices = [
			{ id: "deepseek-reasoner", inputPerM: 0.55 },
			{ id: "deepseek-v4-pro", inputPerM: 0.55 },
			{ id: "deepseek", inputPerM: 0.3 }
		];
		assert.equal(resolvePrice("deepseek-reasoner", prices, DEFAULT_PRICE).inputPerM, 0.55);
		assert.equal(resolvePrice("deepseek-v4-pro", prices, DEFAULT_PRICE).inputPerM, 0.55);
		// 前缀:deepseek-v4-flash 命中 "deepseek"(更长的 deepseek-v4-pro 不是前缀)
		assert.equal(resolvePrice("deepseek-v4-flash", prices, DEFAULT_PRICE).inputPerM, 0.3);
		assert.equal(resolvePrice("unknown-model", prices, DEFAULT_PRICE), DEFAULT_PRICE);
	});
});

describe("评分与评级", () => {
	it("高缓存高产出 -> 梁祖", () => {
		const metrics = scoreCall(usage({ input: 1000, read: 9000, output: 3000 }), DEFAULT_PRICE, OPTIONS);
		assert.ok(metrics.score >= 85, `score=${metrics.score}`);
		assert.equal(rankOf(metrics, OPTIONS), "liangzu");
	});
	it("良好表现 -> 梁圣,中等表现 -> 梁子", () => {
		const saint = scoreCall(usage({ input: 3000, read: 1000, output: 800 }), DEFAULT_PRICE, OPTIONS);
		assert.equal(rankOf(saint, OPTIONS), "liangsheng");
		const mid = scoreCall(usage({ input: 20000, read: 1000, output: 300 }), DEFAULT_PRICE, OPTIONS);
		assert.equal(rankOf(mid, OPTIONS), "liangzi");
	});
	it("又贵又拉(高费用低输出)-> 牢梁(硬规则优先)", () => {
		const metrics = scoreCall(usage({ input: 200000, read: 0, output: 300 }), DEFAULT_PRICE, OPTIONS);
		assert.ok(metrics.cost > OPTIONS.expensiveThreshold);
		assert.equal(rankOf(metrics, OPTIONS), "laoliang");
	});
	it("微小且便宜 -> 小难梁(硬规则优先)", () => {
		const metrics = scoreCall(usage({ input: 100, read: 0, output: 50 }), DEFAULT_PRICE, OPTIONS);
		assert.equal(rankOf(metrics, OPTIONS), "xiaonanliang");
	});
	it("低分(费用压力大)-> 牢梁", () => {
		const metrics = scoreCall(usage({ input: 500000, read: 0, output: 1200 }), DEFAULT_PRICE, OPTIONS);
		assert.equal(rankOf(metrics, OPTIONS), "laoliang");
	});
	it("评级 id 全部有标签,顺序从好到差", () => {
		assert.equal(TIER_ORDER.length, 6);
		for (const tier of TIER_ORDER) assert.ok(TIER_LABELS[tier].length > 0);
	});
});

describe("滑动变阻器", () => {
	const DIAL_OPTIONS = { minDial: 0.25, maxDial: 1 };
	it("梁祖推高 dial,牢梁拉低 dial", () => {
		const up = nextDial(0.6, "liangzu", 0.8, DIAL_OPTIONS);
		assert.ok(up > 0.6, `up=${up}`);
		const down = nextDial(0.6, "laoliang", 0.1, DIAL_OPTIONS);
		assert.ok(down < 0.6, `down=${down}`);
	});
	it("夹紧到 [minDial, maxDial],单步不越界", () => {
		const DIAL_OPTIONS = { minDial: 0.25, maxDial: 1 };
		// 牢梁 -0.06 且缓存拉拽 (0-0.5)*0.1 = -0.05 → 0.89
		assert.ok(Math.abs(nextDial(1, "laoliang", 0, DIAL_OPTIONS) - 0.89) < 1e-9);
		assert.equal(nextDial(0.25, "laoliang", 0, DIAL_OPTIONS), 0.25);
		assert.equal(nextDial(1, "liangzu", 1, DIAL_OPTIONS), 1);
	});
	it("缓存率拉拽:高缓存上调,低缓存下调", () => {
		assert.ok(nextDial(0.6, "liangzi", 0.9, DIAL_OPTIONS) > 0.6);
		assert.ok(nextDial(0.6, "liangzi", 0.1, DIAL_OPTIONS) < 0.6);
	});
	it("dialMaxTokens 按 dial 缩放并夹住下限", () => {
		assert.equal(dialMaxTokens(131072, 0.5), 65536);
		assert.equal(dialMaxTokens(131072, 0.25), 32768);
		assert.equal(dialMaxTokens(131072, 0.001), 256);
	});
	it("DIAL_DELTAS 与六档一一对应", () => {
		for (const tier of TIER_ORDER) assert.ok(Number.isFinite(DIAL_DELTAS[tier]));
	});
});

describe("展示格式化", () => {
	it("formatTokens / formatUSD / renderRheostat", () => {
		assert.equal(formatTokens(1234), "1.2k");
		assert.equal(formatTokens(1200000), "1.20M");
		assert.equal(formatUSD(0.00041), "$0.000410");
		assert.equal(renderRheostat(0.5, 10), "[=====|-----]");
		assert.equal(renderRheostat(0, 10), "[|----------]");
		assert.equal(renderRheostat(1, 10), "[==========|]");
	});
	it("formatMoney 按货币展示", () => {
		assert.equal(formatMoney(0.00041, "USD"), "$0.000410");
		assert.equal(formatMoney(0.00041, "CNY"), "¥0.000410");
		assert.equal(formatMoney(1.5, "USD"), "$1.500");
	});
});

describe("峰谷分段计价", () => {
	/** 2026-08-16T16:00:00Z 起生效的 flash 价目(官网口径)。 */
	const SEGMENTED = {
		id: "deepseek-v4-flash",
		currency: "USD",
		inputPerM: 0.14,
		cacheReadPerM: 0.0028,
		outputPerM: 0.28,
		segments: [{
			effectiveAt: Date.parse("2026-08-16T16:00:00Z"),
			peak: { inputPerM: 0.44, cacheReadPerM: 0.014, outputPerM: 1.32 },
			offPeak: { inputPerM: 0.22, cacheReadPerM: 0.007, outputPerM: 0.66 }
		}]
	};
	const T = Date.parse("2026-08-17T03:00:00Z"); // 生效后

	it("isPeakHour:UTC 01-04 与 06-10 为高峰,其余空闲", () => {
		const peak = [1, 2, 3, 6, 7, 9];
		const off = [0, 4, 5, 10, 12, 23];
		for (const hour of peak) assert.equal(isPeakHour(Date.UTC(2026, 7, 16, hour)), true, `hour ${hour} should be peak`);
		for (const hour of off) assert.equal(isPeakHour(Date.UTC(2026, 7, 16, hour)), false, `hour ${hour} should be off-peak`);
	});
	it("resolvePriceForTime:生效前用平面价,生效后按峰谷", () => {
		const before = resolvePriceForTime(SEGMENTED, Date.parse("2026-08-16T12:00:00Z"));
		assert.deepEqual(before, { inputPerM: 0.14, cacheReadPerM: 0.0028, outputPerM: 0.28 });
		const peak = resolvePriceForTime(SEGMENTED, Date.parse("2026-08-17T03:00:00Z")); // 03:00Z 高峰(1-4 段)
		assert.deepEqual(peak, { inputPerM: 0.44, cacheReadPerM: 0.014, outputPerM: 1.32 });
		const off = resolvePriceForTime(SEGMENTED, Date.parse("2026-08-17T12:00:00Z")); // 空闲
		assert.deepEqual(off, { inputPerM: 0.22, cacheReadPerM: 0.007, outputPerM: 0.66 });
	});
	it("callCost 按调用时间取峰谷价;缓存写按未命中价计费", () => {
		// 高峰(03:00Z):1000 未命中×0.44 + 1000 命中×0.014 + 500 输出×1.32,全部 /1e6
		const cost = callCost(usage({ input: 1000, read: 1000, output: 500 }), SEGMENTED, Date.parse("2026-08-17T03:00:00Z"));
		assert.ok(Math.abs(cost - (1000 * 0.44 + 1000 * 0.014 + 500 * 1.32) / 1e6) < 1e-12);
		// 空闲(12:00Z):半价
		const offCost = callCost(usage({ input: 1000, read: 1000, output: 500 }), SEGMENTED, Date.parse("2026-08-17T12:00:00Z"));
		assert.ok(Math.abs(offCost - (1000 * 0.22 + 1000 * 0.007 + 500 * 0.66) / 1e6) < 1e-12);
		// 缓存写按未命中价:write=1000 时与 input=1000 同价
		const withWrite = callCost(usage({ input: 0, write: 1000, output: 0 }), SEGMENTED, Date.parse("2026-08-17T03:00:00Z"));
		assert.ok(Math.abs(withWrite - (1000 * 0.44) / 1e6) < 1e-12);
	});
	it("scoreCall referenceCostPerKOutput=auto 时随输出单价缩放", () => {
		const autoOptions = { ...OPTIONS, referenceCostPerKOutput: "auto" };
		const metrics = scoreCall(usage({ input: 0, read: 0, output: 1000 }), SEGMENTED, autoOptions, Date.parse("2026-08-17T03:00:00Z"));
		// auto reference = 1.32/1000 = 0.00132;costPerK = 1.32/1000 = 0.00132 → 不超 2× → 无扣分
		assert.equal(metrics.score, 50 + 25 * 0 + Math.min(1, 1) * 10 + (1000 >= 2000 ? 5 : 0));
	});
	it("费用压力只算未命中输入+输出:大缓存小输出不再被当贵罚", () => {
		const autoOptions = { ...OPTIONS, referenceCostPerKOutput: "auto" };
		const time = Date.parse("2026-08-17T03:00:00Z"); // 生效后高峰
		// 51.5 万缓存读 + 741 输出:真实费用大头在缓存(便宜),压力口径应只看未命中+输出
		const metrics = scoreCall(usage({ input: 48, read: 515712, output: 741 }), SEGMENTED, autoOptions, time);
		// 压力费用 = (48×0.44 + 741×1.32)/1e6 ≈ 0.001;costPerK ≈ 参考价 → 无费用压力扣分
		const reference = 1.32 / 1000;
		assert.ok(metrics.costPerKOutput < reference * 2, `costPerKOutput=${metrics.costPerKOutput}`);
		// 得分 = 50 基准 + 缓存率×25(≈+25)+ 体量 7.41,无费用压力扣分
		const expected = 50 + metrics.cacheRate * 25 + Math.min(741 / 1000, 1) * 10;
		assert.ok(Math.abs(metrics.score - expected) < 1e-9, `score=${metrics.score} expected=${expected}`);
		// 反向对照:同量未命中输入(不缓存)该罚:costPerK 远超参考 → 有扣分
		const wasteful = scoreCall(usage({ input: 515712, read: 0, output: 741 }), SEGMENTED, autoOptions, time);
		assert.ok(wasteful.costPerKOutput > reference * 5);
		assert.ok(wasteful.score < metrics.score);
	});
});
