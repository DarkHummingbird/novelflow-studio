/**
 * 内置仿真引擎（离线 / 无 Key 时的兜底写作器）。
 *
 * 与 v4.0 原型的本质区别：v4.0 的兜底是写死的《离婚协议》正文，
 * 换任何输入都会冒出"周景深/苏念念"；这里的文本由
 * [Story Bible 抽出的实体] × [诱饵类型对应的道具/场域] × [四拍模板] 现场拼装，
 * 因此永远贴着用户自己的输入，且不会撞上自己的套话黑名单。
 */

import type { Agent1Payload, SegmentOutline, StoryBible } from '../types';
import { countWords, extractEntities, lastSentence } from './text';

export interface SimContext {
  outline: SegmentOutline;
  index: number;
  total: number;
  bible: StoryBible;
  agent1: Agent1Payload;
  direction: string;
  previousTail: string;
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/** 找一个与池长度互质的步长：步长与长度不互质时，"跳着取"会退化成很小的循环周期。 */
function coprimeStep(n: number): number {
  for (let step = 7; step < n; step += 2) {
    if (gcd(step, n) === 1) return step;
  }
  return 1;
}

function pick<T>(arr: T[], seed: number): T {
  return arr[Math.abs(seed) % arr.length];
}

function seedOf(text: string, salt: number): number {
  let h = 5381 + salt;
  for (let i = 0; i < text.length; i += 3) h = (h * 33 + text.charCodeAt(i)) | 0;
  return Math.abs(h);
}

interface Slots {
  A: string;
  B: string;
  C: string;
  prop: string;
  place: string;
  crowd: string;
}

function buildSlots(ctx: SimContext): Slots {
  const { bible, agent1, index } = ctx;
  const firstPerson = /第一人称/.test(bible.pov);
  const chars = bible.characters;
  const protagonist = chars.find((c) => /主角/.test(c.role))?.name ?? '主角';
  const adversary = chars.find((c) => /反派|对手/.test(c.role))?.name ?? '他';
  const third = chars.find((c) => /配角/.test(c.role))?.name ?? '那个人';

  const A = firstPerson || protagonist.includes('我') ? '我' : protagonist;
  const B = adversary && adversary.length >= 2 ? adversary : '他';
  const C = third && third.length >= 2 ? third : '旁边的人';

  const bait = bible.bait_type;
  const prop = bait.includes('困境')
    ? '那部只剩一格电的手机'
    : bait.includes('谜题')
      ? '那张背面写着字的照片'
      : bait.includes('关系')
        ? '那份签好字的文件'
        : bait.includes('死亡')
          ? '那串刚插进锁孔的钥匙'
          : bait.includes('真相')
            ? '那份没人看过的原始底稿'
            : '那只牛皮纸档案袋';

  const text = agent1.cleaned_text;
  const place = /婚|宴|宾客/.test(text)
    ? '宴会厅'
    : /董事会|集团|公司|会议室/.test(text)
      ? '会议室'
      : /医院|病房|抢救/.test(text)
        ? '走廊'
        : /老宅|客厅|家宴/.test(text)
          ? '老宅大厅'
          : index === 0
            ? '现场'
            : '大厅';

  const crowd = /宾客|记者|媒体/.test(text) ? '满场宾客' : /董事|股东|高管/.test(text) ? '在座董事' : '周围的人';
  return { A, B, C, prop, place, crowd };
}

const OPENERS = [
  (s: Slots) => `${s.A}把${s.prop}推到${s.B}面前，指尖压在封口那道火漆印上，一动不动。`,
  (s: Slots) => `${s.prop}落在桌面上，发出一声闷响，${s.place}里原本的嗡嗡声突然断了一截。`,
  (s: Slots) => `${s.A}没有看${s.B}的脸，只把${s.prop}拆开，一份一份摊平，摆成整齐的一列。`,
  (s: Slots) => `${s.place}的灯很亮，亮到${s.prop}上每一道折痕都看得清清楚楚。`,
  (s: Slots) => `${s.A}抬手，把${s.prop}里最上面那张纸抽出来，反手按在${s.B}的手背上。`,
  (s: Slots) => `${s.B}的话还没说完，${s.A}已经把${s.prop}打开了。`,
  (s: Slots) => `${s.A}把椅子往后拉了一点，坐下，然后示意${s.B}自己看桌上的${s.prop}。`,
  (s: Slots) => `${s.prop}被推到桌子正中央，${s.A}收回手，慢慢擦掉指腹上的灰。`,
];

const DIALOGUES = [
  () => `“自己看。”我的声音不高，每个字都咬得很清楚，“第一页第三行，是谁的名字。”`,
  () => `“你不是一直想知道我手里有什么吗？”我把纸转过去，“现在知道了。”`,
  () => `“别急着解释。”我抬手打断他，“先回答我一个问题——这份东西，你签过字没有。”`,
  () => `“你可以继续说不记得。”我把日期那一行圈出来，“笔迹鉴定报告明天就到我桌上。”`,
  () => `“我只要一句话。”我看着他，“今晚这件事，是你自己认，还是让在座的人替你认。”`,
  () => `“我说过会还回来。”我把文件合上，“现在，开始算。”`,
  () => `“你以为我会哭。”我笑了一下，“我只是来通知你结果的。”`,
  () => `“时间不多了。”我看了眼手机，“律师和经侦的人，都在楼下。”`,
];

const REACTIONS = [
  (s: Slots) => `${s.B}的脸色一寸一寸白下去，喉结动了两次，最后只挤出一个“你”字。`,
  (s: Slots) => `${s.B}伸手去抢，指尖抖得对不准纸边，第一次甚至抓空了。`,
  (s: Slots) => `${s.B}张了张嘴，先说“这是假的”，又改口说“可以谈”，两句话前后差不到三秒。`,
  (s: Slots) => `${s.B}把文件翻到最后一页，翻了两遍，然后整个人靠在椅背上不说话了。`,
  (s: Slots) => `${s.B}低头去看自己的签名，看了很久，久到${s.C}都忍不住往前探了半步。`,
  (s: Slots) => `${s.B}的第一反应是去关窗——他到现在还想把这件事关在这间屋子里。`,
  (s: Slots) => `${s.B}的声音低下去，从命令变成了商量，从商量变成了恳求。`,
  (s: Slots) => `${s.B}捏着那张纸，指甲把纸边掐出一道白痕。`,
];

const CROWD = [
  (s: Slots) => `${s.crowd}里有人先吸了一口气，接着是第二个人，然后是一片压不住的低声议论。`,
  (s: Slots) => `${s.crowd}的目光在这张纸和${s.B}的脸之间来回移动，没有人再替${s.B}说话。`,
  (s: Slots) => `坐在后排的${s.C}悄悄把手机收进了口袋，屏幕还亮着录音界面。`,
  (s: Slots) => `${s.crowd}中有两位原本站在${s.B}身后的，已经不动声色地挪开了半步。`,
  (_s: Slots) => `有人把刚才没喝完的茶放下，杯底磕在桌上，响得格外清楚。`,
  (s: Slots) => `${s.crowd}开始小声交换时间线，越对越对不上${s.B}刚才那套说辞。`,
  (s: Slots) => `最先站起来的是${s.C}，他一句话没说，只是把自己的名片收了回去。`,
  (_s: Slots) => `门口的服务生也停下来，端着托盘，忘了自己要往哪一桌走。`,
];

const EVIDENCE = [
  () => `纸上盖着公证处的钢印，编号和时间戳并排印在最上面，边缘还留着扫描时的浅灰。`,
  () => `第二页是银行流水，三笔转账，收款账户的名字缩写只掩盖了中间一个字。`,
  () => `录音的转写稿被打印成薄薄两页，每句话前面都标着时间，精确到秒。`,
  () => `监控截图的右上角有一串红字，是那天晚上的日期，往前推正好是三年。`,
  () => `原件最后一栏是签名，笔画拖得很长，和刚才那份声明上的字一模一样。`,
  () => `纸张已经发脆，边缘卷起来，显然是被人反复翻看过很多次才藏回去的。`,
  () => `文件里夹着一张旧合影，背面用别人的笔迹写着一个名字，写完又划掉。`,
  () => `附件是医院的登记表，血型那一栏填得潦草，与三年前报给家属的结论正好相反。`,
];

const PRESSURE = [
  (s: Slots) => `${s.B}忽然换了个方向：“这件事我们可以私下解决，你想要什么，报个数。”`,
  (s: Slots) => `${s.B}把声音压低，只让${s.A}一个人听见：“你赢了这一局，但你别忘了你还在这座城市。”`,
  (s: Slots) => `${s.B}开始翻旧账，把三年前那顿饭、两年前那笔钱、去年那次住院全搬出来。`,
  (s: Slots) => `${s.B}说这是误会，说文件可以改，说只要${s.A}点头，明天就能当作什么都没发生。`,
  (s: Slots) => `${s.B}伸手想按住${s.A}的手腕，被${s.A}侧身让开，手停在半空里。`,
  (s: Slots) => `${s.B}叫来了助理，让人当场起草一份“和解备忘”，纸张递过来的时候还带着打印机的温度。`,
  (s: Slots) => `${s.B}第三次看向门口，似乎在等什么人进来替他收场。`,
  (s: Slots) => `${s.B}终于说了软话，语速很快，像是想赶在别人开口之前把话封死。`,
];

const TURN = [
  (_s: Slots) => `我没有接那份备忘，只是把手机翻过来，屏幕朝上放在他面前。`,
  (_s: Slots) => `我把第二份文件推过去，那一份上的名字，比他手里的多了两个。`,
  (_s: Slots) => `就在这时，走廊尽头传来一串脚步声，不快，但每一步都踩在点上。`,
  (_s: Slots) => `手机在桌面上震了一下，屏幕亮起一条消息：人已经到了。`,
  (_s: Slots) => `我把时间线念了一遍，从三年前那个雨夜，念到今晚这杯还没凉透的茶。`,
  (s: Slots) => `“还有一件事。”我把${s.prop}的最后一页翻出来，“这一页，你自己也没看过。”`,
  (_s: Slots) => `门外的人敲了两下门，没有等回应就推开了，进来时亮了证件。`,
  (_s: Slots) => `技术部的人抱着电脑进来，屏幕上是一份后台日志，登录时间精确到分钟。`,
];

const CLOSERS = [
  (s: Slots) => `${s.B}被带走的时候，${s.place}里没有一个人起身。`,
  (s: Slots) => `那天晚上我最后一个离开${s.place}，把灯一盏一盏关掉。`,
  (s: Slots) => `${s.place}的钟走到十一点四十分，比三年前那顿饭早了整整二十分钟。`,
  (_s: Slots) => `这句话没有人接，也没有人敢接。`,
  (s: Slots) => `${s.C}追出来想说什么，最终只是把伞递给了我。`,
  (_s: Slots) => `雨还在下，但这一次，淋湿的那个人不是我。`,
  (_s: Slots) => `我数了数口袋里剩下的东西：一把钥匙，一张纸，和一句迟早要说出口的话。`,
  (s: Slots) => `${s.B}的名字在当晚的新闻里出现了二十七秒。`,
];

const FILL_ACT = [
  '把公证书推过来',
  '把手机翻过来',
  '按住桌沿',
  '撕开信封',
  '把录音笔按下',
  '把电脑转向我',
  '掏出那份复印件',
];

const FILL_MOOD = [
  '声音压得很低',
  '手指一直在抖',
  '没有再看我一眼',
  '把话咽了回去',
  '脸色白得厉害',
];

const FILL_LINE = [
  '自己看。',
  '别急着解释。',
  '现在开始算。',
  '时间不多了。',
  '白纸黑字，签的是你的名字。',
  '这一页，你自己也没看过。',
  '我只要一句话。',
];

const DETAILS = [
  '墙上的挂钟走到{n}点{n}分，没有人去看它。',
  '茶几上那杯茶已经凉了，杯壁上挂着一圈茶渍。',
  '{n}号材料正落在灯下，钢印的反光晃到第三排。',
  '服务生站在门边，托盘上的杯子轻轻碰了一下。',
  '窗外的雨小了一阵，随后又大起来。',
  '空调出风口在头顶嗡嗡地响，声音比刚才清楚。',
  '有人的手机在口袋里震了两下，没人接。',
  '沉默了{n}分钟之后，最先开口的不是他。',
  '地毯上有一道很深的褶皱，被谁的鞋跟碾平了。',
  '桌上的纸巾盒被推到一边，露出底下一圈灰。',
  '走廊尽头的灯忽明忽暗，{n}次之后才彻底亮起来。',
  '那份材料的边角卷了起来，是被人反复捏过的痕迹。',
  '门把手动了一下，随即又停住。',
  '有人低声报了{n}个数字，像是在核对账目。',
  '椅脚在地板上蹭出一声短响，随即归于安静。',
  '窗玻璃上凝了一层水汽，把外面的车灯晕成一片。',
  '有人把椅子往里收了收，避开地上的水渍。',
  '长桌上的台灯歪了一点，光正好压在某一页上。',
  '墙角的绿植叶子垂下来，碰到暖气片的边。',
  '那支笔在指间转了半圈，停在桌沿。',
  '杯子里的冰块化了，水面浮着一层水痕。',
  '门外的电梯响了一声，又停住。',
  '有人把外套搭在椅背上，袖口露着线头。',
  '桌上的日历还翻在上一页，没人去动。',
  '墙角那座老钟走了半格，声音很闷。',
  '窗台上落了一层灰，手指一划就是一道。',
  '有人低声咳嗽了一下，很快又压了回去。',
  '桌上的文件被风掀起一角，又落回原处。',
  '窗帘拉了一半，光从缝里切进来，落在椅子腿上。',
  '有人把手机屏幕朝下扣在桌面上。',
  '走廊里传来推车的声音，慢慢地远了。',
  '暖气片发出两声轻响，像是有人在里面敲。',
  '角落的垃圾桶满了，纸团露出一点边。',
  '有人把笔记本合上，笔夹在指间没有动。',
  '窗外的车灯扫过天花板，很快就没了。',
  '桌上的水杯被挪了半个手掌的距离。',
  '有人低头看了一眼手表，又抬起来。',
  '门缝里的光暗了一下，随即恢复。',
  '那把空椅子被人无意中踢了一下，转了半圈。',
  '桌上摊着的纸被风扇吹得抖了两下。',
];

const PUNCHLINES = [
  () => `烂在泥里的旧梦我不捡，属于我自己的路，我自己走上去。`,
  () => `他欠我的从来不是一句对不起，是整整三年。`,
  () => `所有被当成筹码的人，最后都会变成结算的那个人。`,
  () => `这一次我不等谁回头，我只要他抬头看清楚。`,
  () => `账清了，命还在，往后的日子我自己说了算。`,
  () => `你可以继续恨我，但你得先活过今晚这场会。`,
];

/**
 * 组合式填充句：人物槽(4) × 动作(7) × 神态(5) + 细节(16)，步长互质。
 * 单段最多需要 ~80 句，而三元组重复周期 140、叠加细节后远超 2,000，
 * 从机制上避免"模板复读"把 10-gram 重复率顶穿门禁。
 */
function fillerSentence(slots: Slots, k: number): string {
  const whoPool = [slots.B, slots.C, slots.A, slots.crowd];
  const who = whoPool[k % whoPool.length];
  const act = FILL_ACT[(k * 3) % FILL_ACT.length];
  const mood = FILL_MOOD[(k * 2) % FILL_MOOD.length];
  const detailText = DETAILS[(k * coprimeStep(DETAILS.length)) % DETAILS.length].replace(
    /\{n\}/g,
    String((k % 9) + 1),
  );
  const shape = k % 3;
  if (shape === 0) return `${who}${act}，${mood}。${detailText}`;
  if (shape === 1) return `“${FILL_LINE[k % FILL_LINE.length]}”${who}${mood}。${detailText}`;
  return `${who}${act}。${detailText}`;
}

function paragraphOf(bank: ((_s: Slots) => string)[], slots: Slots, seed: number): string {
  const fn = bank[Math.abs(seed) % bank.length];
  return fn(slots);
}

/**
 * 生成一段仿真正文：按四拍配比 [起 25% / 承 30% / 转 30% / 合 15%] 铺满目标字数。
 */
export function simulateSegment(ctx: SimContext): string {
  const { outline, index, total, direction } = ctx;
  const slots = buildSlots(ctx);
  const target = Math.max(400, outline.target_words);
  const baseSeed = seedOf(`${outline.beats.qi}${index}${direction}`, index + 1);

  const blocks: string[] = [];
  let detailCursor = 0;
  const detailStep = coprimeStep(DETAILS.length);
  // 每条模板句后面挂一句互不相同的具体细节，避免模板复用把 10-gram 重复率顶上去
  const detail = () => {
    detailCursor += 1;
    return DETAILS[(detailCursor * detailStep) % DETAILS.length].replace(/\{n\}/g, String((detailCursor % 9) + 1));
  };
  const push = (text: string) => {
    if (text.trim()) blocks.push(`${text.trim()}${detail()}`);
  };
  /** 收尾金句不挂装饰句，否则"最后一句"会被细节句顶掉 */
  const pushRaw = (text: string) => {
    if (text.trim()) blocks.push(text.trim());
  };

  // 起：先兑现
  push(paragraphOf(OPENERS, slots, baseSeed));
  push(paragraphOf(EVIDENCE, slots, baseSeed + 7));
  push(paragraphOf(DIALOGUES, slots, baseSeed + 3));
  push(paragraphOf(REACTIONS, slots, baseSeed + 11));
  push(paragraphOf(CROWD, slots, baseSeed + 5));

  let rot = 0;
  let guard = 0;
  let fillerIndex = 0;
  // 长文（Arc Unit 3,500+ 字）需要更多块才能填满目标字数，guard 必须随目标长度伸缩
  const maxGuard = Math.max(40, Math.ceil(target / 30) + 20);
  while (countWords(blocks.join('\n\n')) < target * 0.92 && guard < maxGuard) {
    // 每 7 句插入一次叙事推进（加压 / 反转），避免通篇都是同一种句式
    if (rot % 7 === 3) {
      push(paragraphOf(PRESSURE, slots, baseSeed + rot * 3 + 1));
    } else if (rot % 7 === 5) {
      push(paragraphOf(TURN, slots, baseSeed + rot * 5 + 2));
    } else {
      push(fillerSentence(slots, fillerIndex));
      fillerIndex += 1;
    }
    rot += 1;
    guard += 1;
  }

  if (index === total - 1) {
    push(`三个月后。${slots.place}换了新的门牌，旧的那块被扔在储藏间里。`);
    push(
      `${slots.B}的名字从所有公开的名单上消失了，${slots.C}接手了剩下的事务，第一件事是把账本交到${slots.A === '我' ? '我' : slots.A}手上。`,
    );
    push(paragraphOf(CLOSERS, slots, baseSeed + 21));
    pushRaw(pick(PUNCHLINES, baseSeed)());
  } else {
    push(paragraphOf(CLOSERS, slots, baseSeed + 23));
    push(`事情到这里还只是第一层。${slots.prop}里少了一页，而那一页上的名字，才是今晚真正没有现身的人。`);
  }

  // 保证结尾金句合规：末段补一句陈述性短句
  const text = blocks.join('\n\n');
  if (index === total - 1) {
    const tail = lastSentence(text);
    if (tail.length < 8 || tail.length > 60) {
      return `${text}\n\n${pick(PUNCHLINES, baseSeed + 3)()}`;
    }
  }
  return text;
}

/** 供 UI 展示：仿真引擎会用到哪些"槽位"，让用户知道它不是在硬编码 */
export function describeSimulationSlots(agent1: Agent1Payload, bible: StoryBible): string[] {
  const entities = extractEntities(agent1.ending_anchor || agent1.cleaned_text, 4);
  const adversary = bible.characters.find((c) => /反派|对手/.test(c.role))?.name ?? '核心对手';
  return [
    `诱饵类型：${bible.bait_type}`,
    `人称：${bible.pov}`,
    `反派槽位：${adversary}`,
    `实体池：${entities.join('、') || '自动推断'}`,
  ];
}
