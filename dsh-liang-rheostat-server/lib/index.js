/**
 * dsh-liang-rheostat — DeepSeek 梁表 · 滑动变阻器。
 *
 * 只对 DeepSeek 本身平台(默认 provider `deepseek-official`)的模型生效:
 * 1. 计量 —— 监听 `session/event`,对每次带 usage 的模型调用折算
 *    输出 token、缓存命中率、美元费用,并打出互联网讲法的评级
 *    (梁祖/梁神/梁圣/梁子/牢梁/小南梁,称谓可配置)。
 * 2. 滑动变阻器 —— 维护一根 dial(输出预算系数),按近期窗口表现自动滑动:
 *    表现好(dial 上升)放宽 max_tokens,又贵又拉则收紧,像滑动变阻器一样
 *    自动调节回路的「阻力」。调节点在 `agent/request` waterfall 上,
 *    只影响 agent 主循环的请求,且会写进 request header(缓存稳定性友好)。
 * 3. 暴露 —— `ctx.liangRheostat` 服务、`liang/call` / `liang/dial` 事件、
 *    `/liang` 斜杠命令(状态 / reset / dial <v>)。
 *
 * @module dsh-liang-rheostat
 */
import { Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import {
	TIER_LABELS,
	TIER_ORDER,
	clamp,
	currencySymbol,
	dialMaxTokens,
	formatMoney,
	formatNumber,
	formatTokens,
	isPeakHour,
	matchesTarget,
	nextDial,
	rankOf,
	renderRheostat,
	resolvePrice,
	resolvePriceForTime,
	scoreCall
} from "./engine.js";
import {
	DEFAULT_SYNC_URL,
	FALLBACK_PRICES,
	fetchOfficialPrices,
	mergePriceEntries,
	normalizePriceEntry
} from "./prices.js";

/** 插件名(loader 行 id)。 */
const name = "liang-rheostat";

/** 峰谷分段价(峰值/空闲各一套平面价)。 */
const segmentPriceSchema = z.object({
	inputPerM: z.number().min(0).default(0.27),
	cacheReadPerM: z.number().min(0).default(0.07),
	outputPerM: z.number().min(0).default(1.1)
});

/** 单价条目:每百万 token 美元;`maxTokens` 为该模型的最大输出预算基准。 */
const priceSchema = z.object({
	id: z.string().required(),
	inputPerM: z.number().min(0).default(0.27),
	cacheReadPerM: z.number().min(0).default(0.07),
	cacheWritePerM: z.number().min(0).default(0.27),
	outputPerM: z.number().min(0).default(1.1),
	/** 货币代码(展示用):USD / CNY。 */
	currency: z.string().default("USD"),
	/** 可选:峰谷分段计价(生效时间戳起按高峰/空闲取价)。 */
	segments: z
		.array(z.object({
			effectiveAt: z.number().min(0),
			peak: segmentPriceSchema,
			offPeak: segmentPriceSchema
		}))
		.default([]),
	maxTokens: z.number().step(1).min(256)
});

const defaultPriceSchema = z.object({
	inputPerM: z.number().min(0).default(0.27),
	cacheReadPerM: z.number().min(0).default(0.07),
	cacheWritePerM: z.number().min(0).default(0.27),
	outputPerM: z.number().min(0).default(1.1),
	currency: z.string().default("USD")
});

const Config = z.object({
	enabled: z.boolean().default(true),
	/** 视为「DeepSeek 平台」的 provider 路由。 */
	providers: z.array(z.string()).default(["deepseek-official"]),
	/** 模型通配符,`*` 任意匹配。 */
	modelPatterns: z.array(z.string()).default(["deepseek-*"]),
	/** 滑动窗口大小(最近 N 次调用决定滑阻方向)。 */
	windowSize: z.number().step(1).min(1).max(64).default(12),
	/** 初始 dial(输出预算系数)。 */
	initialDial: z.number().min(0.1).max(1).default(0.6),
	/** dial 下限:再怎么省也不会低于这个输出预算比例。 */
	minDial: z.number().min(0.1).max(0.9).default(0.25),
	/** dial 上限:表现再好也不会超过这个输出预算比例。 */
	maxDial: z.number().min(0.2).max(1).default(1),
	/** 通用 max_tokens 基准;价目表中模型自带的 maxTokens 优先。 */
	baseMaxTokens: z.number().step(1).min(256).default(131072),
	/** 「小」的判定:输出低于该 token 数视为微小输出。 */
	tinyOutputTokens: z.number().step(1).min(1).default(200),
	/** 微小输出且费用低于该值 -> 小南梁(单位随同步货币,默认人民币)。 */
	tinyCostCap: z.number().min(0).default(0.007),
	/** 「又贵又拉」的输出上限:费用超阈值且输出低于该值 -> 牢梁。 */
	wasteOutputTokens: z.number().step(1).min(1).default(400),
	/** 单次调用「贵」的费用阈值(单位随同步货币,默认人民币)。 */
	expensiveThreshold: z.number().min(0).default(0.035),
	/** 参考价:每千输出 token 的费用,用于费用压力扣分;"auto" = 该模型输出单价/1000。 */
	referenceCostPerKOutput: z.union([z.number().min(0), z.const("auto")]).default("auto"),
	/** 兜底单价。 */
	defaultPrice: defaultPriceSchema.default({}),
	/** 按模型的价目表(精确 id 优先,其次最长前缀;官网同步表优先于此处同 id 条目)。 */
	prices: z.array(priceSchema).default([]),
	/** 官网价格同步。 */
	sync: z
		.object({
			enabled: z.boolean().default(true),
			/** 定价页 URL(默认英文美元版;中文人民币版可填 zh-cn 地址)。 */
			url: z.string().default(DEFAULT_SYNC_URL),
			/** 重新同步间隔(小时)。 */
			intervalHours: z.number().min(1).max(168).default(24),
			/** 抓取超时(毫秒)。 */
			timeoutMs: z.number().min(1000).default(15000),
			/** 显式覆盖:{ [model]: { inputPerM?, cacheReadPerM?, outputPerM? } }。 */
			overrides: z.dict(z.object({
				inputPerM: z.number().min(0),
				cacheReadPerM: z.number().min(0),
				outputPerM: z.number().min(0)
			})).default({})
		})
		.default({}),
	/** 各档评级的最低分数阈值(score 0–100)。 */
	tiers: z
		.object({
			liangzu: z.number().min(0).max(100).default(85),
			liangshen: z.number().min(0).max(100).default(70),
			liangsheng: z.number().min(0).max(100).default(55),
			liangzi: z.number().min(0).max(100).default(35),
			laoliang: z.number().min(0).max(100).default(18)
		})
		.default({}),
	/** 是否对每次调用打印日志。 */
	logEveryCall: z.boolean().default(true)
});

/**
 * 拒绝拼写错误的配置键,避免默认值掩盖笔误。
 * cordis 已在启动前通过静态 Config schema 校验/填充默认值(schemastery 会把未知键
 * 保留在结果里),这里再对未知键 fail loud。
 */
function validateConfigKeys(config) {
	const known = Object.keys(Config.dict ?? {});
	for (const key of Object.keys(config)) {
		if (!known.includes(key)) throw new Error(`LiangRheostatConfig: unknown key "${key}" (see the plugin README for the supported config)`);
	}
}

/**
 * 服务构造期之后不允许再改动的规范化配置。
 * 通过静态 Config schema 校验并填充默认值(schemastery 会把未知键保留在结果里),
 * 随后对未知键 fail loud。loader 流程里 cordis 已做过一次同构校验,重复执行幂等无害;
 * 直接构造(测试、其他宿主)时也能自洽。
 */
function normalizeConfig(config) {
	const result = Config["~standard"].validate(config ?? {});
	if (result.issues) throw new Error(`LiangRheostatConfig: invalid config: ${JSON.stringify(result.issues)}`);
	validateConfigKeys(result.value);
	return structuredClone(result.value);
}

/** 每个会话的最近请求上下文(provider/model),用于给 usage 归属。 */
function contextOf(sessionContexts, session) {
	let context = sessionContexts.get(session);
	if (context === void 0) {
		context = {};
		sessionContexts.set(session, context);
	}
	return context;
}

/** 服务:ctx.liangRheostat。 */
var LiangRheostatService = (() => {
	let _classSuper = Service;
	return class LiangRheostatService extends _classSuper {
		static Config = Config;
		/** 当前 dial(滑动变阻器位置)。 */
		dial;
		/** 最近 windowSize 次调用的 { rank, cacheRate } 队列。 */
		window = [];
		/** 窗口内缓存率之和,与 window 同长。 */
		_cacheRateSum = 0;
		/** 累计:调用次数、输出 token、缓存读、费用、总 token。 */
		totals = {
			calls: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			inputTokens: 0,
			cost: 0
		};
		/** 评级分布。 */
		rankCounts = Object.fromEntries(TIER_ORDER.map((tier) => [tier, 0]));
		/** 最近调用记录(用于 /liang 展示,最多保留 12 条)。 */
		recent = [];
		/** session -> { provider, model }。 */
		sessionContexts = /* @__PURE__ */ new WeakMap();
		/** 当前生效的价目表(官网同步优先 + 配置补齐 + 覆盖)。 */
		prices = [];
		/** 价目来源:"fallback" | "synced"。 */
		priceSource = "fallback";
		/** 最近一次同步成功时间。 */
		syncedAt = null;
		/** 最近一次同步失败原因。 */
		syncError = null;
		/** 同步定时器与中止器。 */
		_syncTimer = null;
		_syncAbort = null;
		constructor(ctx, config = {}) {
			super(ctx, "liangRheostat");
			this.config = normalizeConfig(config);
			this.dial = clamp(this.config.initialDial, this.config.minDial, this.config.maxDial);
			this.log = ctx.logger;
			this.prices = this.composePrices(FALLBACK_PRICES);
			if (!this.config.enabled) return;
			ctx.on("session/event", (session, event) => {
				this.onSessionEvent(session, event);
			});
			ctx.on("agent/request", async (payload, next) => {
				const config = await next();
				return this.onAgentRequest(config);
			}, {
				global: true,
				prepend: true
			});
			ctx.inject(["commands"], (injectedCtx) => {
				injectedCtx.effect(() => injectedCtx.commands.register({
					name: "liang",
					description: "梁表 · 滑动变阻器:查看评级/滑阻状态(reset 清零,dial <0.1-1> 手动拨片,sync 强制同步官网价)",
					handler: (invocation) => this.onCommand(invocation)
				}), "liang-rheostat command");
			});
			// 浏览器端从同源端点取价目表(客户端显示与服务端一致)。
			ctx.inject(["webServer"], (injectedCtx) => {
				injectedCtx.effect(() => injectedCtx.webServer.register({
					kind: "exact",
					path: "/liang-prices.json",
					handler: async (req, res) => this.servePrices(req, res)
				}), "liang-rheostat prices route");
			});
			if (this.config.sync.enabled) {
				this.syncPrices().then(() => {
					if (this._syncTimer !== null) return;
					this._syncTimer = setInterval(() => this.syncPrices(), this.config.sync.intervalHours * 3600 * 1000);
					this._syncTimer.unref?.();
				});
			}
			ctx.effect(() => () => {
				if (this._syncTimer !== null) clearInterval(this._syncTimer);
				this._syncAbort?.abort();
			}, "liang-rheostat sync teardown");
			this.log.info("[liang-rheostat] 梁表上线:providers=%s models=%s 初始滑阻 R=%.2f (%s) 价目=%s",
				JSON.stringify(this.config.providers), JSON.stringify(this.config.modelPatterns), this.dial, renderRheostat(this.dial),
				this.config.sync.enabled ? "官网同步" : "内置表");
		}
		/** 合并价目表:同步/兜底为基,配置补齐,overrides 压顶。 */
		composePrices(synced) {
			return mergePriceEntries(
				synced,
				this.config.prices.map((entry) => normalizePriceEntry(entry)),
				this.config.sync.overrides
			);
		}
		/** 抓取官网定价并合并进价目表(失败保持现状并记录原因)。 */
		async syncPrices() {
			const { url, timeoutMs } = this.config.sync;
			this._syncAbort?.abort();
			this._syncAbort = new AbortController();
			const parsed = await fetchOfficialPrices(url, { timeoutMs }, this._syncAbort.signal);
			if (parsed === null || parsed.entries.length === 0) {
				this.syncError = `解析/抓取失败(${url})`;
				this.log.warn("[liang-rheostat] 官网价格同步失败,继续使用%s价目表:%s",
					this.priceSource === "synced" ? "已同步" : "内置", url);
				return;
			}
			this.prices = this.composePrices(parsed.entries);
			this.priceSource = "synced";
			this.syncedAt = Date.now();
			this.syncError = null;
			this.log.info("[liang-rheostat] 官网价格已同步:%s 模型 %d 个,货币 %s%s",
				url, parsed.entries.length, parsed.currency,
				parsed.effectiveAt !== void 0 ? `,峰谷生效 ${new Date(parsed.effectiveAt).toISOString()}` : "");
		}
		/** 服务 /liang-prices.json:浏览器端取价目表与评分参数(与 /liang 同源)。 */
		async servePrices(req, res) {
			const payload = {
				source: this.priceSource,
				syncedAt: this.syncedAt,
				effectiveAt: this.effectiveSegmentAt(),
				currency: this.prices[0]?.currency ?? "CNY",
				defaultPrice: {
					inputPerM: this.config.defaultPrice.inputPerM ?? 1,
					cacheReadPerM: this.config.defaultPrice.cacheReadPerM ?? 0.02,
					outputPerM: this.config.defaultPrice.outputPerM ?? 2,
					currency: this.config.defaultPrice.currency ?? "CNY"
				},
				// 评分参数也下发:浏览器端用同一套阈值重算,保证显示与服务端一致。
				options: {
					baseMaxTokens: this.config.baseMaxTokens,
					referenceCostPerKOutput: this.config.referenceCostPerKOutput,
					expensiveThreshold: this.config.expensiveThreshold,
					tinyOutputTokens: this.config.tinyOutputTokens,
					tinyCostCap: this.config.tinyCostCap,
					wasteOutputTokens: this.config.wasteOutputTokens,
					tiers: this.config.tiers
				},
				entries: this.prices
			};
			const body = JSON.stringify(payload);
			res.writeHead(200, {
				"content-type": "application/json; charset=utf-8",
				"cache-control": "no-cache"
			});
			res.end(body);
		}
		/** 当前峰谷分段生效时间(取价目表里最早的 effectiveAt)。 */
		effectiveSegmentAt() {
			let earliest = void 0;
			for (const entry of this.prices) {
				for (const segment of entry.segments ?? []) {
					if (earliest === void 0 || segment.effectiveAt < earliest) earliest = segment.effectiveAt;
				}
			}
			return earliest ?? null;
		}
		/** 是否命中 DeepSeek 平台目标。 */
		isTarget(provider, model) {
			return matchesTarget({ provider, model }, this.config.providers, this.config.modelPatterns);
		}
		/** 某模型的 max_tokens 基准:价目表条目优先,否则通用基准。 */
		baseMaxTokensFor(model) {
			const price = resolvePrice(model, this.prices, this.config.defaultPrice);
			if (price.maxTokens !== void 0) return price.maxTokens;
			return this.config.baseMaxTokens;
		}
		/** agent/request waterfall 上的滑阻调节点。 */
		onAgentRequest(config) {
			if (config === null || typeof config !== "object") return config;
			if (!this.isTarget(config.provider, config.model)) return config;
			const target = dialMaxTokens(this.baseMaxTokensFor(config.model), this.dial);
			const current = config.maxTokens;
			// 已有显式更小的 maxTokens 时尊重它(不抬升);未设或更大则按滑阻夹紧。
			if (current === void 0 || current > target) return {
				...config,
				maxTokens: target
			};
			return config;
		}
		/** session/event 上的计量与评级。 */
		onSessionEvent(session, event) {
			switch (event.type) {
				case "request/header": {
					const headerConfig = event.data?.header?.config;
					if (headerConfig?.provider !== void 0) {
						const context = contextOf(this.sessionContexts, session);
						context.provider = headerConfig.provider;
						context.model = headerConfig.model;
					}
					break;
				}
				case "request/context": {
					const data = event.data;
					if (data?.provider !== void 0) {
						const context = contextOf(this.sessionContexts, session);
						context.provider = data.provider;
						context.model = data.model;
					}
					break;
				}
				case "assistant/message": {
					const usage = event.data?.usage;
					if (usage === void 0) break;
					const context = this.sessionContexts.get(session);
					if (context?.provider === void 0 || !this.isTarget(context.provider, context.model)) break;
					this.recordCall({
						provider: context.provider,
						model: context.model,
						usage,
						sessionId: session.id,
						seq: event.seq,
						time: event.time,
						turn: event.data.turn,
						step: event.data.step
					});
					break;
				}
				default:
					break;
			}
		}
		/** 记录一次调用:打分、评级、滑动 dial、更新统计与事件。 */
		recordCall(call) {
			const { provider, model, usage } = call;
			const price = resolvePrice(model, this.prices, this.config.defaultPrice);
			const metrics = scoreCall(usage, price, this.config, call.time ?? Date.now());
			const rank = rankOf(metrics, this.config);
			const cost = metrics.cost;
			const cacheRate = metrics.cacheRate;
			const output = metrics.output;
			const previousDial = this.dial;
			this.window.push({ rank, cacheRate });
			this._cacheRateSum += cacheRate;
			if (this.window.length > this.config.windowSize) {
				const evicted = this.window.shift();
				this._cacheRateSum -= evicted.cacheRate;
			}
			const windowCacheRate = this.windowCacheRate();
			this.dial = nextDial(this.dial, rank, windowCacheRate, this.config);
			this.totals.calls += 1;
			this.totals.outputTokens += output;
			this.totals.cacheReadTokens += usage.cacheReadTokens ?? 0;
			this.totals.inputTokens += (usage.inputTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
			this.totals.cost += cost;
			this.rankCounts[rank] += 1;
			const record = Object.freeze({
				...call,
				rank,
				...TIER_LABELS[rank] === void 0 ? {} : { rankLabel: TIER_LABELS[rank] },
				score: metrics.score,
				outputTokens: output,
				cacheRate,
				cost,
				costPerKOutput: metrics.costPerKOutput,
				price,
				dial: this.dial,
				dialDelta: this.dial - previousDial
			});
			this.recent.unshift(record);
			if (this.recent.length > 12) this.recent.pop();
			if (this.config.logEveryCall) {
				this.log.info(
					"[liang-rheostat] %s %s 输出 %s tok · 缓存率 %.1f%% · 费用 %s · 得分 %.0f → %s · 滑阻 R=%.2f%s (Δ%+.3f)",
					provider,
					model,
					formatTokens(output),
					cacheRate * 100,
					formatMoney(cost, price.currency),
					metrics.score,
					TIER_LABELS[rank],
					this.dial,
					renderRheostat(this.dial),
					this.dial - previousDial
				);
			}
			this.ctx.emit("liang/call", record);
			if (this.dial !== previousDial) this.ctx.emit("liang/dial", Object.freeze({
				dial: this.dial,
				previousDial,
				reason: TIER_LABELS[rank],
				timestamp: Date.now()
			}));
		}
		/** 窗口内平均缓存率(0–1);空窗口按 0.5 处理。 */
		windowCacheRate() {
			if (this.window.length === 0) return 0.5;
			return this._cacheRateSum / this.window.length;
		}
		/** 只读快照(供 /liang 命令与其他插件)。 */
		snapshot() {
			const windowRanks = {};
			for (const tier of TIER_ORDER) windowRanks[tier] = 0;
			for (const entry of this.window) windowRanks[entry.rank] += 1;
			return Object.freeze({
				enabled: this.config.enabled,
				providers: [...this.config.providers],
				modelPatterns: [...this.config.modelPatterns],
				dial: this.dial,
				minDial: this.config.minDial,
				maxDial: this.config.maxDial,
				windowSize: this.config.windowSize,
				windowRanks,
				totals: { ...this.totals },
				rankCounts: { ...this.rankCounts },
				recent: this.recent.slice(0, 8)
			});
		}
		/** 清空窗口、评级与累计(手动 reset)。 */
		reset() {
			this.window = [];
			this._cacheRateSum = 0;
			this.recent = [];
			this.totals = {
				calls: 0,
				outputTokens: 0,
				cacheReadTokens: 0,
				inputTokens: 0,
				cost: 0
			};
			this.rankCounts = Object.fromEntries(TIER_ORDER.map((tier) => [tier, 0]));
			this.dial = clamp(this.config.initialDial, this.config.minDial, this.config.maxDial);
		}
		/** 手动拨片:直接设定 dial(变阻器手动档)。 */
		setDial(value) {
			const previous = this.dial;
			this.dial = clamp(Number(value), this.config.minDial, this.config.maxDial);
			if (this.dial !== previous) this.ctx.emit("liang/dial", Object.freeze({
				dial: this.dial,
				previousDial: previous,
				reason: "manual",
				timestamp: Date.now()
			}));
			return this.dial;
		}
		/** /liang 命令处理器。 */
		onCommand(invocation) {
			const input = invocation.rawInput.trim();
			if (input === "reset") {
				this.reset();
				return {
					kind: "success",
					text: "⚡ 梁表已重置:窗口、评级、累计清零,滑阻回到初始位置。"
				};
			}
			if (input === "sync") {
				this.syncPrices().then(() => {
					if (this.syncError !== null) this.log.warn("[liang-rheostat] %s", this.syncError);
				});
				return {
					kind: "success",
					text: this.renderStatus()
				};
			}
			const manual = /^dial\s+(\d+(?:\.\d+)?)$/.exec(input);
			if (manual) {
				const value = clamp(Number(manual[1]), this.config.minDial, this.config.maxDial);
				this.setDial(value);
				const model = this.recent[0]?.model ?? "deepseek-*";
				return {
					kind: "success",
					text: `⚡ 滑阻已手动拨到 R=${value.toFixed(3)} ${renderRheostat(value)} → ${model} 输出预算 ≈ ${formatTokens(dialMaxTokens(this.baseMaxTokensFor(model), value))} tok`
				};
			}
			if (input !== "" && input !== "status") return {
				kind: "error",
				text: "用法:/liang(状态)、/liang reset(清零)、/liang dial <0.1-1>(手动拨片)、/liang sync(同步官网价)"
			};
			return {
				kind: "success",
				text: this.renderStatus()
			};
		}
		/** 渲染 /liang 状态文本(纯字符串)。 */
		renderStatus() {
			const { totals } = this.snapshot();
			const last = this.recent[0];
			const budget = dialMaxTokens(this.baseMaxTokensFor(last?.model ?? "deepseek-*"), this.dial);
			const windowCache = this.windowCacheRate();
			const avgCost = totals.calls > 0 ? totals.cost / totals.calls : 0;
			const avgOutput = totals.calls > 0 ? totals.outputTokens / totals.calls : 0;
			const defaultCurrency = this.prices[0]?.currency ?? "USD";
			const peakNow = isPeakHour(Date.now());
			const lines = [
				"⚡ 梁表 · 滑动变阻器",
				`目标:${this.config.providers.join("/")} × ${this.config.modelPatterns.join("/")} ${this.config.enabled ? "(激活)" : "(停用)"}`,
				`滑阻 R=${this.dial.toFixed(3)} ${renderRheostat(this.dial)}  →  输出预算 ≈ ${formatTokens(budget)} tok`,
				`窗口(近 ${this.config.windowSize} 次):平均缓存率 ${(windowCache * 100).toFixed(1)}% · 均费 ${formatMoney(avgCost, defaultCurrency)} · 均输出 ${formatTokens(avgOutput)}`,
				`累计:${formatNumber(totals.calls)} 次 · 输出 ${formatTokens(totals.outputTokens)} tok · 输入+缓存 ${formatTokens(totals.inputTokens + totals.cacheReadTokens)} tok · 总费用 ${formatMoney(totals.cost, defaultCurrency)}`
			];
			lines.push(`价目:${this.priceSource === "synced" ? "官网同步" : "内置表"}${this.syncedAt !== null ? ` · ${new Date(this.syncedAt).toLocaleString("zh-CN", { hour12: false })}` : ""} · 货币 ${defaultCurrency} · 当前${peakNow ? "高峰" : "空闲"}价`);
			if (this.syncError !== null) lines.push(`⚠ 价格同步异常:${this.syncError}`);
			const distribution = TIER_ORDER.map((tier) => `${TIER_LABELS[tier]} ${formatNumber(this.rankCounts[tier])}`).join(" · ");
			lines.push(`评级分布:${distribution}`);
			if (this.recent.length > 0) {
				lines.push("── 最近 ──");
				for (const record of this.recent.slice(0, 8)) {
					lines.push(`  ${TIER_LABELS[record.rank]}  ${formatTokens(record.outputTokens)} tok · 缓存 ${(record.cacheRate * 100).toFixed(1)}% · ${formatMoney(record.cost, record.price?.currency)} · 得分 ${Math.round(record.score)}`);
				}
			}
			return lines.join("\n");
		}
	};
})();

export { LiangRheostatService, LiangRheostatService as default, Config, name };
