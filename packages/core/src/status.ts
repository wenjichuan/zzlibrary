/** 包状态推导（自 Python services/status.py 平移；DB 遍历部分由 server 侧承担）。
 *
 * 由**可读文件**的阅读进度聚合；读多写少，status 作为物化缓存存列上，
 * 仅在写入事件（写进度、包内文件增删、入库）时重算受影响的包。
 */
import { isReadableFormat } from "./formats";

export const READ_DONE_THRESHOLD = 98.0;

export interface StatusFileInput {
  format: string;
  /** 阅读进度百分比；null = 无进度记录（未读） */
  percent: number | null;
}

/** 任一可读文件在读→reading；全部可读文件读完→done；全未读→unread。
 * 返回语言无关键（DB/API 存储值，显示层负责翻译）。
 * 不可读格式（无阅读深度，如 zip/bin 等未知格式，及暂无内置阅览的 pptx/xlsx）中性，不参与聚合；
 * 无可读文件的包 status=""（界面显示「—」）。
 */
export function computePackageStatus(files: StatusFileInput[]): string {
  const states: string[] = [];
  for (const f of files) {
    if (!isReadableFormat(f.format)) continue;
    if (f.percent === null) states.push("unread");
    else if (f.percent >= READ_DONE_THRESHOLD) states.push("done");
    else states.push("reading");
  }
  if (states.length === 0) return "";
  if (states.every((s) => s === "done")) return "done";
  if (states.some((s) => s === "reading")) return "reading";
  return "unread";
}
