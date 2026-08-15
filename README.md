# dsh-liang-rheostat — DeepSeek 梁表 · 滑动变阻器

> **DSH 插件** · 为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 打造。
> 按 token 输出 / 缓存命中率 / 费用给每次调用打评级(互联网讲法:梁祖 / 梁神 / 梁圣 / 梁子 / 牢梁 / 小难梁),
> 并像**滑动变阻器**一样自动调节 `max_tokens` 输出预算;价格**自动同步 DeepSeek 官网**,支持**峰谷分段计价**。

**仓库**:<https://github.com/Codingendless/dsh-liang-rheostat> · 话题:`dsh-plugin`

## 仓库结构

本仓库包含两个插件包,一服务端 + 一浏览器端,共同组成完整功能:

| 包 | 角色 | 说明 |
|---|---|---|
| [`dsh-liang-rheostat-server`](./dsh-liang-rheostat-server) | 服务端(核心) | 计量、评级、滑动变阻器、**官网价格自动同步 + 峰谷分段计价**、`/liang` 命令、`liang/call` / `liang/dial` 事件 |
| [`dsh-liang-rheostat-client-ui`](./dsh-liang-rheostat-client-ui) | 浏览器端(展示) | 在 web GUI 的每条回复下显示一行评级(数据来自会话事件,与服务端同款引擎、同款价目表) |

## 快速安装(web profile)

```sh
# 把两个包都装进 web profile(或只装服务端包,浏览器端可选)
dsh plugin --profile web add /path/to/dsh-liang-rheostat/dsh-liang-rheostat-server
dsh plugin --profile web add /path/to/dsh-liang-rheostat/dsh-liang-rheostat-client-ui

# 重启 web 后生效
# 聊天里可用的斜杠命令:
/liang          # 状态:滑阻、窗口、累计、评级分布、价目同步情况
/liang reset    # 清零窗口/评级/累计,滑阻回初始位
/liang dial 0.8 # 手动拨片
/liang sync     # 手动强制同步官网价格
```

## 特性一览

- **六档评级**:👑 梁祖 / 🛐 梁神 / ⛩️ 梁圣 / 🙂 梁子 / 🚔 牢梁 / 🌱 小难梁,阈值可配;
- **滑动变阻器**:按评级拉动 dial(输出预算系数),动态调节 `max_tokens`,夹在 `[minDial, maxDial]`;
- **官网价格自动同步**:启动 + 每 24h 抓取 DeepSeek 官方定价页,解析失败自动回落内置价目表;
- **峰谷分段计价**:按官网时段(高峰 / 空闲,空闲半价)与**调用发生时间**取价,生效日期自动切换;
- **浏览器端评级展示**:web GUI 每条回复下显示一行 `⛩️ 梁圣 · 435 tok · 缓存 99.9% · ¥0.009 · 得分 64`;
- **缓存友好**:只动 `max_tokens`,不改变采样分布;调节结果写进 request header,前缀缓存稳定。

## 兼容性声明

- 两个包均在 `package.json` 声明 `dsh` 字段(`dsh.bundle` / `dsh.client`),满足 dsh.so 的 DSH 兼容声明标准;
- 实测环境:DeepSeek Harness `0.1.0-rc.6`、web profile、`deepseek-official × deepseek-*`(deepseek-v4-flash / v4-pro);
- 提交 GitHub 时请为仓库添加 **`dsh-plugin`** 话题,便于 dsh.so 自动索引。

## 文档

- [服务端插件 README](./dsh-liang-rheostat-server/README.md)——安装、配置、命令、分档设计、架构;
- [浏览器端插件 README](./dsh-liang-rheostat-client-ui/README.md)——安装、数据流、实现说明。

## 许可证

[MIT](./LICENSE) · SPDX: `MIT`
