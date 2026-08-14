/**
 * dsh-liang-rheostat — 梁表引擎(纯函数,无依赖)。
 *
 * 把一次 DeepSeek 调用(token 输出、缓存率、费用)折算成 0–100 分,再映射到
 * 互联网讲法的六个档位,并驱动「滑动变阻器」的输出预算 dial。
 *
 * 档位语义(梁 = DeepSeek,取自创始人梁文锋的互联网昵称):
 *   liangzu        梁祖 👑  封神之祖,好到可以刻碑
 *   liangshen      梁神 🛐  神了,又快又省
 *   liangsheng     梁圣 ⛩️  圣质如初,稳中向好
 *   liangzi        梁子 🙂  平平无奇,正常发挥
 *   laoliang       牢梁 🚔  被关起来了,又贵又拉
 *   xiaonanliang   小南梁 🌱 小卡拉米,一句废话式输出
 *
 * @module dsh-liang-rheostat/engine
 */

/** 六档评级的有序 id(从最好到最差)。 */
export const TIER_ORDER = ["liangzu", "liangshen", "liangsheng", "liangzi", "laoliang", "xiaonanliang"];

/** 每档评级对滑阻 dial 的拉动量(±)。 */
export const DIAL_DELTAS = Object.freeze({
	liangzu: +0.06,
	liangshen: +0.04,
	liangsheng: +0.02,
	liangzi: 0,
	laoliang: -0.06,
	xiaonanliang: -0.02
});

/** 评级 -> 默认展示文案(emoji + 称谓)。 */
export const TIER_LABELS = Object.freeze({
	liangzu: "👑 梁祖",
	liangshen: "🛐 梁神",
	liangsheng: "⛩️ 梁圣",
	liangzi: "🙂 梁子",
	laoliang: "🚔 牢梁",
	xiaonanliang: "🌱 小南梁"
});

/** 把值夹在 [lo, hi] 之间。 */
export function clamp(value, lo, hi) {
	return Math.min(hi, Math.max(lo, value));
}

/** 转义正则元字符,用于把通配符以外的字符当作字面量。 */
export function escapeRegExp(source) {
	return String(source).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 通配符匹配:`*` 匹配任意长度(含空),`?` 匹配单个字符;其余字符按字面量匹配。
 * 例:`deepseek-*` 匹配 `deepseek-v4-flash` / `deepseek-reasoner`,不匹配 `deepseek`;
 * `deepseek-v4-?` 匹配 `deepseek-v4-f`,不匹配 `deepseek-v4-flash`。
 */
export function wildcardMatch(pattern, value) {
	const source = String(pattern);
	if (source === "*" || source === value) return true;
	let regex = "^";
	for (const character of source) {
		if (character === "*") regex += ".*";
		else if (character === "?") regex += ".";
		else regex += escapeRegExp(character);
	}
	regex += "$";
	return new RegExp(regex, "u").test(String(value));
}

/** 是否命中一组通配符(任一命中即可)。 */
export function matchesAny(patterns, value) {
	return patterns.some((pattern) => wildcardMatch(pattern, value));
}

/** 一次调用是否属于本插件关心的模型(provider 命中 + model 命中)。 */
export function matchesTarget(config, providers, modelPatterns) {
	if (!providers.includes(config.provider)) return false;
	if (!matchesAny(modelPatterns, config.model)) return false;
	return true;
}

/** 提示侧 token 总数(含缓存读/写)。 */
export function usageTokens(usage) {
	return (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0) + (usage.outputTokens ?? 0);
}

/** 缓存命中率 = 缓存读 / (未缓存输入 + 缓存读 + 缓存写)。 */
export function cacheRateOf(usage) {
	const input = usage.inputTokens ?? 0;
	const read = usage.cacheReadTokens ?? 0;
	const write = usage.cacheWriteTokens ?? 0;
	const total = input + read + write;
	return total === 0 ? 0 : read / total;
}

/**
 * 是否高峰时段(官网口径):UTC 01:00–04:00 与 06:00–10:00 为高峰,
 * 其余为空闲时段;空闲价格 = 高峰的一半。
 * @param {number} [time] 调用时间(Unix 毫秒);默认当前时间。
 */
export function isPeakHour(time = Date.now()) {
	const hour = new Date(time).getUTCHours();
	return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10);
}

