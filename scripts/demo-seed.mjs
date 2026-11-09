#!/usr/bin/env node
/** 演示库种子：对「空库」走公开 HTTP API 灌入一套策划书目。
 *
 * 用途：CI 截图（pages.yml）与本地拍摄（scripts/shoot-screens.mjs）共用水源。
 * 前置：server 已在新数据目录上启动（ZZLIB_DATA_DIR 指向空目录），账号未改默认。
 * 用法：node scripts/demo-seed.mjs [baseURL=http://127.0.0.1:8901]
 *
 * 数据口径：标题/作者/年代取真实书目（事实本身无版权），正文为脚本生成的占位文本；
 * 两本「可读样书」用公版原文（《论语·学而》/《Meditations》节选）并预置读完进度。
 * 覆盖形态：BC 年代、无日期条目、多文件合订本、三级分类树、全局时间分段。 */

const BASE = process.argv[2] ?? "http://127.0.0.1:8901";

/* ---------- 公版正文（读图用样书） ---------- */

const LUNYU = `论语·学而

子曰：「学而时习之，不亦说乎？有朋自远方来，不亦乐乎？人不知而不愠，不亦君子乎？」
有子曰：「其为人也孝弟，而好犯上者，鲜矣；不好犯上，而好作乱者，未之有也。君子务本，本立而道生。孝弟也者，其为仁之本与！」
子曰：「巧言令色，鲜矣仁。」
曾子曰：「吾日三省吾身——为人谋而不忠乎？与朋友交而不信乎？传不习乎？」
子曰：「道千乘之国，敬事而信，节用而爱人，使民以时。」
子曰：「弟子入则孝，出则弟，谨而信，泛爱众，而亲仁。行有余力，则以学文。」
子夏曰：「贤贤易色；事父母能竭其力；事君，能致其身；与朋友交，言而有信。虽曰未学，吾必谓之学矣。」
子曰：「君子不重则不威，学则不固。主忠信，无友不如己者，过则勿惮改。」

为政

子曰：「为政以德，譬如北辰，居其所而众星共之。」
子曰：「《诗》三百，一言以蔽之，曰：思无邪。」
子曰：「吾十有五而志于学，三十而立，四十而不惑，五十而知天命，六十而耳顺，七十而从心所欲，不逾矩。」
孟懿子问孝。子曰：「无违。」樊迟御，子告之曰：「孟孙问孝于我，我对曰无违。」樊迟曰：「何谓也？」子曰：「生，事之以礼；死，葬之以礼，祭之以礼。」`;

const MEDITATIONS = `Meditations · Excerpts

Begin the morning by saying to thyself, I shall meet with the busy-body, the ungrateful, arrogant, deceitful, envious, unsocial. All these things happen to them by reason of their ignorance of what is good and evil. But I who have seen the nature of the good that it is beautiful, and of the bad that it is ugly, and the nature of him who does wrong, that it is akin to me, not only of the same blood or seed, but that it participates in the same intelligence and the same portion of the divinity, I can neither be injured by any of them, for no one can fix on me what is ugly, nor can I be angry with my kinsman, nor hate him. For we are made for co-operation, like feet, like hands, like eyelids, like the rows of the upper and lower teeth. To act against one another then is contrary to nature.

Look within. Let neither the peculiar quality of anything, nor its worth, escape thee. All existing things soon change, and they will either be reduced to vapour, if indeed all substance is one, or dispersed into fragments. That which the intellect grasps governs each man. The things which are most important for the soul are these: to fear nothing, to desire nothing external, and to be content with what is present.

Do not act as if thou wert going to live ten thousand years. Death hangs over thee. While thou livest, while it is in thy power, be good. Take away thy opinion, and then there is taken away the complaint. Take away the complaint, and the hurt is taken away. Consider both how quickly all things are forgotten, and what an immense chaos of eternity lies behind and before us.`;

/** 普通条目的占位正文（原创新文本，无版权问题）。 */
function fillerBody(title, authors, date) {
  const para = `《${title}》为 zzlibrary 演示库的占位条目${authors ? `，题作 ${authors} 撰` : ""}${
    date ? `，成书年代记为 ${date}` : "，年代未详"
  }。此处文字仅用于撑起文件体量与阅读器形态，不代表任何真实内容。`;
  return `${title}\n\n${para}\n\n${para}\n\n${para}\n`;
}

