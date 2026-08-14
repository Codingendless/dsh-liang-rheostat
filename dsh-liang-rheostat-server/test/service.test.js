/**
 * 服务级回归测试:命令结果形状(修复过:success.text 必须是字符串)与滑阻钳位。
 * 依赖 @deepseek-ai/cordis 可解析(在 workspace 根或插件目录已安装依赖时运行)。
 * 运行:node --test test/service.test.js
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { LiangRheostatService } from "../lib/index.js";

function makeService(config) {
	const ctx = new Context();
	return new LiangRheostatService(ctx, {
		// 测试环境不做官网同步(避免网络依赖)
		sync: { enabled: false },
		...config
	});
}

describe("LiangRheostatService 命令", () => {
	it("renderStatus 返回纯字符串且含价目行", () => {
		const svc = makeService();
		const status = svc.renderStatus();
		assert.equal(typeof status, "string");
		assert.ok(status.includes("滑动变阻器"));
		assert.ok(status.includes("滑阻 R="));
		assert.ok(status.includes("价目:"));
	});
	it("内置价目表含 flash/pro 与峰谷分段,overrides 压顶", () => {
		const svc = makeService({ sync: { enabled: false, overrides: { "deepseek-v4-flash": { inputPerM: 0.1 } } } });
		const flash = svc.prices.find((p) => p.id === "deepseek-v4-flash");
		assert.ok(flash);
		assert.equal(flash.inputPerM, 0.1);
		assert.equal(flash.segments, void 0);
		const pro = svc.prices.find((p) => p.id === "deepseek-v4-pro");
		assert.ok(pro);
		assert.equal(pro.segments.length, 1);
		assert.equal(svc.priceSource, "fallback");
	});
	it("/liang sync 分支返回 success 且不抛", async () => {
		const svc = makeService();
		const result = svc.onCommand({ rawInput: "sync" });
		assert.equal(result.kind, "success");
		assert.equal(typeof result.text, "string");
		await new Promise((resolve) => setTimeout(resolve, 50));
	});
	it("onCommand 各分支返回 {kind, text} 且 text 为字符串", () => {
		const svc = makeService();
		const cases = [
			["", "success"],
			["status", "success"],
			["reset", "success"],
			["dial 0.8", "success"],
			["bogus", "error"]
		];
		for (const [input, kind] of cases) {
			const result = svc.onCommand({ rawInput: input });
			assert.equal(result.kind, kind, `input=${JSON.stringify(input)}`);
			assert.equal(typeof result.text, "string", `input=${JSON.stringify(input)} text must be a string`);
			assert.ok(result.text.length > 0);
		}
	});
	it("手动拨片钳位到 [minDial, maxDial] 并改变下一次输出预算", () => {
		const svc = makeService({ minDial: 0.25, maxDial: 0.9 });
		svc.onCommand({ rawInput: "dial 2" });
		assert.equal(svc.dial, 0.9);
		svc.onCommand({ rawInput: "dial 0.01" });
		assert.equal(svc.dial, 0.25);
		const config = svc.onAgentRequest({ provider: "deepseek-official", model: "deepseek-v4-flash" });
		assert.equal(config.maxTokens, Math.round(131072 * 0.25));
	});
	it("非 DeepSeek provider 不做滑阻调节", () => {
		const svc = makeService();
		const config = svc.onAgentRequest({ provider: "opencode-go", model: "deepseek-v4-flash" });
		assert.equal(config.maxTokens, void 0);
	});
	it("未知配置键 fail loud", () => {
		assert.throws(() => makeService({ windowSizez: 5 }), /unknown key/);
	});
});
