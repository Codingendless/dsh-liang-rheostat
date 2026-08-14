/**
 * dsh-liang-rheostat-client-ui — 浏览器半边 bundle。
 *
 * 手写 UMD 工厂格式(与 @deepseek-ai/dsh-client-ui-message-feedback 的
 * client.js 同构):`window.__ModuleLoader__.load({ id, factory })`。
 * 只 require 平台 seed word("react" / "react/jsx-runtime"),无跨包 import。
 *
 * 功能:
 * 1. 启动时从同源 `/liang-prices.json` 拉取服务端同步的官网价目表(峰谷分段)与评分参数,
 *    失败回落内置兜底表——客户端显示与服务端 /liang 一致;
 * 2. 订阅 connection 的 envelope 流,对每个命中目标的 assistant/message 事件
 *    (带 usage)按事件时间(峰谷分段)折算费用并用同款引擎评级,写入不可变快照 store;
 * 3. **历史回填**:会话被订阅/打开时,用 `session.history` 分页拉取历史事件重算评级,
 *    重新打开的历史对话同样显示评级小字条;
 * 4. 向 `conversation.chat.assistant-actions` list 槽注册条目,在每条回复的
 *    action 行渲染一行评级(货币符号按价目条目)。
 */
window.__ModuleLoader__.load({
	id: "dsh-liang-rheostat-client-ui",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");

		//#region 引擎(与 dsh-liang-rheostat/lib/engine.js 逐条对齐)
		const TIER_LABELS = Object.freeze({
			liangzu: "👑 梁祖",
			liangshen: "🛐 梁神",
			liangsheng: "⛩️ 梁圣",
			liangzi: "🙂 梁子",
			laoliang: "🚔 牢梁",
			xiaonanliang: "🌱 小难梁"
		});
		function clamp(value, lo, hi) {
			return Math.min(hi, Math.max(lo, value));
		}
		function escapeRegExp(source) {
			return String(source).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		}
		function wildcardMatch(pattern, value) {
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
		function matchesAny(patterns, value) {
			return patterns.some((pattern) => wildcardMatch(pattern, value));
		}
		/** 与服务端默认配置一致:providers ["deepseek-official"] × modelPatterns ["deepseek-*"]。 */
		function isTarget(provider, model) {
			return provider === "deepseek-official" && matchesAny(["deepseek-*"], model);
		}
		/** 缓存命中率 = 缓存读 / (未缓存输入 + 缓存读 + 缓存写)。 */
		function cacheRateOf(usage) {
			const input = usage.inputTokens ?? 0;
			const read = usage.cacheReadTokens ?? 0;
			const write = usage.cacheWriteTokens ?? 0;
			const total = input + read + write;
			return total === 0 ? 0 : read / total;
		}
		/** 高峰时段(官网口径):UTC 01:00–04:00 与 06:00–10:00。 */
		function isPeakHour(time) {
			const hour = new Date(time).getUTCHours();
			return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10);
		}
		/** 按调用时间解析价目条目到生效的平面价(峰谷分段)。 */
		function resolvePriceForTime(entry, time) {
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
		/** 按模型解析价目:精确 id 优先,其次最长前缀,最后兜底。 */
		function resolvePrice(model, prices, defaultPrice) {
			for (const entry of prices) if (entry.id === model) return entry;
			let best = null;
			for (const entry of prices) if (model.startsWith(entry.id) && (best === null || entry.id.length > best.id.length)) best = entry;
			return best ?? defaultPrice;
		}
		/** 费用(每百万 token;缓存写按未命中价计费;峰谷按调用时间)。 */
		function callCost(usage, entry, time) {
			const resolved = resolvePriceForTime(entry, time);
			const input = usage.inputTokens ?? 0;
			const read = usage.cacheReadTokens ?? 0;
			const write = usage.cacheWriteTokens ?? 0;
			const output = usage.outputTokens ?? 0;
			return (input * resolved.inputPerM + read * resolved.cacheReadPerM + write * resolved.inputPerM + output * resolved.outputPerM) / 1e6;
		}
		/** 费用压力口径:只算「未命中输入 + 输出」,不含缓存读(缓存命中已在缓存率里奖励)。 */
		function pressureCost(usage, entry, time) {
			const resolved = resolvePriceForTime(entry, time);
			const input = usage.inputTokens ?? 0;
			const output = usage.outputTokens ?? 0;
			return (input * resolved.inputPerM + output * resolved.outputPerM) / 1e6;
		}
		/** 与服务端默认配置一致(评分阈值,单位随同步货币默认人民币;referenceCostPerKOutput=auto)。 */
		const DEFAULT_OPTIONS = Object.freeze({
			baseMaxTokens: 131072,
			referenceCostPerKOutput: "auto",
			expensiveThreshold: 0.035,
			tinyOutputTokens: 200,
			tinyCostCap: 0.007,
			wasteOutputTokens: 400,
			tiers: Object.freeze({ liangzu: 85, liangshen: 70, liangsheng: 55, liangzi: 35, laoliang: 18 })
		});
		/** 0–100 分:基准 50 + 缓存率(≤+25) + 产出体量(≤+20) + 微小输出 −20 + 费用压力(≤−25)。 */
		function scoreCall(usage, entry, options, time) {
			const output = usage.outputTokens ?? 0;
			const cacheRate = cacheRateOf(usage);
			const cost = callCost(usage, entry, time);
			const pressure = pressureCost(usage, entry, time);
			const reference = options.referenceCostPerKOutput === "auto"
				? resolvePriceForTime(entry, time).outputPerM / 1000
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
		/** 硬规则优先:又贵又拉 → 牢梁;微小且便宜 → 小难梁;其余按分数阈值。 */
		function rankOf(metrics, options) {
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
		function formatTokens(value) {
			const number = Number(value) || 0;
			if (number >= 1e6) return `${(number / 1e6).toFixed(2)}M`;
			if (number >= 1e3) return `${(number / 1e3).toFixed(1)}k`;
			return number.toLocaleString("en-US");
		}
		function formatMoney(value, currency) {
			const symbol = currency === "CNY" ? "¥" : "$";
			const number = Number(value) || 0;
			if (number >= 1) return `${symbol}${number.toFixed(3)}`;
			if (number >= 0.01) return `${symbol}${number.toFixed(4)}`;
			return `${symbol}${number.toFixed(6)}`;
		}
		//#endregion

		//#region 价目表(与服务端兜底一致;启动后尝试从 /liang-prices.json 换用同步表)
		/** 峰谷生效时间(UTC):2026-08-16 16:00。 */
		const EFFECTIVE_AT = Date.parse("2026-08-16T16:00:00Z");
		/** 内置兜底价目表(官网快照,人民币)。 */
		const FALLBACK_ENTRIES = Object.freeze([
			Object.freeze({
				id: "deepseek-v4-flash",
				currency: "CNY",
				inputPerM: 1,
				cacheReadPerM: 0.02,
				outputPerM: 2,
				segments: Object.freeze([Object.freeze({
					effectiveAt: EFFECTIVE_AT,
					peak: Object.freeze({ inputPerM: 3, cacheReadPerM: 0.1, outputPerM: 9 }),
					offPeak: Object.freeze({ inputPerM: 1.5, cacheReadPerM: 0.05, outputPerM: 4.5 })
				})])
			}),
			Object.freeze({
				id: "deepseek-v4-pro",
				currency: "CNY",
				inputPerM: 3,
				cacheReadPerM: 0.025,
				outputPerM: 6,
				segments: Object.freeze([Object.freeze({
					effectiveAt: EFFECTIVE_AT,
					peak: Object.freeze({ inputPerM: 9, cacheReadPerM: 0.3, outputPerM: 27 }),
					offPeak: Object.freeze({ inputPerM: 4.5, cacheReadPerM: 0.15, outputPerM: 13.5 })
				})])
			})
		]);
		const FALLBACK_DEFAULT = Object.freeze({ inputPerM: 1, cacheReadPerM: 0.02, outputPerM: 2, currency: "CNY" });
		//#endregion

		//#region 评级 store(不可变快照,供 useSyncExternalStore 使用)
		function createRatingStore() {
			let snapshot = new Map(); // key `${sessionId}:${messageId}` -> record
			const listeners = new Set();
			return {
				set(sessionId, messageId, record) {
					const key = `${sessionId}:${messageId}`;
					if (snapshot.get(key) === record) return;
					const next = new Map(snapshot);
					next.set(key, record);
					snapshot = next;
					for (const listener of [...listeners]) {
						try {
							listener();
						} catch {
							/* 观察者异常不得中断通知。 */
						}
					}
				},
				getSnapshot() {
					return snapshot;
				},
				subscribe(listener) {
					listeners.add(listener);
					return () => {
						listeners.delete(listener);
					};
				}
			};
		}
		//#endregion

		//#region 组件:一条评级小字条
		/**
		 * @param props.messageId - assistant-actions 槽 owner 给的最终消息 id。
		 * @param props.sessionId - 由 inject 传入的当前会话 id。
		 * @param props.useRating - 由 inject 提供的选择器 hook。
		 */
		function LiangRatingLine({ messageId, sessionId, useRating }) {
			const record = useRating((map) => map.get(`${sessionId}:${messageId}`));
			if (record === void 0) return null;
			const label = TIER_LABELS[record.rank] ?? record.rank;
			const text = `${label} · ${formatTokens(record.output)} tok · 缓存 ${(record.cacheRate * 100).toFixed(1)}% · ${formatMoney(record.cost, record.currency)} · 得分 ${Math.round(record.score)}`;
			return react_jsx_runtime.jsx("span", {
				"data-liang-rating": true,
				title: `${label} · 得分 ${Math.round(record.score)} · 输出 ${formatTokens(record.output)} tok · 缓存率 ${(record.cacheRate * 100).toFixed(1)}% · 费用 ${formatMoney(record.cost, record.currency)}`,
				style: {
					display: "inline-flex",
					alignItems: "center",
					marginLeft: "6px",
					fontSize: "12px",
					lineHeight: "16px",
					whiteSpace: "nowrap",
					color: "var(--dsw-alias-label-tertiary, rgba(128, 128, 128, 0.85))",
					opacity: 0.85
				},
				children: text
			});
		}
		//#endregion

		//#region 插件体
		/** 所需客户端服务。 */
		const inject = ["slots", "connection"];
		/**
		 * 订阅 envelope 流,把目标调用折算成评级写入 store;向
		 * conversation.chat.assistant-actions(list 槽,可叠加)注册条目。
		 * @param ctx - 客户端根 context。
		 */
		function apply(ctx) {
			const store = createRatingStore();
			// 价目表与评分参数:先用内置兜底,再从同源端点换用服务端同步表/配置。
			const priceState = {
				entries: FALLBACK_ENTRIES,
				defaultPrice: FALLBACK_DEFAULT,
				currency: "CNY",
				options: DEFAULT_OPTIONS
			};
			try {
				fetch("/liang-prices.json", { cache: "no-store" })
					.then((response) => (response.ok ? response.json() : null))
					.then((payload) => {
						if (payload === null || !Array.isArray(payload.entries) || payload.entries.length === 0) return;
						priceState.entries = payload.entries;
						priceState.defaultPrice = payload.defaultPrice ?? FALLBACK_DEFAULT;
						priceState.currency = payload.currency ?? "CNY";
						// 评分参数随服务端配置走,保证显示口径一致。
						if (payload.options !== null && typeof payload.options === "object") {
							priceState.options = {
								...DEFAULT_OPTIONS,
								...payload.options
							};
						}
					})
					.catch(() => {
						/* 保持内置兜底。 */
					});
			} catch {
				/* 保持内置兜底。 */
			}
			/** 给一个事件算评级并写入 store(实时与历史回填共用)。 */
			const rateEvent = (sessionId, event) => {
				if (event === null || typeof event !== "object" || event.type !== "assistant/message") return;
				const data = event.data ?? {};
				const usage = data.usage;
				if (usage === void 0) return;
				const messageId = data.message?.id;
				if (messageId === void 0) return;
				const source = data.message?.source ?? {};
				if (!isTarget(source.provider, source.model)) return;
				const time = typeof event.time === "number" ? event.time : Date.now();
				const entry = resolvePrice(source.model, priceState.entries, priceState.defaultPrice);
				const metrics = scoreCall(usage, entry, priceState.options, time);
				const rank = rankOf(metrics, priceState.options);
				store.set(sessionId, messageId, Object.freeze({
					rank,
					output: metrics.output,
					cacheRate: metrics.cacheRate,
					cost: metrics.cost,
					score: metrics.score,
					currency: entry.currency ?? priceState.currency
				}));
			};
			// 历史回填:会话打开/订阅时,用 session.history 分页拉取历史事件重算评级,
			// 让重开的历史对话也能显示评级小字条(store 键幂等,与实时事件不冲突)。
			const backfilled = new Set();
			const backfilling = new Set();
			const backfillSession = async (sessionId) => {
				if (backfilled.has(sessionId) || backfilling.has(sessionId)) return;
				backfilling.add(sessionId);
				try {
					const api = ctx.get("connection")?.api;
					if (api === void 0 || typeof api?.sessions?.history !== "function") return;
					let beforeSeq = void 0;
					for (let page = 0; page < 100; page++) {
						const { result } = await api.sessions.history({ sessionId, beforeSeq, maxMessages: 200 });
						if (result === null || typeof result !== "object" || result.ok !== true) break;
						const events = result.value?.events;
						if (!Array.isArray(events) || events.length === 0) break;
						for (const { event } of events) rateEvent(sessionId, event);
						if (result.value?.hasMore !== true) break;
						beforeSeq = events[0]?.event?.seq;
						if (beforeSeq === void 0) break;
					}
				} catch {
					/* 回填失败不影响实时评级。 */
				} finally {
					backfilling.delete(sessionId);
					backfilled.add(sessionId);
				}
			};
			let unsubscribe = () => {};
			try {
				const connection = ctx.get("connection");
				unsubscribe = connection.api.subscribeEnvelopes((batch) => {
					for (const envelope of batch) {
						const frame = envelope === null || typeof envelope !== "object" ? void 0 : envelope.payload;
						if (frame === void 0 || typeof frame !== "object") continue;
						// 会话被订阅/打开 → 回填历史评级;会话事件流里出现某会话也兜底触发一次。
						if (frame.type === "session/subscribed") {
							if (typeof frame.sessionId === "string") backfillSession(frame.sessionId);
							continue;
						}
						if (frame.type !== "session/event") continue;
						if (typeof frame.sessionId === "string" && !backfilled.has(frame.sessionId) && !backfilling.has(frame.sessionId)) {
							backfillSession(frame.sessionId);
						}
						rateEvent(frame.sessionId, frame.event);
					}
				});
			} catch (error) {
				console.error("[dsh-liang-rheostat-client-ui] envelope subscription failed:", error);
			}
			ctx.effect(() => () => unsubscribe(), "dsh-liang-rheostat-client-ui: envelope unsubscribe");
			ctx.slots.inject("conversation.chat.assistant-actions", () => ctx.slots.register({
				name: "conversation.chat.assistant-actions",
				id: "dsh-liang-rheostat-client-ui",
				order: 20,
				inject: (sessionId) => ({
					sessionId,
					hooks: {
						// hooks 的 source 必须是可观察对象 {subscribe, getSnapshot},
						// 由渲染器包装成 useRating(selector) 选择器 hook。
						rating: {
							subscribe: store.subscribe,
							getSnapshot: store.getSnapshot
						}
					}
				})
			}, LiangRatingLine));
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
