#!/usr/bin/env node
/** 组装 server 直跑分发包（zip）：dist-server + web/dist + 启动脚本 + 部署说明。
 * 产物：dist-release/zzlibrary-server-<version>-<platform>.zip
 * 依赖：先跑 scripts/build-server.mjs 与 web 构建（本脚本会代跑）。 */
import { execSync } from "node:child_process";
import { cpSync, createWriteStream, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { zip } from "fflate";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT_DIR = join(ROOT, "dist-release");
const version = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8")).version ?? "0.0.0";
const platform = `${process.platform === "win32" ? "win" : process.platform}-${process.arch}`;
const STAGE = join(OUT_DIR, "zzlibrary-server");

console.log("① web 构建");
execSync("npm run build", { cwd: join(ROOT, "web"), stdio: "inherit" });

console.log("② server 打包");
execSync("node scripts/build-server.mjs", { cwd: ROOT, stdio: "inherit" });

console.log("③ 组装发布目录");
rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(join(STAGE, "web"), { recursive: true });
cpSync(join(ROOT, "dist-server"), join(STAGE, "dist-server"), { recursive: true });
cpSync(join(ROOT, "web", "dist"), join(STAGE, "web", "dist"), { recursive: true });

// 启动脚本（ZZLIB_ROOT 显式锚定；zip 解压到任意位置均可用——bundle 内置 dist-server 父目录根解析，双保险）
const bat = `@echo off
chcp 65001 >nul
rem zzlibrary 服务端启动（需 Node 22.5+，推荐 24+）
where node >nul 2>nul || (echo [错误] 未找到 Node，请先安装 Node.js 22.5 或更高版本 https://nodejs.org & pause & exit /b 1)
for /f "tokens=1 delims=v." %%v in ('node --version') do set NV=%%v
if %NV% LSS 22 (
  echo [错误] Node 版本过低（当前 v%NV%），需要 22.5+，请到 https://nodejs.org 升级
  pause & exit /b 1
)
set ZZLIB_ROOT=%~dp0
set ZZLIB_PORT=8000
echo zzlibrary 服务端启动中 → http://localhost:8000  （数据目录：%~dp0data）
start "" http://localhost:8000
node "%~dp0dist-server\\index.js"
pause
`;
mkdirSync(join(STAGE), { recursive: true });
await (await import("node:fs")).promises.writeFile(join(STAGE, "start-windows.bat"), bat.replace(/\n/g, "\r\n"), "utf-8");

const sh = `#!/bin/sh
# zzlibrary 服务端启动（需 Node 22.5+，推荐 24+）
cd "$(dirname "$0")" || exit 1
export ZZLIB_ROOT="$PWD"
export ZZLIB_PORT="\${ZZLIB_PORT:-8000}"
echo "zzlibrary → http://localhost:\${ZZLIB_PORT}  (数据目录: \$PWD/data)"
exec node dist-server/index.js
`;
await (await import("node:fs")).promises.writeFile(join(STAGE, "start-linux.sh"), sh, { mode: 0o755 }, "utf-8");

// 部署说明
const deploy = await (await import("node:fs")).promises.readFile(join(ROOT, "DEPLOY.md"), "utf-8");
await (await import("node:fs")).promises.writeFile(join(STAGE, "部署说明.md"), deploy, "utf-8");

console.log("④ 压缩 zip");
const files = [];
(function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else files.push({ abs: p, rel: relative(STAGE, p) });
  }
})(STAGE);
const zipEntries = {};
for (const f of files) {
  // 顶层目录包裹：解压得到单个 zzlibrary-server/ 文件夹（不炸一地）
  zipEntries[`zzlibrary-server/${f.rel.split(sep).join("/")}`] = new Uint8Array(readFileSync(f.abs));
}
const zipName = `zzlibrary-server-${version}-${platform}.zip`;
await new Promise((resolve, reject) => {
  zip(zipEntries, { level: 6 }, (err, data) => {
    if (err !== null) reject(err);
    else {
      const ws = createWriteStream(join(OUT_DIR, zipName));
      ws.on("error", reject).on("finish", resolve).end(data);
    }
  });
});
const bytes = statSync(join(OUT_DIR, zipName)).size;
console.log(`完成：dist-release/${zipName}（${(bytes / 1024 / 1024).toFixed(1)} MB，${files.length} 个文件）`);