/* ---------- 分类树 + 书目 ----------
 * 条目格式：[标题, 作者(字符串|数组), 年代(前XXX/数字字符串/null), 可选{tags, files, body, progress, file}] */

const TREE = [
  {
    name: "历史",
    children: [
      {
        name: "中国史",
        children: ["先秦", "秦汉", "魏晋南北朝", "隋唐", "宋元", "明清", "近现代"],
        books: {
          先秦: [
            ["诗经", "佚名", "前600"],
            ["尚书", "相传孔子编订", "前480"],
            ["论语", "孔门弟子", "前450", { file: "论语·学而.txt", body: LUNYU, progress: 100 }],
            ["孙子兵法", "孙武", "前512"],
            ["道德经", "老子", "前480"],
            ["左传", "左丘明", "前400"],
            ["墨子", "墨翟及后学", "前400"],
            ["孟子", "孟子及弟子", "前320"],
            ["庄子", "庄周", "前286"],
            ["吕氏春秋", "吕不韦门客", "前239"],
            ["楚辞", "屈原等", "前240"],
            ["韩非子", "韩非", "前233"],
          ],
          秦汉: [
            ["史记", "司马迁", "前91", { files: ["本纪", "表", "书", "世家", "列传"] }],
            ["汉书", "班固", "82"],
            ["论衡", "王充", "80"],
            ["盐铁论", "桓宽", "60"],
            ["九章算术", "张苍等辑", "100"],
            ["说文解字", "许慎", "100"],
            ["伤寒杂病论", "张仲景", "200"],
          ],
          魏晋南北朝: [
            ["三国志", "陈寿", "289"],
            ["后汉书", "范晔", "445"],
            ["世说新语", "刘义庆", "420"],
            ["文心雕龙", "刘勰", "500"],
            ["陶渊明集", "陶潜", "420"],
            ["水经注", "郦道元", "526"],
          ],
          隋唐: [
            ["大唐西域记", ["玄奘", "辩机"], "646"],
            ["史通", "刘知几", "710"],
            ["通典", "杜佑", "801"],
            ["李太白集", "李白", "760"],
            ["杜工部集", "杜甫", "770"],
            ["茶经", "陆羽", "760"],
          ],
          宋元: [
            ["资治通鉴", "司马光", "1084", { files: ["周纪", "秦纪", "汉纪", "唐纪"] }],
            ["梦溪笔谈", "沈括", "1088"],
            ["营造法式", "李诫", "1103"],
            ["东京梦华录", "孟元老", "1147"],
            ["文献通考", "马端临", "1307"],
            ["宋史", "脱脱等", "1345"],
          ],
          明清: [
            ["永乐大典", "解缙等", "1408"],
            ["本草纲目", "李时珍", "1578"],
            ["天工开物", "宋应星", "1637"],
            ["徐霞客游记", "徐弘祖", "1640"],
            ["日知录", "顾炎武", "1670"],
            ["聊斋志异", "蒲松龄", "1680"],
            ["儒林外史", "吴敬梓", "1749"],
            ["四库全书总目", "纪昀等", "1782"],
            ["红楼梦", "曹雪芹", "1791"],
          ],
          近现代: [
            ["海国图志", "魏源", "1843"],
            ["天演论", ["赫胥黎", "严复 译"], "1898"],
            ["清代学术概论", "梁启超", "1920"],
            ["国史大纲", "钱穆", "1940"],
            ["万历十五年", "黄仁宇", "1982"],
          ],
        },
      },
      {
        name: "世界史",
        children: ["古代文明", "近代"],
        books: {
          古代文明: [
            ["汉谟拉比法典", "佚名", "前1750"],
            ["埃及亡灵书", "佚名", "前1250"],
            ["历史", "希罗多德", "前430"],
            ["伯罗奔尼撒战争史", "修昔底德", "前400"],
            ["高卢战记", "凯撒", "前52"],
            ["编年史", "塔西佗", "116"],
            ["Meditations", "Marcus Aurelius", "180", { file: "Meditations · Excerpts.txt", body: MEDITATIONS, progress: 100 }],
          ],
          近代: [
            ["罗马帝国衰亡史", "爱德华·吉本", "1776"],
            ["论美国的民主", "托克维尔", "1835"],
            ["旧制度与大革命", "托克维尔", "1856"],
            ["新教伦理与资本主义精神", "马克斯·韦伯", "1905"],
            ["全球通史", "斯塔夫里阿诺斯", "1970"],
            ["枪炮、病菌与钢铁", "贾雷德·戴蒙德", "1997"],
          ],
        },
      },
    ],
  },
  {
    name: "文学",
    children: [
      {
        name: "古典文学",
        children: ["诗文", "小说戏曲"],
        books: {
          诗文: [
            ["文选", "萧统 编", "530"],
            ["古文观止", ["吴楚材", "吴调侯"], "1695"],
            ["唐诗三百首", "蘅塘退士 编", "1763"],
            ["宋词选", "朱孝臧 编", null],
            ["人间词话", "王国维", "1910"],
          ],
          小说戏曲: [
            ["水浒传", "施耐庵", "1370"],
            ["三国演义", "罗贯中", "1522"],
            ["西厢记", "王实甫", "1300"],
            ["牡丹亭", "汤显祖", "1598"],
          ],
        },
      },
      {
        name: "现当代文学",
        children: ["小说", "散文"],
        books: {
          小说: [
            ["呐喊", "鲁迅", "1923"],
            ["边城", "沈从文", "1934"],
            ["围城", "钱锺书", "1947"],
            ["平凡的世界", "路遥", "1986"],
            ["白鹿原", "陈忠实", "1993"],
            ["三体", "刘慈欣", "2008", { files: ["地球往事", "黑暗森林", "死神永生"] }],
          ],
          散文: [
            ["朝花夕拾", "鲁迅", "1928"],
            ["文化苦旅", "余秋雨", "1992"],
            ["目送", "龙应台", "2008"],
            ["乡音采集手稿", "佚名", null],
          ],
        },
      },
      {
        name: "外国文学",
        children: ["小说", "诗歌"],
        books: {
          小说: [
            ["战争与和平", "列夫·托尔斯泰", "1869"],
            ["卡拉马佐夫兄弟", "陀思妥耶夫斯基", "1880"],
            ["一九八四", "乔治·奥威尔", "1949"],
            ["老人与海", "海明威", "1952"],
            ["百年孤独", "加西亚·马尔克斯", "1967"],
            ["不能承受的生命之轻", "米兰·昆德拉", "1984"],
          ],
          诗歌: [
            ["荷马史诗", "荷马", "前750"],
            ["草叶集", "惠特曼", "1855"],
          ],
        },
      },
    ],
  },
  {
    name: "技术",
    children: [
      {
        name: "编程",
        children: ["经典", "工程实践"],
        books: {
          经典: [
            ["计算机程序设计艺术", "高德纳", "1968"],
            ["人月神话", "弗雷德里克·布鲁克斯", "1975"],
            ["编程珠玑", "Jon Bentley", "1986"],
            ["计算机程序的构造和解释", "Harold Abelson 等", "1985"],
            ["设计模式", "Erich Gamma 等", "2000"],
            ["代码大全", "史蒂夫·迈克康奈尔", "2004"],
            ["深入理解计算机系统", "Randal Bryant 等", "2016"],
            ["重构", "马丁·福勒", "2019"],
          ],
          工程实践: [
            ["黑客与画家", "保罗·格雷厄姆", "2004"],
            ["代码整洁之道", "罗伯特·马丁", "2008"],
            ["程序员的自我修养", "俞甲子 等", "2009"],
          ],
        },
      },
      {
        name: "人工智能",
        children: ["论文", "专著"],
        books: {
          论文: [
            ["Playing Atari with Deep RL", "Volodymyr Mnih 等", "2013"],
            ["Deep Residual Learning", "Kaiming He 等", "2015"],
            ["Attention Is All You Need", "Ashish Vaswani 等", "2017"],
            ["BERT", "Jacob Devlin 等", "2018"],
            ["Language Models are Few-Shot Learners", "Tom Brown 等", "2020"],
            ["Denoising Diffusion", "Jonathan Ho 等", "2020"],
          ],
          专著: [
            ["深度学习", "Ian Goodfellow 等", "2016"],
            ["机器学习", "周志华", "2016"],
            ["动手学深度学习", "阿斯顿·张 等", "2019"],
          ],
        },
      },
    ],
  },
];

