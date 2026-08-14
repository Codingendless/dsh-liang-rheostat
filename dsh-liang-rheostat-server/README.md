# dsh-liang-rheostat-server — DeepSeek 梁表 · 滑动变阻器(服务端)

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件:**当会话使用 DeepSeek 本身平台(默认 `deepseek-official` provider)的模型时**,
根据每次调用的 **Token 输出、缓存命中率、消耗、费用**自动给出互联网讲法的评级
(**梁祖 / 梁神 / 梁圣 / 梁子 / 牢梁 / 小南梁**),并像**滑动变阻器**一样自动滑动一根 dial,
动态调节下一次请求的 `max_tokens` 输出预算:表现好就放宽(省心),又贵又拉就收紧(省钱)。

价格**自动同步 DeepSeek 官方定价页**,并按官网的**峰谷分段计价**(高峰 / 空闲,空闲半价)
与**调用发生时间**取价——官网改价、切换计费时段,本插件自动跟随。

> 「梁」= DeepSeek 的互联网昵称(取自创始人梁文锋);「牢梁」指被关起来/拉了胯的状态,
> 「小南梁」指小卡拉米式的一句废话输出。档位与阈值全部可配。

---

## 它做什么

```
deepseek-official / deepseek-v4-flash  输出 1,204 tok · 缓存率 87.2% · 费用 $0.00037 · 得分 76 → 🛐 梁神 · 滑阻 R=0.62 [============|--------] (Δ+0.040)
```

1. **计量** — 监听 `session/event`,对每次带 usage 的模型调用折算:
   - 输出 token(`outputTokens`)
   - 缓存命中率 = `cacheReadTokens / (inputTokens + cacheReadTokens + cacheWriteTokens)`
   - 费用(按**官网同步价**折算,缓存写按未命中价计费,峰谷按调用时间取价)
   - 综合得分 0–100(缓存率 ≤+25、产出体量 ≤+20、微小输出 −20、费用压力 ≤−25;
     费用压力只按「未命中输入 + 输出」计,缓存读不计入——缓存命中已在缓存率里奖励,不重复惩罚)
2. **评级** — 按得分与硬规则映射到六档(称谓/阈值可配):

   | 档位 | 语义 | 默认触发 |
   |---|---|---|
   | 👑 梁祖 | 封神之祖,好到可以刻碑 | 得分 ≥ 85 |
   | 🛐 梁神 | 神了,又快又省 | 得分 ≥ 70 |
   | ⛩️ 梁圣 | 圣质如初,稳中向好 | 得分 ≥ 55 |
   | 🙂 梁子 | 平平无奇,正常发挥 | 得分 ≥ 35 |
   | 🚔 牢梁 | 被关起来了,又贵又拉 | 费用超阈值且输出 < 400 tok;或得分 < 35 |
   | 🌱 小南梁 | 小卡拉米,一句废话式输出 | 输出 < 200 tok 且费用低于上限 |

3. **滑动变阻器** — 维护一根 dial(输出预算系数,默认 0.25–1.0):
   - 每次调用后按评级拉动:`梁祖 +0.06 / 梁神 +0.04 / 梁圣 +0.02 / 梁子 0 / 牢梁 −0.06 / 小南梁 −0.02`,
     并按近 12 次窗口平均缓存率微调(缓存高 → 上调,缓存低 → 下调),夹在 `[minDial, maxDial]`;
   - 调节点挂在 `agent/request` waterfall(最外层),只改 `max_tokens`:
     `max_tokens = max(256, round(baseMaxTokens × dial))`;已有显式更小的 `maxTokens` 时尊重它,不抬升;
   - 该值会写进 request header(配置变更日志),对缓存稳定性友好;只影响 agent 主循环请求。

4. **官网价格自动同步**:
   - 启动时抓取 DeepSeek 官方定价页,解析模型 × 缓存命中/未命中/输出单价;
   - 每 24 小时自动重同步;解析/抓取失败自动回落**内置价目表**并记录原因,不影响运行;
   - `/liang sync` 可手动强制同步;`/liang` 状态里会显示「价目:官网同步 / 内置表 · 货币 · 当前高峰/空闲价」。