/**
 * 按调用时间把一个价目条目解析成生效的「平面价」。
 * 条目可带 `segments`(峰谷分段):effectiveAt <= time 时取该段的 peak/offPeak
 * (按高峰/空闲时段),否则取条目本身的平面价;无 segments 时恒取条目本身。
 * 兼容旧式平面条目({ inputPerM, cacheReadPerM, outputPerM })。
 * @param {object} entry 价目条目
 * @param {number} [time] 调用时间(Unix 毫秒)
 * @returns {{ inputPerM:number, cacheReadPerM:number, outputPerM:number }}
 */
export function resolvePriceForTime(entry, time = Date.now()) {
	const base = {
		inputPerM: entry.inputPerM,
		cacheReadPerM: entry.cacheReadPerM,
		outputPerM: entry.outputPerM
	};
	const segments = Array.isArray(entry.segments) ? entry.segments : [];
	if (segments.length === 0) return base;
	const segment = segments.filter((s) => s.effectiveAt <= time).at(-1);
	if (segment === void 0) return base;
	return isPeakHour(time) ? segment.peak : segment.offPeak;
}

/** 货币符号表(展示用)。 */
export const CURRENCY_SYMBOLS = Object.freeze({ USD: "$", CNY: "¥" });

/** 取货币符号;未知货币回落到 $。 */
export function currencySymbol(currency) {
	return CURRENCY_SYMBOLS[currency] ?? "$";
}

/**
 * 按单价表折算一次调用的费用。单价为「每百万 token」;缓存写按未命中价计费
 * (DeepSeek 不单独区分 cache write)。带 `segments` 的条目按调用时间取峰谷价。
 * @param {object} usage provider 用量
 * @param {object} price 价目条目(平面或含 segments)
 * @param {number} [time] 调用时间(Unix 毫秒),用于峰谷分段取价
 */
export function callCost(usage, price, time = Date.now()) {
	const resolved = resolvePriceForTime(price, time);
	const input = usage.inputTokens ?? 0;
	const read = usage.cacheReadTokens ?? 0;
	const write = usage.cacheWriteTokens ?? 0;
	const output = usage.outputTokens ?? 0;
	return (
		(input * resolved.inputPerM + read * resolved.cacheReadPerM + write * resolved.inputPerM + output * resolved.outputPerM) /
		1e6
	);
}

/**
 * 按模型解析单价:精确 id 优先,其次最长前缀,最后回落到默认价。
 * @param {string} model 模型 id
 * @param {Array} prices 配置的价目表 [{id, inputPerM, cacheReadPerM, cacheWritePerM, outputPerM}]
 * @param {object} defaultPrice 兜底单价
 */
export function resolvePrice(model, prices, defaultPrice) {
	for (const entry of prices) if (entry.id === model) return entry;
	let best = null;
	for (const entry of prices) if (model.startsWith(entry.id) && (best === null || entry.id.length > best.id.length)) best = entry;
	return best ?? defaultPrice;
}

/**
 * 费用压力口径:只算「未命中输入 + 输出」,不含缓存读。
 * 缓存命中已是好事(评分里已 +25 奖励),不应再被当成"贵"惩罚。
 */
export function pressureCost(usage, price, time = Date.now()) {
	const resolved = resolvePriceForTime(price, time);
	const input = usage.inputTokens ?? 0;
	const output = usage.outputTokens ?? 0;
	return (input * resolved.inputPerM + output * resolved.outputPerM) / 1e6;
}

/**
 * 为一次调用打分(0–100)。分越高越「梁」。
 * 构成:基准 50 + 缓存率(≤+25) + 产出体量(≤+20) + 微小输出惩罚(-20) + 费用压力惩罚(≤-25)。
 * 费用压力 = 每千输出 token 的「未命中输入+输出」费用(缓存读不计入)。
 * `referenceCostPerKOutput` 为 "auto" 时按该模型解析后的输出单价推导
 * (auto = outputPerM/1000,随官网同步价自动缩放)。
 * @param {object} usage provider 用量(inputTokens/outputTokens/cacheReadTokens/cacheWriteTokens)
 * @param {object} price 价目条目(平面或含 segments)
 * @param {object} options { baseMaxTokens, referenceCostPerKOutput, expensiveThreshold, tinyOutputTokens }
 * @param {number} [time] 调用时间(Unix 毫秒),用于峰谷分段取价
 * @returns {{ output:number, cost:number, cacheRate:number, costPerKOutput:number, score:number }}
 */
