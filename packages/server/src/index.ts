/** 入口：zzlibrary TS server（替代 FastAPI；node:sqlite + hono）。 */
import { serve } from "@hono/node-server";
import { createApp } from "./http";
import { Settings } from "./config";

const settings = new Settings();
const app = createApp(settings);

serve({ fetch: app.fetch, port: settings.port }, (info) => {
  console.log(`zzlibrary server (TS) → http://localhost:${info.port}  (data: ${settings.dataDir})`);
});
