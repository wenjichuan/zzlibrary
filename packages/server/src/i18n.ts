/** 服务端双语消息与展示词汇：按请求 Accept-Language 协商（缺省 zh）。
 *
 * 消息以稳定键承载、词句住本文件字典；web 的 fetch 同源自带浏览器 Accept-Language，
 * 用户在界面上主动选择的语言也经 localStorage 写入请求头（shared/client.ts）。
 * core 的展示词（公元前/未注明/其他）经 displayI18nOf 注入，core 本体不含多语言。 */
import { ZH_DISPLAY, type DisplayI18n } from "@zzlibrary/core";

export type Lang = "zh" | "en";

/** 请求上下文的最小结构（Hono Context 结构满足；便于测试直接构造）。 */
interface LangCtx {
  req: { header(name: string): string | undefined };
}

/** Accept-Language 协商：zh/en 前缀（忽略大小写）谁先出现用谁；两者皆无 → zh。 */
export function langOf(c: LangCtx): Lang {
  const tags = (c.req.header("Accept-Language") ?? "").split(",").map((t) => t.trim().toLowerCase());
  for (const tag of tags) {
    if (tag.startsWith("zh")) return "zh";
    if (tag.startsWith("en")) return "en";
  }
  return "zh";
}

// C2 先承载日期错误（DateParseError code）；C4 补齐全量路由消息。
const MESSAGES: Record<Lang, Record<string, string>> = {
  zh: {
    "date.format": "日期格式无效：'{value}'，应为 前221 / -221 / 221 BC / YYYY、YYYY-MM 或 YYYY-MM-DD",
    "date.yearZero": "没有公元 0 年：公元前一年请写「前1」（或 1 BC），公元一年请写「1」",
    "date.invalid": "日期无效：'{value}'",
    "err.unauthorized": "未登录或会话已过期",
    "auth.badCredentials": "用户名或密码错误",
    "backup.inProgress": "已有备份正在进行中，请稍候",
    "backup.destRequired": "请填写备份目标目录",
    "backup.nested": "备份目录不能在数据目录内部",
    "file.notFound": "文件不存在",
    "prog.percentRange": "percent 需在 0~100",
    "prog.noProgress": "该文件没有进度记录",
    "pkg.multipartMissing": "缺少上传内容（multipart）",
    "pkg.filenameMissing": "缺少文件名",
    "pkg.noStageCover": "该文件没有可预览的封面",
    "pkg.stageIdsEmpty": "stage_ids 不能为空",
    "pkg.titleLen": "包名长度需在 1~500",
    "pkg.stageExpired": "暂存文件已过期（{id}…），请重新上传",
    "pkg.stageExpiredPlain": "暂存文件已过期，请重新上传",
    "pkg.statusFilter": "状态筛选无效",
    "pkg.qLen": "q 最长 200",
    "pkg.sortInvalid": "排序参数无效",
    "pkg.pageInvalid": "page 无效",
    "pkg.pageSizeRange": "page_size 需在 1~100",
    "pkg.catParamInvalid": "分类参数无效：{raw}",
    "pkg.noChanges": "没有任何变更",
    "pkg.fileNotInPkg": "文件 {id} 不在该包内",
    "pkg.removeLastBlock": "不能移除全部文件（保存将删除整个资料包请走整包删除）",
    "pkg.fileInPkgNotFound": "包内文件不存在",
    "pkg.removeOnlyFile": "不能移除包内唯一的文件：请删除整个资料包，或先添加新文件再移除",
    "pkg.noCover": "该文件没有封面",
    "pkg.bytesMissing": "文件缺失（磁盘上找不到该文件的字节）",
    "cat.nameLen": "名称长度需在 1~200",
    "cat.parentNotFound": "上级分类不存在",
    "cat.maxLevel": "最多支持三级分类",
    "cat.notFound": "分类不存在",
    "cat.targetNotFound": "目标上级分类不存在",
    "cat.hasChildrenMove": "该分类包含子分类，不能移动（请先移走子分类）",
    "cat.onlyL1Top": "只有一级分类可以移到顶层",
    "cat.levelMismatch": "「{name}」是{level}级分类，只能移到同级分类之下",
    "cat.selfParent": "不能把自己作为上级",
    "cat.hasChildrenDelete": "该分类包含子分类，请先删除子分类",
    "seg.nYearsParam": "n_years 模式需要在 params.n 提供 1~100 的整数",
    "seg.rangesMissing": "custom 模式需要在 params.ranges 提供至少一个区间",
    "seg.rangeInvalid": "区间格式无效：{raw}（需要 start/end，支持 YYYY / YYYY-MM / YYYY-MM-DD；alias 可选）",
    "seg.modeInvalid": "分段方式无效",
    "seg.l2NotFound": "二级分类不存在",
    "seg.noL2Override": "该二级分类没有覆盖配置",
    "seg.l3NotFound": "三级分类不存在",
    "seg.noL3Override": "该三级分类没有覆盖配置",
    "shelves.l2Param": "l2 需为数字 id 或 none",
    "shelves.l1NotFound": "一级分类不存在",
    "err.l3NotFound": "三级分类不存在",
    "err.l2NotFound": "二级分类不存在",
    "err.l3NotUnderL2": "三级分类「{l3}」不属于二级分类「{l2}」",
    "err.l1NotFound": "一级分类不存在",
    "err.l2NotUnderL1": "二级分类「{l2}」不属于一级分类「{l1}」",
    "err.pathNeedsL1": "分类路径必须包含一级分类",
    "err.pkgNotFound": "资料包不存在",
    "err.multipartBoundary": "multipart boundary 缺失",
    "err.multipartMalformed": "multipart 格式异常（边界后定界符）",
    "err.multipartHeaderCap": "multipart part 头超限",
    "err.multipartTruncated": "multipart 意外截断（缺少结束边界）",
  },
  en: {
    "date.format": "Invalid date format: '{value}'. Expected 221 BC / -221 / YYYY, YYYY-MM or YYYY-MM-DD",
    "date.yearZero": "There is no year 0: write \"1 BC\" (or 前1) for 1 BCE, or \"1\" for 1 AD",
    "date.invalid": "Invalid date: '{value}'",
    "err.unauthorized": "Not signed in or the session has expired",
    "auth.badCredentials": "Wrong username or password",
    "backup.inProgress": "A backup is already running — try again shortly",
    "backup.destRequired": "Enter a backup destination folder",
    "backup.nested": "The backup destination cannot be inside the data directory",
    "file.notFound": "File not found",
    "prog.percentRange": "percent must be 0–100",
    "prog.noProgress": "No progress record for this file",
    "pkg.multipartMissing": "Missing upload content (multipart)",
    "pkg.filenameMissing": "Missing filename",
    "pkg.noStageCover": "This staged file has no previewable cover",
    "pkg.stageIdsEmpty": "stage_ids cannot be empty",
    "pkg.titleLen": "Title length must be 1–500",
    "pkg.stageExpired": "Staged file expired ({id}…) — please upload again",
    "pkg.stageExpiredPlain": "Staged file expired — please upload again",
    "pkg.statusFilter": "Invalid status filter",
    "pkg.qLen": "q must be at most 200 characters",
    "pkg.sortInvalid": "Invalid sort parameter",
    "pkg.pageInvalid": "Invalid page",
    "pkg.pageSizeRange": "page_size must be 1–100",
    "pkg.catParamInvalid": "Invalid category parameter: {raw}",
    "pkg.noChanges": "Nothing to change",
    "pkg.fileNotInPkg": "File {id} is not in this package",
    "pkg.removeLastBlock": "Cannot remove all files (deleting the whole package is a package-level delete)",
    "pkg.fileInPkgNotFound": "File not found in this package",
    "pkg.removeOnlyFile": "Cannot remove the only file in the package: delete the whole package, or add another file first",
    "pkg.noCover": "This file has no cover",
    "pkg.bytesMissing": "File missing (bytes not found on disk)",
    "cat.nameLen": "Name length must be 1–200",
    "cat.parentNotFound": "Parent category not found",
    "cat.maxLevel": "Categories support at most 3 levels",
    "cat.notFound": "Category not found",
    "cat.targetNotFound": "Target parent category not found",
    "cat.hasChildrenMove": "This category has subcategories — move them out first",
    "cat.onlyL1Top": "Only top-level categories can move to the top",
    "cat.levelMismatch": "\"{name}\" is a level-{level} category and can only move under a same-level category",
    "cat.selfParent": "A category cannot be its own parent",
    "cat.hasChildrenDelete": "This category has subcategories — delete them first",
    "seg.nYearsParam": "n_years mode needs an integer 1–100 in params.n",
    "seg.rangesMissing": "custom mode needs at least one range in params.ranges",
    "seg.rangeInvalid": "Invalid range: {raw} (needs start/end; YYYY / YYYY-MM / YYYY-MM-DD; alias optional)",
    "seg.modeInvalid": "Invalid segmentation mode",
    "seg.l2NotFound": "Second-level category not found",
    "seg.noL2Override": "No override configured for this second-level category",
    "seg.l3NotFound": "Third-level category not found",
    "seg.noL3Override": "No override configured for this third-level category",
    "shelves.l2Param": "l2 must be a numeric id or none",
    "shelves.l1NotFound": "Top-level category not found",
    "err.l3NotFound": "Third-level category not found",
    "err.l2NotFound": "Second-level category not found",
    "err.l3NotUnderL2": "Third-level category \"{l3}\" does not belong to second-level \"{l2}\"",
    "err.l1NotFound": "Top-level category not found",
    "err.l2NotUnderL1": "Second-level category \"{l2}\" does not belong to top-level \"{l1}\"",
    "err.pathNeedsL1": "A category path must include a top-level category",
    "err.pkgNotFound": "Package not found",
    "err.multipartBoundary": "Missing multipart boundary",
    "err.multipartMalformed": "Malformed multipart (delimiter after boundary)",
    "err.multipartHeaderCap": "Multipart part header too large",
    "err.multipartTruncated": "Multipart unexpectedly truncated (missing end boundary)",
  },
};

/** 取某语言的消息（{var} 插值；缺键回退中文再回退键名本身）。 */
export function msgFor(lang: Lang, key: string, vars?: Record<string, unknown>): string {
  let text: string = MESSAGES[lang]?.[key] ?? MESSAGES.zh[key] ?? key;
  if (vars !== undefined) {
    for (const [k, v] of Object.entries(vars)) text = text.replaceAll(`{${k}}`, String(v));
  }
  return text;
}

/** 取当前请求语言的消息。 */
export function msg(c: LangCtx, key: string, vars?: Record<string, unknown>): string {
  return msgFor(langOf(c), key, vars);
}

/** 分类层级词：一级/二级/三级 vs L1/L2/L3（cat.levelMismatch 的 {level} 用）。 */
export function levelWord(lang: Lang, level: number): string {
  return lang === "zh" ? "一二三"[level - 1]! : String(level);
}

/** 当前请求语言的 core 展示钩子（书架段带 / 公元前年 / 未注明）。 */
export function displayI18nOf(lang: Lang): DisplayI18n {
  return lang === "en"
    ? { bc: (y) => `${y} BC`, undated: "Undated", other: "Other" }
    : ZH_DISPLAY;
}
