/**
 * 价格同步模块测试:官网页解析(中/英文 fixture)+ 峰谷分段 + 合并规则。
 * 运行:node --test test/prices.test.js
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
	FALLBACK_PRICES,
	mergePriceEntries,
	normalizePriceEntry,
	parseEffectiveAt,
	parsePricingPage
} from "../lib/prices.js";

const EN_FIXTURE = readFileSync(new URL("./fixtures/pricing-en.txt", import.meta.url), "utf8");
const ZH_FIXTURE = readFileSync(new URL("./fixtures/pricing-zh.txt", import.meta.url), "utf8");

describe("官网价解析(英文页)", () => {
	const parsed = parsePricingPage(EN_FIXTURE);
	it("货币与生效日期", () => {
		assert.equal(parsed.currency, "USD");
		assert.equal(parsed.effectiveAt, Date.parse("2026-08-16T16:00:00Z"));
	});
	it("模型与平面价", () => {
		assert.equal(parsed.entries.length, 2);
		const flash = parsed.entries.find((e) => e.id === "deepseek-v4-flash");
		const pro = parsed.entries.find((e) => e.id === "deepseek-v4-pro");
		assert.equal(flash.inputPerM, 0.14);
		assert.equal(flash.cacheReadPerM, 0.0028);
		assert.equal(flash.outputPerM, 0.28);
		assert.equal(pro.inputPerM, 0.435);
		assert.equal(pro.cacheReadPerM, 0.003625);
		assert.equal(pro.outputPerM, 0.87);
	});
	it("峰谷分段(高峰/空闲,生效日期后)", () => {
		const flash = parsed.entries.find((e) => e.id === "deepseek-v4-flash");
		assert.equal(flash.segments.length, 1);
		assert.deepEqual(flash.segments[0].peak, { inputPerM: 0.44, cacheReadPerM: 0.014, outputPerM: 1.32 });
		assert.deepEqual(flash.segments[0].offPeak, { inputPerM: 0.22, cacheReadPerM: 0.007, outputPerM: 0.66 });
	});
});

describe("官网价解析(中文页)", () => {
	const parsed = parsePricingPage(ZH_FIXTURE);
	it("货币为 CNY 且平面价正确", () => {
		assert.equal(parsed.currency, "CNY");
		const flash = parsed.entries.find((e) => e.id === "deepseek-v4-flash");
		assert.equal(flash.inputPerM, 1);
		assert.equal(flash.cacheReadPerM, 0.02);
		assert.equal(flash.outputPerM, 2);
	});
	it("峰谷分段与生效日期(北京转 UTC)", () => {
		assert.equal(parsed.effectiveAt, Date.parse("2026-08-16T16:00:00Z"));
		const pro = parsed.entries.find((e) => e.id === "deepseek-v4-pro");
		assert.deepEqual(pro.segments[0].peak, { inputPerM: 9, cacheReadPerM: 0.3, outputPerM: 27 });
		assert.deepEqual(pro.segments[0].offPeak, { inputPerM: 4.5, cacheReadPerM: 0.15, outputPerM: 13.5 });
	});
});

describe("parseEffectiveAt", () => {
	it("英文格式", () => {
		assert.equal(parseEffectiveAt("take effect at 16:00 UTC on August 16, 2026"), Date.parse("2026-08-16T16:00:00Z"));
	});
	it("中文格式(北京转 UTC)", () => {
		assert.equal(parseEffectiveAt("新价格将于北京时间 2026 年 8 月 17 日 00:00 开始生效"), Date.parse("2026-08-16T16:00:00Z"));
	});
	it("缺省返回 undefined", () => {
		assert.equal(parseEffectiveAt("没有日期"), void 0);
	});
});

describe("合并规则", () => {
	const synced = [
		{ id: "deepseek-v4-flash", currency: "USD", inputPerM: 0.14, cacheReadPerM: 0.0028, outputPerM: 0.28 },
		{ id: "deepseek-v4-pro", currency: "USD", inputPerM: 0.435, cacheReadPerM: 0.003625, outputPerM: 0.87 }
	];
	it("同步优先于配置;配置补齐未覆盖模型", () => {
		const merged = mergePriceEntries(synced, [
			normalizePriceEntry({ id: "deepseek-v4-pro", inputPerM: 9.99 }),
			normalizePriceEntry({ id: "deepseek-chat", inputPerM: 0.27, outputPerM: 1.1 })
		]);
		assert.equal(merged.find((e) => e.id === "deepseek-v4-pro").inputPerM, 0.435);
		assert.equal(merged.find((e) => e.id === "deepseek-chat").inputPerM, 0.27);
		assert.equal(merged.length, 3);
	});
	it("overrides 压顶并清除分段", () => {
		const merged = mergePriceEntries(synced, [], {
			"deepseek-v4-flash": { inputPerM: 0.1 }
		});
		const flash = merged.find((e) => e.id === "deepseek-v4-flash");
		assert.equal(flash.inputPerM, 0.1);
		assert.equal(flash.segments, void 0);
	});
	it("内置兜底表含两模型与峰谷分段", () => {
		assert.equal(FALLBACK_PRICES.length, 2);
		assert.equal(FALLBACK_PRICES[0].segments[0].effectiveAt, Date.parse("2026-08-16T16:00:00Z"));
	});
});
