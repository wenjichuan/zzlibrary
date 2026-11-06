/** node:fs 版 RemoteStore（本地全量测试 / 桌面单机模拟）。
 * 独立子路径导出：主入口保持平台无关（浏览器/移动端打包不引入 node:fs）。 */
export { createFsStore } from "./remote/fs-store";
