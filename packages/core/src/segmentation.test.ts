/** core 纯逻辑单测：与 Python 版行为逐条对齐（关键：公元前 9 补码、网格对齐、退化规则）。 */
import { describe, expect, it } from "vitest";
import {
  canonicalDateStr,
  displayDate,
  parsePartialDate,
  yearOfKey,
} from "./dates";
import {
  computeGrid,
  formatYear,
  indexFor,
  parseRange,
  UNDATED_KEY,
} from "./segmentation";
import { detectFormat } from "./formats";
import { computePackageStatus } from "./status";
import { cleanPackageName, parseLooseDate, stemTitle } from "./ingest";

describe("dates（公元前 9 补码）", () => {
  it("序键编码", () => {
    expect(canonicalDateStr(221, 5, 1)).toBe("0221-05-01");
    expect(canonicalDateStr(-221, 5, 1)).toBe("-9779-05-01"); // 前221 → -9779
    expect(canonicalDateStr(-1)).toBe("-9999-01-01"); // 前1 → -9999
  });
  it("yearOfKey 往返", () => {
    expect(yearOfKey("-9779-05-01")).toBe(-221);
    expect(yearOfKey("0630-01-01")).toBe(630);
  });
  it("displayDate", () => {
    expect(displayDate("-9779-05-01")).toBe("-0221-05-01");
    expect(displayDate("1368-01-01")).toBe("1368-01-01");
    expect(displayDate(null)).toBeNull();
  });
  it("parsePartialDate 各种写法", () => {
    expect(parsePartialDate("前221")).toBe("-9779-01-01");
    expect(parsePartialDate("公元前221-05")).toBe("-9779-05-01");
    expect(parsePartialDate("-618-06-18")).toBe("-9382-06-18");
    expect(parsePartialDate("2024")).toBe("2024-01-01");
    expect(parsePartialDate("2024-3")).toBe("2024-03-01");
    expect(parsePartialDate("")).toBeNull();
    expect(() => parsePartialDate("abc")).toThrow();
    expect(() => parsePartialDate("0")).toThrow(); // 无公元 0 年
  });
});

describe("computeGrid 自动分段", () => {
  it("按年：逐段 + 前221 表示", () => {
    // -9778=前222（更早）、-9779=前221
    const grid = computeGrid(["-9779-01-01", "-9778-06-15"], { mode: "year", params: {} });
    expect(grid.map((s) => s.label)).toEqual(["前222", "前221"]);
    expect(grid[0]!.start).toBe("-9778-01-01");
    expect(grid[1]!.end).toBe("-9779-12-31");
  });
  it("每 N 年：对齐 1 mod n 网格（公元前可用）", () => {
    // 前221、前224（-9779,-9776）：lo_year=(min(-221,-224)-1)//5*5+1=(-225)//5*5+1=-45*5+1=-224
    const grid = computeGrid(["-9779-01-01", "-9776-01-01"], { mode: "n_years", params: { n: 5 } });
    expect(grid[0]!.label).toBe("前224–前220");
    expect(grid).toHaveLength(1);
  });
  it("每 N 年：跨公元 0 跳段", () => {
    // 前2、公元2（n=2）：网格对齐 1 mod 2 → 从前3 起：[前3,前2][前1,前1→-1][1,2]
    const grid = computeGrid(["-9998-01-01", "0002-01-01"], { mode: "n_years", params: { n: 2 } });
    expect(grid.map((s) => s.label)).toEqual(["前3–前2", "前1–前1", "1–2"]);
  });
  it("按十年：公元前对齐 + 公元 1~9 单独成段", () => {
    const grid = computeGrid(["-9779-01-01", "0005-01-01"], { mode: "decade", params: {} });
    const labels = grid.map((s) => s.label);
    expect(labels[0]).toBe("前230–前221"); // -230//10*10=-230
    expect(labels).toContain("1–9");
  });
  it("按月：跨年逐月", () => {
    const grid = computeGrid(["2024-11-05", "2025-02-01"], { mode: "month", params: {} });
    expect(grid).toHaveLength(4);
    expect(grid[0]!.label).toBe("2024-11");
    expect(grid[3]!.label).toBe("2025-02");
    expect(grid[1]!.end).toBe("2024-12-31");
  });
  it("按月超 300 段自动退化为按年", () => {
    const dates: string[] = [];
    for (let y = 1600; y <= 1900; y++) dates.push(`${y}-06-15`); // 301 年
    const grid = computeGrid(dates, { mode: "month", params: {} });
    expect(grid).toHaveLength(300); // 退化按年且裁到最近 300 段
    expect(grid[0]!.key).toBe("y1601");
    expect(grid.at(-1)!.key).toBe("y1900");
  });
  it("未注明时间统一末段", () => {
    const grid = computeGrid(["2001-01-01", null], { mode: "year", params: {} });
    expect(grid.at(-1)!.key).toBe(UNDATED_KEY);
    expect(indexFor(grid, null)).toBe(grid.length - 1);
    expect(indexFor(grid, "2001-05-05")).toBe(0);
  });
});

