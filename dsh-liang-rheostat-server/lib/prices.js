/**
 * dsh-liang-rheostat — 官网价格同步。
 *
 * 从 DeepSeek 官方定价页抓取价目并解析为规范化的分段价目条目:
 *   { id, currency, inputPerM, cacheReadPerM, outputPerM,
 *     segments?: [{ effectiveAt, peak: {…}, offPeak: {…} }] }
 * 页面结构变化时解析失败即返回 null,调用方回落到内置兜底表(FALLBACK_PRICES)。
 *
 * @module dsh-liang-rheostat/prices
 */

/** 默认同步源:官方定价页(中文版,人民币计价);英文美元版可配置 URL 切换。 */
export const DEFAULT_SYNC_URL = "https://api-docs.deepseek.com/zh-cn/quick_start/pricing/";

/** 峰谷定价生效时间(UTC):2026-08-16 16:00(北京 2026-08-17 00:00)。 */
export const PEAK_OFFPEAK_EFFECTIVE_AT = Date.parse("2026-08-16T16:00:00Z");

/**
 * 内置兜底价目表(随插件版本快照官网价;同步失败/未启用时使用)。
 * 当前官网价(2026-08-14,人民币/百万 token)+ 2026-08-16 16:00 UTC 起的峰谷分段。
 */
export const FALLBACK_PRICES = Object.freeze([
	Object.freeze({
		id: "deepseek-v4-flash",
		currency: "CNY",
		inputPerM: 1,
		cacheReadPerM: 0.02,
		outputPerM: 2,
		segments: Object.freeze([
			Object.freeze({
				effectiveAt: PEAK_OFFPEAK_EFFECTIVE_AT,
				peak: Object.freeze({ inputPerM: 3, cacheReadPerM: 0.1, outputPerM: 9 }),
				offPeak: Object.freeze({ inputPerM: 1.5, cacheReadPerM: 0.05, outputPerM: 4.5 })
			})
		])
	}),
	Object.freeze({
		id: "deepseek-v4-pro",
		currency: "CNY",
		inputPerM: 3,
		cacheReadPerM: 0.025,
		outputPerM: 6,
		segments: Object.freeze([
			Object.freeze({
				effectiveAt: PEAK_OFFPEAK_EFFECTIVE_AT,
				peak: Object.freeze({ inputPerM: 9, cacheReadPerM: 0.3, outputPerM: 27 }),
				offPeak: Object.freeze({ inputPerM: 4.5, cacheReadPerM: 0.15, outputPerM: 13.5 })
			})
		])
	})
]);

/** 把 HTML 压成可解析的纯文本(去脚本/样式/标签)。 */
export function stripHtml(html) {
	const text = String(html)
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<[^>]+>/g, " ");
	return decodeHtmlEntities(text).replace(/\s+/g, " ");
}

function decodeHtmlEntities(text) {
	return String(text)
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&quot;/gi, "\"")
		.replace(/&#39;/g, "'")
		.replace(/&times;/gi, "x");
}

/** 从纯文本里取数字(容忍货币前缀/后缀与千分位)。 */
function captureNumbers(text, from = 0) {
	const numbers = [];
	const re = /-?\d+(?:\.\d+)?/g;
	re.lastIndex = from;
	let match;
	while ((match = re.exec(text)) !== null) numbers.push(Number(match[0]));
	return numbers;
}

