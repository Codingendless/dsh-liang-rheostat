/**
 * 运行时冒烟:在 mock 的 cordis ctx 上执行 bundle 的 apply(),验证不抛错、
 * 订阅与槽注册都发生。补 VM 工厂测试覆盖不到的部分(apply 运行期)。
 * 运行:node test/runtime-smoke.mjs
 */
import { readFileSync } from "node:fs";
import vm from "node:vm";

let captured = null;
const events = {
  envelopes: [],
  slotRegs: []
};
const mockCtx = {
  get(name) {
    if (name === "connection") {
      return {
        api: {
          subscribeEnvelopes(listener) {
            events.subscribe = listener;
            // 模拟一条 target assistant/message 事件
            queueMicrotask(() => listener([{
              payload: {
                type: "session/event",
                sessionId: "sess-1",
                event: {
                  type: "assistant/message",
                  seq: 42,
                  time: Date.now(),
                  data: {
                    message: { id: "msg-1", source: { provider: "deepseek-official", model: "deepseek-v4-flash" } },
                    usage: { inputTokens: 100, cacheReadTokens: 500000, outputTokens: 741 }
                  }
                }
              }
            }]));
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
// 等待模拟事件被处理
await new Promise((r) => setTimeout(r, 50));
console.log("SMOKE DONE");
