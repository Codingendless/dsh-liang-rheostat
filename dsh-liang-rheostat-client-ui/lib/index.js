/**
 * dsh-liang-rheostat-client-ui — node half(纯 UI 插件)。
 *
 * 空 apply 仅让本包出现在 host cordis.yml / Loader 中;浏览器半边通过
 * package.json 的 dsh.client 声明与 exports["./client"] 提供,由
 * client-modules 在每次页面请求时注入 boot manifest(无需重建 web bundle)。
 */
/** Host 插件体 — 无 host 侧行为。 */
export function apply() {}