describe("computeGrid 自定义区间", () => {
  it("解析+排序+其他段+别名", () => {
    const grid = computeGrid(
      ["0581-01-01", "0907-06-01", "1500-01-01"],
      {
        mode: "custom",
        params: {
          ranges: [
            { start: "1368", end: "1644", alias: "明" },
            { start: "581", end: "907", alias: "隋唐" },
          ],
        },
      },
    );
    expect(grid.map((s) => s.key)).toEqual(["c0581-01-01_0907-12-31", "c1368-01-01_1644-12-31", "other"]);
    expect(grid[0]!.label).toBe("581–907");
    expect(grid[0]!.alias).toBe("隋唐");
    expect(indexFor(grid, "1500-01-01")).toBe(1);
    expect(indexFor(grid, "1000-01-01")).toBe(2); // 其他
  });
  it("起止倒置自动交换；无效条目跳过", () => {
    // 交换发生在边界解析之后：start=1644→1/1、end=1368→12/31，交换得 (1368-12-31, 1644-01-01)
    const parsed = parseRange({ start: "1644", end: "1368", alias: "x" });
    expect(parsed![0]).toBe("1368-12-31");
    expect(parsed![1]).toBe("1644-01-01");
    expect(parseRange({ start: "abc" })).toBeNull();
  });
  it("区间边界宽松解析（公元前/月日）", () => {
    expect(parseRange({ start: "前618-06", end: "907" })).toEqual(["-9382-06-01", "0907-12-31", null]);
  });
});

describe("formatYear", () => {
  it("公元前渲染", () => {
    expect(formatYear(-221)).toBe("前221");
    expect(formatYear("1368-01-01")).toBe("1368");
    expect(formatYear("-9779-01-01")).toBe("前221");
  });
});

describe("detectFormat", () => {
  it("已知/别名/未知/无扩展", () => {
    expect(detectFormat("a.EPUB")).toBe("epub");
    expect(detectFormat("b.htm")).toBe("html");
    expect(detectFormat("c.markdown")).toBe("md");
    expect(detectFormat("d.JPEG")).toBe("jpg");
    expect(detectFormat("e.unknownext")).toBe("unknownext");
    expect(detectFormat("weird#name$x")).toBe("bin"); // 无扩展名
    expect(detectFormat("noext")).toBe("bin");
    expect(detectFormat("dir/file.tar.gz")).toBe("gz");
  });
});

describe("computePackageStatus", () => {
  it("聚合规则与不可读中性", () => {
    expect(computePackageStatus([])).toBe("");
    expect(computePackageStatus([{ format: "zip", percent: null }])).toBe(""); // 不可读不参与
    expect(computePackageStatus([{ format: "pdf", percent: null }])).toBe("未读");
    expect(computePackageStatus([{ format: "pdf", percent: 10 }])).toBe("在读");
    expect(computePackageStatus([{ format: "pdf", percent: 98.5 }])).toBe("已读");
    expect(
      computePackageStatus([
        { format: "pdf", percent: 99 },
        { format: "epub", percent: 30 },
      ]),
    ).toBe("在读");
    expect(
      computePackageStatus([
        { format: "pdf", percent: 100 },
        { format: "epub", percent: null },
        { format: "bin", percent: 50 }, // 中性
      ]),
    ).toBe("未读");
  });
});

describe("入库纯逻辑", () => {
  it("parseLooseDate 宽松抽取", () => {
    expect(parseLooseDate("2023-05-17T00:00:00Z")).toBe("2023-05-17");
    expect(parseLooseDate("2023/5/17")).toBe("2023-05-17");
    expect(parseLooseDate("2023-05")).toBe("2023-05-01");
    expect(parseLooseDate("© 2023 Someone")).toBe("2023-01-01");
    expect(parseLooseDate("2023-13-40")).toBeNull(); // 月无效且后续模式均被负向断言挡住
    expect(parseLooseDate(null)).toBeNull();
  });
  it("stemTitle / cleanPackageName", () => {
    expect(stemTitle("我的_书_v2.epub")).toBe("我的 书 v2");
    expect(stemTitle(".epub")).toBe(".epub"); // 主干为空回退文件名
    expect(cleanPackageName('a/b:c*d?"e<f>g|h')).toBe("a_b_c_d__e_f_g_h"); // ? 和 " 各替换一次
    expect(cleanPackageName("...")).toBe("未命名");
    expect(cleanPackageName(" exactly40chars-x".repeat(3))).toHaveLength(40);
  });
});