/** 全局时间分段（发布轴）：中国史朝代框架；世界史/文学/技术年份落进对应段带。 */
const SEGMENT_RANGES = [
  { label: "先秦", start: "前770", end: "前221" },
  { label: "秦汉", start: "前221", end: "220" },
  { label: "魏晋南北朝", start: "220", end: "581" },
  { label: "隋唐", start: "581", end: "907" },
  { label: "五代十国", start: "907", end: "960" },
  { label: "宋元", start: "960", end: "1368" },
  { label: "明清", start: "1368", end: "1912" },
  { label: "近现代", start: "1912", end: "1949" },
  { label: "当代", start: "1949", end: "2100" },
];

/* ---------- HTTP 小工具（同源 + 会话 Cookie 手动携带） ---------- */

let COOKIE = "";

async function api(method, path, body, isForm = false) {
  const headers = { cookie: COOKIE };
  const init = { method, headers, credentials: "include" };
  if (body !== undefined) {
    if (isForm) init.body = body;
    else {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
  }
  const res = await fetch(`${BASE}${path}`, init);
  if (!res.ok) {
    const detail = await res.json().then((j) => j.detail).catch(() => res.statusText);
    throw new Error(`${method} ${path} → ${res.status}: ${detail}`);
  }
  const setCookie = res.headers.getSetCookie?.() ?? [];
  for (const c of setCookie) {
    const kv = c.split(";")[0];
    if (kv.startsWith("zzlib")) COOKIE = kv;
  }
  return res.status === 204 ? undefined : res.json();
}

async function waitHealthy() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return;
    } catch {
      /* server 未就绪 */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`server 未就绪：${BASE}/api/health`);
}

