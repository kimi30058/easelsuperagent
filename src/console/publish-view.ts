/** Shared view predicates over /api/publish views: the publish cards and the login modal's soft hint read liveness alike. */
export interface PublishView {
  platform: string; state: string; message: string; ts?: number
  logTail: string; logMtime?: number
}
/** 与 publish-protocol.ts 的 TERMINAL_PUBLISH_STATES 同义：协议侧 import node:fs，客户端无法复用——新增终态须两边同改。 */
const TERMINAL = ['success', 'error']
export const stateLive = (view: PublishView): boolean => view.state !== 'unknown' && !TERMINAL.includes(view.state)
export const logFresh = (view: PublishView): boolean =>
  view.logMtime !== undefined && Date.now() - view.logMtime < 10 * 60_000
/** 日志新鲜度只兜没有状态文件的平台（xhs/bili/wechat）：已知状态（含终态）不被日志启发式压过。 */
export const live = (view: PublishView): boolean => stateLive(view) || (view.state === 'unknown' && logFresh(view))
