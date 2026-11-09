/** core 展示词的语言钩子：core 产出语言中性的结构化数据，人类词由调用方注入。
 *
 * 默认中文（源语言）——不传钩子的既有调用（含全部 core 测试）行为不变；
 * web / server 各自从自己的语言字典构造钩子传入，新增语言零改 core。 */
export interface DisplayI18n {
  /** 公元前年渲染：前221 / 221 BC（入参为正数年） */
  bc(year: number): string;
  /** 无日期兜底：未注明时间 / Undated */
  undated: string;
  /** custom 区间外段名：其他 / Other */
  other: string;
}

export const ZH_DISPLAY: DisplayI18n = {
  bc: (y) => `前${y}`,
  undated: "未注明时间",
  other: "其他",
};
