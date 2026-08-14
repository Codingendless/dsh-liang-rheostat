# dsh-liang-rheostat-client-ui — 梁表浏览器端展示

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的**纯客户端插件**(浏览器半边):
在 web GUI 的**每条模型回复底部显示一行评级小字条**,例如:

```
⛩️ 梁圣 · 435 tok · 缓存 99.9% · ¥0.009 · 得分 64
```

它是 [`dsh-liang-rheostat-server`](../dsh-liang-rheostat-server/README.md) 服务端插件的**展示伴侣**:服务端负责记账、评级、
滑阻与 `/liang` 命令(评级在日志和 `/liang` 里),本插件把同一份评级渲染到聊天界面。
数据不依赖服务端插件发事件——**直接从会话事件流里取 usage,用同一套引擎与价目表重算**,因此
离线也能算、两端口径一致。

## 特性

- **实时显示**:每条回合尾部的 action 行出现评级小字条,悬停可见完整明细(得分/输出/缓存率/费用);
- **与服务端口径一致**:启动时从同源端点 `/liang-prices.json` 拉取服务端同步的**官网价目表**
  (含峰谷分段),按调用发生时间取高峰/空闲价——`/liang` 怎么算,聊天里就怎么显示;
- **同款引擎**:评分/评级公式与 `dsh-liang-rheostat-server/lib/engine.js` 逐条对齐,无偏差;
- **零服务端改动**:纯浏览器 bundle,不新增任何 server 逻辑、不占网络(只拉一次价目表)。

## 安装

```sh
# 需先安装服务端插件 dsh-liang-rheostat-server(价目表端点由其提供)
dsh plugin --profile web add <dsh-liang-rheostat-server 目录>
# 再装本插件
dsh plugin --profile web add <本目录绝对路径>

# 重启 web,硬刷新页面(Ctrl+Shift+R)后生效
```

> 本包通过 `dsh.client` 声明挂载为浏览器插件(client-modules 会在每次页面请求时把它的 bundle
> 注入 `__DSH_BOOT__`),**无需重建 web 前端产物**;服务端半边为空 apply,仅为让 loader 识别。

## 工作原理

```
DeepSeek API 响应 → session/event(assistant/message + usage)
        │
        ▼ 浏览器端(本插件)
1. connection.api.subscribeEnvelopes 订阅会话事件流
2. 命中 deepseek-official × deepseek-* 且有 usage 的事件:
   · 按事件时间解析价目条目(峰谷分段:高峰/空闲)
   · 用与服务端相同的 scoreCall/rankOf 打分评级
3. 写入不可变快照 store(以 sessionId:messageId 为键)
4. 历史回填:会话被订阅/打开时,用 session.history 分页拉取历史事件重算评级
   → 重新打开的历史对话同样显示评级小字条
5. 注册进 conversation.chat.assistant-actions 槽(list 槽,可叠加)
   → 每条回复的 action 行渲染评级小字条
```

- **价目表**:启动时 `fetch("/liang-prices.json")`(服务端插件的同源端点,含评分参数);失败回落内置兜底表
  (deepseek-v4-flash / v4-pro 官网快照,含峰谷分段);
- **槽位**:`conversation.chat.assistant-actions` 是 list 槽,与 message-feedback 等条目并存,
  不遮蔽任何现有 UI;
- **历史回填**:长会话首次打开时按页拉取(每页最多 200 个事件),评级会稍晚几百毫秒出现,属正常;
  回填失败不影响实时评级。

## 文件

- `lib/client.js` — 浏览器 bundle(手写 UMD 工厂格式,仅依赖 `react` / `react/jsx-runtime` 平台 seed);
- `lib/index.js` — 服务端空半边(空 apply,仅让 loader 识别本包);
- `test/verify-client-bundle.mjs` — 自检:bundle 工厂执行、引擎公式与服务端对拍、真实会话数据跑分;
- `test/runtime-smoke.mjs` — 运行时冒烟:mock ctx 执行 apply,验证订阅/槽注册/历史回填触发。

## 开发与测试

```sh
# 引擎对拍 + 真实数据冒烟(需传一个会话 jsonl.zstd 路径)
node test/verify-client-bundle.mjs <session.jsonl.zstd>

# 语法检查
node --check lib/client.js
```

## 许可证

[MIT](./LICENSE) · SPDX: `MIT`