5. **峰谷分段计价**:
   - 官网执行峰谷定价:高峰时段为 UTC 01:00–04:00 与 06:00–10:00(即北京 9:00–12:00、14:00–18:00),
     其余为空闲时段,**空闲价格 = 高峰的一半**;
   - 定价页会给出「当前平面价」与「生效日后的峰谷价」两张表,插件同时解析:生效日前按平面价,
     生效后按调用发生时间取高峰/空闲价;
   - 峰值/空闲切换自动发生,历史调用按各自发生时间回溯计价,不做事后重算。

## 安装

```sh
# 安装到 profile(例:web)
dsh plugin --profile web add <本目录绝对路径>

# 重启 web 后,聊天里可用斜杠命令:
/liang            # 查看滑阻状态、累计、评级分布、最近调用、价目同步情况
/liang reset      # 清零窗口/评级/累计,滑阻回初始位
/liang dial 0.8   # 手动拨片,直接设定滑阻
/liang sync       # 手动强制同步官网价格

# 浏览器端展示(可选):再装一个包,聊天里每条回复下方显示评级行
dsh plugin --profile web add <dsh-liang-rheostat-client-ui 目录>

# 日志里每条调用一行评级;其他插件可监听事件:
#   ctx.on("liang/call", record => ...)  每次调用
#   ctx.on("liang/dial", ({dial, previousDial, reason}) => ...) 滑阻变化
# 或注入服务:ctx.inject(["liangRheostat"], ...) → ctx.liangRheostat.snapshot()
```

**卸载**:`dsh plugin --profile web remove dsh-liang-rheostat-server`。

## 配置

在 profile 的 `cordis.patch.yml`(或 `--patch` 覆盖层)里按 id `liang-rheostat` 覆盖。
以下为本插件 bundle 提供的默认配置(用户层可整体覆盖,最后写入者胜):

```yaml
- id: liang-rheostat
  config:
    enabled: true
    providers: ['deepseek-official']        # 视为 DeepSeek 平台的 provider 路由
    modelPatterns: ['deepseek-*']           # 模型通配符,'*' 任意匹配
    windowSize: 12                          # 滑动窗口(最近 N 次)
    initialDial: 0.6                        # 初始 dial
    minDial: 0.25                           # dial 下限
    maxDial: 1                              # dial 上限
    baseMaxTokens: 131072                   # 通用 max_tokens 基准
    tinyOutputTokens: 200                   # 「小」的输出阈值
    tinyCostCap: 0.007                      # 「小」的费用上限(单位随同步货币,默认人民币)
    wasteOutputTokens: 400                  # 「牢」的输出上限
    expensiveThreshold: 0.035               # 「贵」的费用阈值(单位随同步货币,默认人民币)
    referenceCostPerKOutput: auto           # 每千输出 token 的参考费用;"auto"=该模型输出单价/1000
    defaultPrice:                           # 兜底单价(官网未覆盖的未知模型,人民币)
      inputPerM: 1
      cacheReadPerM: 0.02
      cacheWritePerM: 1
      outputPerM: 2
      currency: CNY
    prices: []                              # 官网未覆盖模型的补充价(精确 id 优先,其次最长前缀)
    sync:                                   # 官网价格自动同步
      enabled: true
      url: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/'   # 官方定价页(中文,人民币);美元版可换英文地址
      intervalHours: 24
      timeoutMs: 15000
      overrides: {}                         # 手动覆盖:{ 'deepseek-v4-flash': { inputPerM: 1.2 } }
    tiers: { liangzu: 85, liangshen: 70, liangsheng: 55, liangzi: 35, laoliang: 18 }
    logEveryCall: true
```

### 价目与峰谷说明

- 价目单位是「每百万 token」,默认同步**中文官方定价页(人民币,`currency: CNY`,显示 `¥`)**;
  想按美元计可把 `sync.url` 换成英文定价页地址(显示 `$`);
