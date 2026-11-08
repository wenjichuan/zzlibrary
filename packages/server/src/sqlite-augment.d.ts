/** node:sqlite 类型增广：查询结果按行接口直接断言（行形状由调用处保证）。
 * 只放宽 all/get/run 的返回类型，不改变运行时行为。 */
declare module "node:sqlite" {
  interface StatementSync {
    all(...params: unknown[]): any[];
    get(...params: unknown[]): any;
    run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  }
}
