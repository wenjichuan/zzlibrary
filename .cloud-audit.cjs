/** 云端人可读审计（一次性验收工具，不提交）：
 * 对照 fs 云目录与本地库（含快照）打印：总览 / 墓碑删除对照 / 活引用完整性 / 孤儿 blob / 搜索。
 * 用法：node .cloud-audit.cjs <云目录> [搜索词...]   （--db=path 可追加 uuid→名称映射库） */
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const root = process.argv[2];
if (!root || !fs.existsSync(path.join(root, "library.json"))) {
  console.error("用法: node .cloud-audit.cjs <云目录> [搜索词...]");
  process.exit(1);
}
const terms = [];
const dbs = [];
for (const a of process.argv.slice(3)) {
  if (a.startsWith("--db=")) dbs.push(a.slice(5));
  else terms.push(a);
}
// 自动并入：真库 + 全部快照（快照里有已删实体的 uuid→名称映射）
const auto = [
  path.join(__dirname, "data", "library.db"),
  ...fs
    .readdirSync("C:/Users/wenjch/wenjch/zzlibrary-snapshots")
    .filter((f) => f.endsWith(".db"))
    .map((f) => path.join("C:/Users/wenjch/wenjch/zzlibrary-snapshots", f)),
];
for (const d of auto) if (fs.existsSync(d) && !dbs.includes(d)) dbs.push(d);

const pkgName = new Map();
const fileInfo = new Map(); // fileUuid -> {name, pkgUuid}
for (const dbp of dbs) {
  try {
    let db;
    try {
      db = new DatabaseSync(dbp, { readOnly: true });
    } catch {
      db = new DatabaseSync(dbp);
    }
    for (const r of db.prepare("SELECT uuid, title FROM packages WHERE uuid IS NOT NULL").all())
      pkgName.set(r.uuid, r.title);
    for (const r of db
      .prepare("SELECT f.uuid u, f.name n, p.uuid pu FROM files f JOIN packages p ON p.id = f.package_id WHERE f.uuid IS NOT NULL")
      .all())
      if (!fileInfo.has(r.u)) fileInfo.set(r.u, { name: r.n, pkgUuid: r.pu });
    db.close();
  } catch (e) {
    console.log(`[库跳过] ${path.basename(dbp)}: ${e.message}`);
  }
}

// ---- 云端清单 ----
const kinds = {};
const dbDir = path.join(root, "db");
for (const kind of fs.readdirSync(dbDir)) {
  const kdir = path.join(dbDir, kind);
  if (!fs.statSync(kdir).isDirectory()) continue;
  kinds[kind] = [];
  for (const bucket of fs.readdirSync(kdir)) {
    const bdir = path.join(kdir, bucket);
    if (!fs.statSync(bdir).isDirectory()) continue;
    for (const f of fs.readdirSync(bdir)) {
      if (!f.endsWith(".json")) continue;
      try {
        kinds[kind].push(JSON.parse(fs.readFileSync(path.join(bdir, f), "utf-8")));
      } catch {
        /* 坏清单忽略 */
      }
    }
  }
}
const lib = JSON.parse(fs.readFileSync(path.join(root, "library.json"), "utf-8"));
const blobs = new Map();
const blobsDir = path.join(root, "blobs");
for (const pre of fs.readdirSync(blobsDir)) {
  for (const sha of fs.readdirSync(path.join(blobsDir, pre))) {
    blobs.set(sha, fs.statSync(path.join(blobsDir, pre, sha)).size);
  }
}

const live = (k) => (kinds[k] ?? []).filter((m) => !m.deleted);
const dead = (k) => (kinds[k] ?? []).filter((m) => m.deleted);
const fmt = (n) => (n / 1024 / 1024).toFixed(1) + " MB";
const nameOf = (uuid) => pkgName.get(uuid) ?? null;
const refState = (sha) =>
  blobs.has(sha) ? `仍在云端(${fmt(blobs.get(sha))})` : `已清除`;

// ---- 活引用完整性：活文件 sha + 活包封面 ----
const liveRefs = new Set();
for (const m of live("files")) liveRefs.add(m.data.sha256);
for (const m of live("packages")) if (m.data.coverSha256) liveRefs.add(m.data.coverSha256);
const missing = [...liveRefs].filter((s) => !blobs.has(s));

