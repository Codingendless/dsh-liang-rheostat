/**
 * 运行时冒烟:在 mock 的 cordis ctx 上执行 bundle 的 apply(),验证不抛错、
 * 订阅/槽注册/历史回填都发生。补 VM 工厂测试覆盖不到的部分(apply 运行期)。
 * 运行:node test/runtime-smoke.mjs
 */
import { readFileSync } from "node:fs";
import vm from "node:vm";

let captured = null;
const events = {
  historyCalls: []
};
const HIST_EVENT = {
  type: "assistant/message",
  seq: 10,
  time: Date.now(),
  data: {
    message: { id: "msg-hist", source: { provider: "deepseek-official", model: "deepseek-v4-flash" } },
    usage: { inputTokens: 5, cacheReadTokens: 100, outputTokens: 300 }
  }
};
const LIVE_EVENT = {
  type: "assistant/message",
  seq: 42,
  time: Date.now(),
  data: {
    message: { id: "msg-live", source: { provider: "deepseek-official", model: "deepseek-v4-flash" } },
    usage: { inputTokens: 100, cacheReadTokens: 500000, outputTokens: 741 }
  }
};
const mockCtx = {
  get(name) {
    if (name === "connection") {
      return {
        api: {
          sessions: {
            history: async (payload) => {
              events.historyCalls.push(payload);
              return {
                result: { ok: true, value: { events: [{ event: HIST_EVENT }], hasMore: false } }
              };
            }
          },
          subscribeEnvelopes(listener) {
            events.subscribe = listener;
            // 模拟:先收到 session/subscribed(触发历史回填),再收到实时事件
            queueMicrotask(() => listener([
              { payload: { type: "session/subscribed", sessionId: "sess-1", lastSeq: 9 } },
              { payload: { type: "session/event", sessionId: "sess-1", event: LIVE_EVENT } }
            ]));
            return () => {};
          }
        }
      };
    }
    throw new Error("unexpected ctx.get(" + name + ")");
  },
  effect(fn) { events.effectFn = fn; },
  slots: {
    inject(key, callback) { events.slotInject = { key, callback }; }
  }
};

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
  queueMicrotask,
  fetch: async () => ({
    ok: true,
    json: async () => ({
      source: "synced",
      currency: "CNY",
      entries: [{ id: "deepseek-v4-flash", currency: "CNY", inputPerM: 1, cacheReadPerM: 0.02, outputPerM: 2 }],
      defaultPrice: { inputPerM: 1, cacheReadPerM: 0.02, outputPerM: 2, currency: "CNY" },
      options: { baseMaxTokens: 131072, referenceCostPerKOutput: "auto", expensiveThreshold: 0.035, tinyOutputTokens: 200, tinyCostCap: 0.007, wasteOutputTokens: 400, tiers: { liangzu: 85, liangshen: 70, liangsheng: 55, liangzi: 35, laoliang: 18 } }
    })
  })
};
vm.createContext(sandbox);
const code = readFileSync("./lib/client.js", "utf8");
vm.runInContext(code, sandbox);

console.log("exports:", Object.keys(captured.exports));
try {
  captured.exports.apply(mockCtx);
  console.log("apply() 执行 OK,无抛错");
} catch (error) {
  console.error("apply() 抛错:", error.message);
  process.exit(1);
}
console.log("订阅注册了:", typeof events.subscribe === "function");
console.log("槽注入注册了:", events.slotInject?.key === "conversation.chat.assistant-actions");
// 等待 session/subscribed 触发的历史回填与实时事件处理完成
await new Promise((r) => setTimeout(r, 100));
const hist = events.historyCalls[0];
console.log("历史回填触发:", Array.isArray(events.historyCalls) && events.historyCalls.length > 0);
console.log("history 参数:", hist !== void 0 ? `sessionId=${hist.sessionId} beforeSeq=${hist.beforeSeq} maxMessages=${hist.maxMessages}` : "(未调用)");
if (!events.historyCalls.some((p) => p.sessionId === "sess-1")) {
  console.error("FAIL: 未对已订阅会话发起历史回填");
  process.exit(1);
}
console.log("SMOKE DONE");
