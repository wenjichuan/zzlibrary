/** Hono 环境类型：app 级注入的设置/会话管理器/DB 与认证中间件产物。 */
import type { DatabaseSync } from "node:sqlite";
import type { Settings } from "./config";
import type { SessionManager } from "./security";

export interface Env {
  Variables: {
    settings: Settings;
    sessions: SessionManager;
    db: DatabaseSync;
    username: string;
  };
}