/* ---------- 灌库 ---------- */

async function main() {
  console.log(`① 等待 server：${BASE}`);
  await waitHealthy();

  console.log("② 登录");
  await api("POST", "/api/auth/login", { username: "admin", password: "zzlibrary" });

  console.log("③ 全局时间分段");
  await api("PUT", "/api/segment-config", { mode: "custom", params: { ranges: SEGMENT_RANGES } });

  console.log("④ 建分类树 + 入库");
  let count = 0;
  const specialFiles = []; // {title, fileId} 需要预置进度的样书
  for (const l1 of TREE) {
    const l1Node = await api("POST", "/api/categories", { name: l1.name, parent_id: null });
    for (const l2 of l1.children) {
      const l2Node = await api("POST", "/api/categories", { name: l2.name, parent_id: l1Node.id });
      const l3Ids = {};
      for (const l3Name of l2.children) {
        const l3Node = await api("POST", "/api/categories", { name: l3Name, parent_id: l2Node.id });
        l3Ids[l3Name] = l3Node.id;
      }
      for (const [l3Name, books] of Object.entries(l2.books)) {
        for (const entry of books) {
          const [title, authors, date, opts = {}] = entry;
          const authorList = Array.isArray(authors) ? authors : [authors];

          // 文件集：多卷合订本 / 指定正文样书 / 默认单文件
          const parts =
            opts.files ? opts.files.map((v) => ({ name: `${title}·${v}.txt`, body: fillerBody(`${title}·${v}`, authorList.join("、"), date) }))
            : [{ name: opts.file ?? `${title}.txt`, body: opts.body ?? fillerBody(title, authorList.join("、"), date) }];

          const stageIds = [];
          for (const p of parts) {
            const form = new FormData();
            form.append("file", new Blob([p.body], { type: "text/plain" }), p.name);
            const staged = await api("POST", "/api/packages/stage", form, true);
            stageIds.push(staged.stage_id);
          }
          const pkg = await api("POST", "/api/packages", {
            stage_ids: stageIds,
            meta: {
              title,
              authors: authorList,
              classifications: [{ l1_id: l1Node.id, l2_id: l2Node.id, l3_id: l3Ids[l3Name] }],
              publish_date: date,
              publisher: null,
              tags: opts.tags ?? [],
              notes: null,
            },
          });
          if (opts.progress !== undefined) {
            const detail = await api("GET", `/api/packages/${pkg.id}`);
            specialFiles.push({ title, fileId: detail.files[0].id, percent: opts.progress });
          }
          count++;
        }
      }
    }
  }

  console.log("⑤ 预置样书进度");
  for (const s of specialFiles) {
    await api("PUT", `/api/progress/${s.fileId}`, { locator: { anchor: "end" }, percent: s.percent });
  }

  const stats = await api("GET", "/api/stats");
  console.log(`完成：${count} 包入库（stats.packages=${stats.packages}），样书进度 ${specialFiles.length} 条`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
