#!/usr/bin/env node
/** 服务端打包：esbuild 单文件 bundle → dist-server/index.js + sharp 运行时闭包（平台原生件）。
 *
 * 产物布局：dist-server/index.js + dist-server/node_modules/{sharp, @img/*, ...}
 * 运行时根解析（config.ts resolveRoot）：dist-server 的父目录即应用根——zip 解压即跑、Docker 零配置。
 * 平台件按当前 process.platform/arch 选择（Windows 上出 win32-x64，Docker linux 构建阶段出 linux-x64）。 */
import { build } from "esbuild";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "dist-server");
const NM = join(ROOT, "node_modules");

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
// ESM 声明（仓库根 package.json 无 type 字段——避免 Node 重解析警告）
writeFileSync(join(OUT, "package.json"), JSON.stringify({ type: "module", private: true }, null, 2) + "\n", "utf-8");

await build({
  entryPoints: [join(ROOT, "packages", "server", "src", "index.ts")],
  outfile: join(OUT, "index.js"),
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  external: ["sharp"],
  sourcemap: false,
  logLevel: "info",
});

// —— sharp 运行时闭包拷贝（dependencies 全量 + optionalDependencies 按当前平台过滤）——
const platTag = `-${process.platform}-${process.arch}`;
const outNm = join(OUT, "node_modules");
const copied = new Set();

function copyPkg(name) {
  if (copied.has(name)) return;
  const src = join(NM, name);
  const pkgFile = join(src, "package.json");
  if (!existsSync(pkgFile)) return; // 内置模块或缺失（optional 未装）
  copied.add(name);
  cpSync(src, join(outNm, ...name.split("/")), { recursive: true });
  const pkg = JSON.parse(readFileSync(pkgFile, "utf-8"));
  for (const dep of Object.keys(pkg.dependencies ?? {})) copyPkg(dep);
  for (const opt of Object.keys(pkg.optionalDependencies ?? {})) {
    // @img/* 平台件：仅拷贝匹配当前 os+arch 的（sharp-win32-x64 / sharp-linux-x64 / sharp-libvips-linux-x64…）
    if (opt.startsWith("@img/sharp") && !opt.includes(platTag)) continue;
    copyPkg(opt);
  }
}

copyPkg("sharp");

// 记录清单（调试/审计用）
writeFileSync(
  join(OUT, "native-packages.txt"),
  [...copied].sort().join("\n") + "\n",
  "utf-8",
);
console.log(`dist-server 完成：index.js + ${copied.size} 个原生运行时包（${process.platform}-${process.arch}）`);
