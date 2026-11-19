import { describe, expect, it } from 'vitest';
import { stitchScreens } from '../server/ocr/stitch';
import type { Screen } from '../server/ocr/stitch';

const a = '清晨的雾还没有散去，青石桥上空无一人。';
const b = '林舟把纸灯放在桥栏上，转身望向河面。';
const c = '水下传来一阵钟声，岸边的鸟雀纷纷飞走。';
const d = '他从衣袋里取出铜钥匙，钥匙已经发黑。';
const e = '木船慢慢贴住石阶，一个陌生人站起来。';

function screen(at: number, ...text: string[]): Screen {
  return { at, lines: text.map((line, index) => ({ text: line, y: 0.2 + index * 0.15 })) };
}

describe('scrolling recording reconstruction', () => {
  it('stitches advancing and repeated frames despite punctuation and an OCR typo', () => {
    const result = stitchScreens([
      screen(0, a, b, c),
      screen(1, b.replace('。', ''), c.replace('纷纷', '分分'), d),
      screen(2, a, b, c),
      screen(3, c, d, e),
    ]);
    expect(result.text).toBe([a, b, c, d, e].join('\n'));
    expect(result.gaps).toBe(0);
  });

  it('drops recurring screen chrome and clipped lines', () => {
    const frames = [screen(0, a, b), screen(1, a, b, c), screen(2, b, c, d)];
    for (const frame of frames) {
      frame.lines.unshift({ text: '最近阅读', y: 0.07 }, { text: '角落乱码', y: 0.017 });
      frame.lines.push({ text: '广告', y: 0.94 });
    }
    const result = stitchScreens(frames);
    expect(result.text).toBe([a, b, c, d].join('\n'));
    expect(result.gaps).toBe(0);
  });

  it('keeps non-overlapping lines and flags a probable skipped section', () => {
    expect(stitchScreens([screen(0, a, b), screen(2, d, e)])).toMatchObject({
      text: [a, b, d, e].join('\n'), gaps: 1,
    });
  });
});