// ---- 孤儿 blob：不被任何活实体引用（含墓碑记账的 GC 候选 + 无主）----
const tombRefs = new Set();
for (const k of Object.keys(kinds))
  for (const m of dead(k))
    for (const r of m.data?.blobRefs ?? []) tombRefs.add(r.sha256);
const orphans = [...blobs.keys()].filter((s) => !liveRefs.has(s));

// ================= 报告 =================
const out = [];
out.push(`云端审计 · ${root}`);
out.push(`根索引 revision=${lib.revision} · blob ${blobs.size} 个 / ${fmt([...blobs.values()].reduce((a, b) => a + b, 0))}`);
out.push("");
out.push("── 集合清单（活 / 墓碑）──");
for (const k of ["categories", "packages", "package-paths", "files", "progress", "segment-configs"])
  out.push(`  ${k.padEnd(15)} 活 ${String(live(k).length).padStart(4)} ｜ 墓碑 ${String(dead(k).length).padStart(3)}`);
out.push("");
out.push(`── 完整性 ──`);
out.push(`  活实体引用缺块：${missing.length}${missing.length ? " ⚠ " + missing.map((s) => s.slice(0, 12)).join(",") : " ✓ 无"}`);
out.push(`  孤儿 blob（无活引用，含墓碑记账待 GC）：${orphans.length} 个 / ${fmt(orphans.reduce((a, s) => a + blobs.get(s), 0))}`);
out.push(`    其中墓碑已记账 ${[...orphans].filter((s) => tombRefs.has(s)).length} 个 · 无主（旧格式墓碑期）${orphans.filter((s) => !tombRefs.has(s)).length} 个`);
out.push("");

out.push("── 删除对照（云端墓碑 → 名称，来自本地库/快照映射）──");
if (dead("packages").length + dead("files").length === 0) out.push("  （无墓碑）");
for (const m of dead("packages")) {
  out.push(`  [包墓碑] ${nameOf(m.uuid) ?? "(名称映射未找到)"} · uuid ${m.uuid.slice(0, 8)} · 删除于 ${m.updatedAt}`);
  for (const r of m.data?.blobRefs ?? []) out.push(`      封面块 ${r.sha256.slice(0, 12)} (${fmt(r.size)}) → ${refState(r.sha256)}`);
}
for (const m of dead("files")) {
  const fi = fileInfo.get(m.uuid);
  const pkg = fi ? nameOf(fi.pkgUuid) : null;
  out.push(`  [文件墓碑] ${fi?.name ?? "(名称映射未找到)"} （属 ${pkg ?? "?"}）· 删除于 ${m.updatedAt}`);
  for (const r of m.data?.blobRefs ?? []) out.push(`      内容块 ${r.sha256.slice(0, 12)} (${fmt(r.size)}) → ${refState(r.sha256)}`);
}
for (const k of ["categories", "package-paths", "progress", "segment-configs"])
  if (dead(k).length) out.push(`  （另有 ${dead(k).length} 个 ${k} 墓碑，无内容块记账）`);

if (terms.length) {
  out.push("");
  out.push("── 搜索 ──");
  for (const t of terms) {
    const rx = new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    let hit = 0;
    for (const m of kinds.packages ?? []) {
      const title = nameOf(m.uuid) ?? m.data?.title ?? "";
      if (!rx.test(title)) continue;
      hit++;
      out.push(`  ◉ ${title} · ${m.deleted ? "墓碑" : "活清单"} · revision 内 uuid ${m.uuid.slice(0, 8)}`);
      for (const f of (kinds.files ?? []).filter(
        (x) => x.data?.packageUuid === m.uuid || fileInfo.get(x.uuid)?.pkgUuid === m.uuid,
      )) {
        const nm = f.data?.name ?? fileInfo.get(f.uuid)?.name ?? "?";
        const sha = f.data?.sha256;
        out.push(
          `      ${f.deleted ? "✕" : "·"} ${nm} ${sha ? `块 ${sha.slice(0, 12)} → ${refState(sha)}` : "(墓碑无块信息)"}`,
        );
      }
    }
    if (!hit) out.push(`  「${t}」云端无匹配清单`);
  }
}

out.push("");
out.push("说明：墓碑=删除已传播到云端的正确形态；其内容块在「整理云端」+保留期(默认180天)后才物理删除。");
console.log(out.join("\n"));