export function scoreCall(usage, price, options, time = Date.now()) {
	const output = usage.outputTokens ?? 0;
	const cacheRate = cacheRateOf(usage);
	const cost = callCost(usage, price, time);
	const pressure = pressureCost(usage, price, time);
	const reference = options.referenceCostPerKOutput === "auto"
		? resolvePriceForTime(price, time).outputPerM / 1000
		: options.referenceCostPerKOutput;
	const costPerKOutput = output > 0 ? (pressure / output) * 1000 : pressure > 0 ? Infinity : 0;
	let score = 50;
	score += clamp(cacheRate, 0, 1) * 25;
	score += clamp(output / 1000, 0, 1) * 10;
	if (options.baseMaxTokens > 0 && output >= options.baseMaxTokens * 0.6) score += 5;
	if (output >= 2000) score += 5;
	if (output < options.tinyOutputTokens) score -= 20;
	if (costPerKOutput > reference * 2) score -= 15;
	if (costPerKOutput > reference * 5) score -= 10;
	if (cost > options.expensiveThreshold) score -= 10;
	return {
		output,
		cost,
		cacheRate,
		costPerKOutput,
		score: clamp(score, 0, 100)
	};
}

/**
 * 由评分结果映射到六档评级。
 * 硬规则优先:又贵又拉 -> 牢梁;微小且便宜 -> 小南梁;其余按分数阈值。
 * @param {object} metrics scoreCall 的返回
 * @param {object} options { tinyOutputTokens, tinyCostCap, wasteOutputTokens, expensiveThreshold, tiers }
 * @returns {string} TIER_ORDER 之一
 */
export function rankOf(metrics, options) {
	if (metrics.cost > options.expensiveThreshold && metrics.output < options.wasteOutputTokens) return "laoliang";
	if (metrics.output < options.tinyOutputTokens && metrics.cost < options.tinyCostCap) return "xiaonanliang";
	const score = metrics.score;
	if (score >= options.tiers.liangzu) return "liangzu";
	if (score >= options.tiers.liangshen) return "liangshen";
	if (score >= options.tiers.liangsheng) return "liangsheng";
	if (score >= options.tiers.liangzi) return "liangzi";
	if (score >= options.tiers.laoliang) return "laoliang";
	return "xiaonanliang";
}

/**
 * 计算下一次调用应使用的滑阻 dial。
 * dial 上升 = 更慷慨的输出预算;下降 = 收紧(省 token / 省钱)。
 * @param {number} current 当前 dial
 * @param {string} rank 刚产生的一档评级
 * @param {number} windowCacheRate 窗口内平均缓存率(0–1)
 * @param {object} options { minDial, maxDial }
 * @returns {number} 新 dial,已夹紧到 [minDial, maxDial]
 */
export function nextDial(current, rank, windowCacheRate, options) {
	const delta = DIAL_DELTAS[rank] ?? 0;
	const cachePull = (clamp(windowCacheRate, 0, 1) - 0.5) * 0.1;
	return clamp(current + delta + cachePull, options.minDial, options.maxDial);
}

/** 由 dial 算出本次请求的 max_tokens(输出预算)。 */
export function dialMaxTokens(baseMaxTokens, dial) {
	return Math.max(256, Math.round(baseMaxTokens * dial));
}

/** 千分位格式化。 */
export function formatNumber(value) {
	return Number(value).toLocaleString("en-US");
}

/** 人类可读的 token 数:1,234 / 12.3k / 1.2M。 */
export function formatTokens(value) {
	const number = Number(value) || 0;
	if (number >= 1e6) return `${(number / 1e6).toFixed(2)}M`;
	if (number >= 1e3) return `${(number / 1e3).toFixed(1)}k`;
	return formatNumber(number);
}

/** 人类可读的美元费用(兼容旧接口;新代码用 formatMoney)。 */
export function formatUSD(value) {
	return formatMoney(value, "USD");
}

/**
 * 人类可读的费用,按货币符号展示(USD → $,CNY → ¥)。
 * @param {number} value 费用
 * @param {string} [currency] 货币代码,默认 USD
 */
export function formatMoney(value, currency = "USD") {
	const symbol = currencySymbol(currency);
	const number = Number(value) || 0;
	if (number >= 1) return `${symbol}${number.toFixed(3)}`;
	if (number >= 0.01) return `${symbol}${number.toFixed(4)}`;
	return `${symbol}${number.toFixed(6)}`;
}

/**
 * 渲染一根 ASCII 滑动变阻器条,标明 dial 位置。
 * 例(dial=0.72,宽 20):[=====|---------------]
 */
export function renderRheostat(dial, width = 20) {
	const position = Math.round(clamp(dial, 0, 1) * width);
	const bar = "=".repeat(position) + "|" + "-".repeat(width - position);
	return `[${bar}]`;
}