/** 解析生效日期:英文 "16:00 UTC on August 16, 2026" / 中文 "北京时间 2026 年 8 月 17 日 00:00"。 */
const MONTH_INDEX = Object.freeze({
	january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
	july: 6, august: 7, september: 8, october: 9, november: 10, december: 11
});
export function parseEffectiveAt(text) {
	const en = /take effect at\s+(\d{1,2}):(\d{2})\s*UTC\s+on\s+([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})/i.exec(text);
	if (en !== null) {
		const month = MONTH_INDEX[en[3].toLowerCase()];
		if (month !== void 0) {
			return Date.UTC(Number(en[5]), month, Number(en[4]), Number(en[1]), Number(en[2]));
		}
	}
	const zh = /北京时间\s*(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日\s*(\d{1,2}):(\d{2})/.exec(text);
	if (zh !== null) {
		// 北京时间 = UTC+8 → 转 UTC
		return Date.UTC(Number(zh[1]), Number(zh[2]) - 1, Number(zh[3]), Number(zh[4]), Number(zh[5])) - 8 * 3600 * 1000;
	}
	return void 0;
}

/**
 * 解析官方定价页(中/英文版均可)为规范化价目条目。
 * @param {string} html 定价页 HTML(或已压平的纯文本)
 * @returns {{ currency:string, entries:Array, effectiveAt?:number } | null}
 *          页面结构无法解析时返回 null。
 */
export function parsePricingPage(html) {
	const text = html.includes("<") ? stripHtml(html) : String(html);
	// 货币:人民币页含「元」,美元页含 $
	const currency = /元|¥/.test(text) ? "CNY" : /\$/.test(text) ? "USD" : "USD";
	const effectiveAt = parseEffectiveAt(text);

	// 1) 峰谷分段表(表 B):模型 + 空闲/高峰 各三列数字(容忍 $ 前缀与 元 后缀)
	const segmentRows = [];
	const segmentRe = /(deepseek-[a-z0-9-]+)\s+(OFF-PEAK|空闲时段)\s+\$?(\d+(?:\.\d+)?)\s*元?\s+\$?(\d+(?:\.\d+)?)\s*元?\s+\$?(\d+(?:\.\d+)?)\s*元?\s+(PEAK|高峰时段)\s+\$?(\d+(?:\.\d+)?)\s*元?\s+\$?(\d+(?:\.\d+)?)\s*元?\s+\$?(\d+(?:\.\d+)?)\s*元?/g;
	let segmentMatch;
	while ((segmentMatch = segmentRe.exec(text)) !== null) {
		segmentRows.push({
			id: segmentMatch[1],
			offPeak: {
				cacheReadPerM: Number(segmentMatch[3]),
				inputPerM: Number(segmentMatch[4]),
				outputPerM: Number(segmentMatch[5])
			},
			peak: {
				cacheReadPerM: Number(segmentMatch[7]),
				inputPerM: Number(segmentMatch[8]),
				outputPerM: Number(segmentMatch[9])
			}
		});
	}

	// 模型顺序:优先取分段行顺序,否则取全文出现顺序
	const modelOrder = [];
	for (const row of segmentRows) if (!modelOrder.includes(row.id)) modelOrder.push(row.id);
	if (modelOrder.length === 0) {
		const seen = new Set();
		for (const match of text.matchAll(/deepseek-[a-z0-9-]+/g)) if (!seen.has(match[0])) {
			seen.add(match[0]);
			modelOrder.push(match[0]);
		}
	}
	if (modelOrder.length === 0 || (segmentRows.length === 0 && !/(CACHE HIT)|缓存命中/.test(text))) return null;

	// 2) 平面价表(表 A):指标行各带每个模型一列数字(列序与模型表一致),只取前 N 个
	const flat = {};
	const flatPatterns = [
		[/1M INPUT TOKENS \(CACHE HIT\)|百万tokens输入（缓存命中）/, "cacheReadPerM"],
		[/1M INPUT TOKENS \(CACHE MISS\)|百万tokens输入（缓存未命中）/, "inputPerM"],
		[/1M OUTPUT TOKENS|百万tokens输出/, "outputPerM"]
	];
	for (const [re, key] of flatPatterns) {
		const match = re.exec(text);
		if (match === null) continue;
		// 该指标行后面的前 modelOrder.length 个数字即各模型该指标的价格
		const numbers = captureNumbers(text, match.index + match[0].length).slice(0, modelOrder.length);
		if (numbers.length === modelOrder.length) flat[key] = numbers;
	}

	const entries = modelOrder.map((id) => {
		const index = modelOrder.indexOf(id);
		const entry = { id, currency };
		const miss = flat.inputPerM?.[index];
		const hit = flat.cacheReadPerM?.[index];
		const out = flat.outputPerM?.[index];
		if (miss !== void 0) entry.inputPerM = miss;
		if (hit !== void 0) entry.cacheReadPerM = hit;
		if (out !== void 0) entry.outputPerM = out;
		const segment = segmentRows.find((row) => row.id === id);
		if (segment !== void 0 && effectiveAt !== void 0) {
			entry.segments = [{
				effectiveAt,
				peak: segment.peak,
				offPeak: segment.offPeak
			}];
		}
		return entry;
	});
	return { currency, entries, ...effectiveAt !== void 0 ? { effectiveAt } : {} };
}

/** 规范化一个配置价目条目(旧平面式或新分段式均保留原字段)。 */
export function normalizePriceEntry(entry) {
	return {
		...entry,
		currency: entry.currency ?? "USD"
	};
}

/**
 * 合并价目:同步表优先(官网为权威),配置表补齐官网未覆盖的模型;
 * `overrides`(sync.overrides,{ [model]: 平面价 })最后压顶。
 * @param {Array} synced 同步/兜底条目
 * @param {Array} configured 配置条目(经 normalizePriceEntry)
 * @param {object} [overrides] { [model]: { inputPerM?, cacheReadPerM?, outputPerM? } }
 * @returns {Array} 合并后的价目条目
 */
export function mergePriceEntries(synced, configured, overrides = {}) {
	const byId = new Map();
	for (const entry of synced) byId.set(entry.id, entry);
	for (const entry of configured) if (!byId.has(entry.id)) byId.set(entry.id, entry);
	for (const [id, patch] of Object.entries(overrides)) {
		const current = byId.get(id) ?? { id, currency: "USD" };
		byId.set(id, {
			...current,
			...patch,
			segments: void 0 // 显式覆盖后不再使用峰谷分段
		});
	}
	return [...byId.values()];
}

/**
 * 抓取并解析官方定价页。
 * @param {string} url 定价页 URL
 * @param {object} options { timeoutMs }
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ currency:string, entries:Array, effectiveAt?:number } | null>}
 */
export async function fetchOfficialPrices(url, options = {}, signal) {
	const { timeoutMs = 15000 } = options;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(url, {
			signal: signal === void 0 ? controller.signal : AbortSignal.any([signal, controller.signal]),
			headers: { "user-agent": "dsh-liang-rheostat/0.1 (+https://github.com/deepseek-ai/deepseek-harness)" }
		});
		if (!response.ok) return null;
		return parsePricingPage(await response.text());
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}
