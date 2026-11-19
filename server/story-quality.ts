import { countWords, repeatRatio } from '../src/lib/text';

export function minPartWords(target: number) {
  return Math.round(target * 0.85);
}

const heading = /^(?:第\s*[一二三四五六七八九十百零\d]+\s*[章回节段]|#{1,6}\s|\*\*第[一二三四五六七八九十\d]+[章段])/;
const commentary = /^(?:以下[是为].{0,20}(?:续写|正文)|(?:续写|正文)[：:]|根据.{0,20}(?:前文|要求)[，,：:])/;
const endTag = /(?:^|\n)\s*(?:未完待续|待续|本章完)\s*[。！!…]*\s*$/;

function copiesPreviousEnding(draft: string, previousTail: string) {
  const ending = previousTail.replace(/\s/g, '').slice(-120);
  const opening = draft.replace(/\s/g, '').slice(0, 120);
  for (let size = Math.min(ending.length, opening.length); size >= 16; size--) {
    if (ending.endsWith(opening.slice(0, size))) return true;
  }
  return false;
}

export function checkStoryPart(draft: string, target: number, previousTail: string, truncated: boolean) {
  const words = countWords(draft);
  const text = draft.trim();
  const minimum = minPartWords(target);
  const gates = {
    length: words >= minimum && !truncated,
    format: !heading.test(text) && !commentary.test(text) && !endTag.test(text),
    bridge: !copiesPreviousEnding(text, previousTail),
    repetition: repeatRatio(text, words >= 2500 ? 12 : 10) < 0.18,
  };
  const feedback: string[] = [];
  if (!gates.length) feedback.push(truncated
    ? '上次超过本段上限而被截断，请在本段字数上限内写完并自然收束。'
    : `上次只有 ${words} 个非空白字，本段至少写 ${minimum} 字，用新的情节推进充实篇幅。`);
  if (!gates.format) feedback.push('直接输出小说正文，删掉章标题、作者说明和单独的待续标记。');
  if (!gates.bridge) feedback.push('上次开头复制了紧邻结尾的文字，请从接下来的动作或对话写起。');
  if (!gates.repetition) feedback.push('上次有过多重复片段，请删除反复叙述，把篇幅用于推进情节。');
  return { gates, feedback };
}