- 评分阈值(`tinyCostCap` / `expensiveThreshold`)**单位随同步货币**:人民币量级默认 `¥0.007` / `¥0.035`,
  美元量级约为 `$0.001` / `$0.005`(`referenceCostPerKOutput: auto` 自动随输出单价缩放,与货币无关);
- 官网同步表**优先于** `prices` 里同 id 的配置条目(官网为权威);`sync.overrides` 可对单个模型显式压顶(会同时清除该模型的峰谷分段);
- 峰谷切换由**调用发生时间**决定:如 2026-08-16 16:00 UTC(北京 08-17 00:00)起,flash 高峰
  ¥3/¥0.1/¥9(未命中/命中/输出)、空闲 ¥1.5/¥0.05/¥4.5;
- 若官网定价页结构变动导致解析失败,插件保持上一次成功同步的表;从未同步成功则使用**内置兜底表**(随插件版本快照官网价,人民币)。

### 浏览器端显示一致性

聊天界面那行评级由 `dsh-liang-rheostat-client-ui` 浏览器插件重算。它启动时从同源端点
`/liang-prices.json` 拉取服务端当前**价目表(含峰谷分段)与评分参数(阈值/tiers)**,再按事件时间取价,
因此与服务端 `/liang` 完全同口径。若你在配置里改了价目或阈值,刷新页面后浏览器端会自动跟随。

## 设计说明

- **为什么只动 `max_tokens`?** 它是唯一不改变请求语义、又能直接控制费用上限的输出预算旋钮;
  `temperature`/`reasoningEffort` 会改变采样分布与推理成本,默认不动,保持可预期。
- **为什么挂在 `agent/request`?** 该 waterfall 的结果会进入 request header 并被复用,
  修改一处即可对后续请求稳定生效(缓存稳定性友好),且能拿到最终 provider/model。
- **统计口径**:只统计「带 provider usage 的 `assistant/message`」,即 agent 主循环的真实模型往返;
  标题生成、web 搜索等旁路调用不计入。
- **非 DeepSeek 平台**:其他 provider(如 pi-ai 网关)完全不介入,插件休眠。
- **滑阻只夹小、不抬升**:已有会话的 header 里 `maxTokens` 被夹小后,即使 dial 升上去也不会抬回
  (避免打乱已建立的前缀缓存);放宽只对新会话或未显式设 `maxTokens` 的请求生效。

## 开发与测试

```sh
# 纯逻辑引擎自检(无子进程、无外部依赖,受限沙箱内也可跑)
node test/selftest.mjs

# node:test 套件(引擎 + 官网价解析 + 服务级回归)
node --test test/engine.test.js test/prices.test.js test/service.test.js
```

- `lib/engine.js` — 纯函数引擎(打分、评级、滑阻、峰谷取价、格式化),无依赖;
- `lib/prices.js` — 官网价抓取与解析(中/英文页均支持)、内置兜底表、合并/覆盖规则;
- `lib/index.js` — cordis 插件本体(事件监听、waterfall 调节、价格同步、`/liang` 命令、`/liang-prices.json` 端点)。

## 依赖与解析说明

运行时依赖 `@deepseek-ai/cordis`、`@deepseek-ai/schemastery` 已在 `package.json` 声明;
宿主 DSH profile 的 `node_modules`(或 `$DSH_HOME/profiles/node_modules` 的安装闭包回退)也能提供它们。
当通过 `link:` 方式安装(如 `dsh plugin --profile web add <本目录>`,pnpm 默认用 `link:`)时,
插件模块的真实路径在仓库内,Node 会沿真实路径向上解析依赖——因此**从插件包目录向上(直到工作区根)
需能解析到这两个包**,工作区根的 `node_modules` 提供指向它们的联结
(与 DSH 自身的 fallback 机制同款,`New-Item -ItemType Junction` 即可)。
若改用 `file:` 规范安装,则由 pnpm 在 store 内自建依赖,无需该联结。

## 许可证

[MIT](./LICENSE) · SPDX: `MIT`
