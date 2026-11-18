/**
 * 本地「假模型」上游 —— 只用于验证真实链路（HTTP + SSE + 前端 + 门禁）是否接通，
 * 不参与产品运行时。它按三种角色返回合法响应：
 *   Agent1 清洗 JSON / Agent2 四拍蓝图 JSON / Agent3 正文流式文本
 *
 *   node scripts/lib/fake-upstream.mjs   # 监听 8799
 */
import { createServer } from 'node:http';

const PORT = Number(process.env.FAKE_PORT ?? 8799);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const WHO = ['我', '对手', '周围的人', '门口的人', '坐在后排的人'];
const ACT = ['把公证书推过去', '把手机翻过来', '按住桌沿', '亮出那份复印件', '把时间戳圈出来', '把录音笔按下', '把电脑转过去'];
const MOOD = ['声音压得很低', '手指一直在抖', '没有再看我一眼', '把话咽了回去', '脸色白得厉害', '盯着签名看了很久'];
const DETAIL = [
  '墙上的钟走到九点四十分，没有人去看它。',
  '桌上的茶已经凉了，杯壁挂着一圈茶渍。',
  '窗外的雨小了一阵，随后又大起来。',
  '空调出风口在头顶嗡嗡地响，声音比刚才清楚。',
  '有人把手机屏幕朝下扣在桌面上。',
  '门缝里的光暗了一下，随即恢复。',
  '走廊里传来推车的声音，慢慢远了。',
  '那把空椅子被人无意中踢了一下，转半圈。',
];
const PUNCH = '他欠我的从来不是一句对不起，是整整三年。';

function gcd(a, b) {
  return b === 0 ? a : gcd(b, a % b);
}

function coprime(n) {
  for (let s = 7; s < n; s += 2) if (gcd(s, n) === 1) return s;
  return 1;
}

function prose(target, final) {
  const blocks = [
    '我把牛皮纸袋里的东西摊开，推到对手面前，指尖压在钢印上。',
    '“自己看。”我的声音不高，“第一页第三行，是谁的名字。”',
    '对手伸手来抢，指节磕在桌沿上，纸页散成扇形。',
  ];
  let k = 0;
  while (blocks.join('').length < target * 0.95 && k < 400) {
    const who = WHO[k % WHO.length];
    const act = ACT[(k * 3) % ACT.length];
    const mood = MOOD[(k * coprime(MOOD.length)) % MOOD.length];
    const detail = DETAIL[(k * coprime(DETAIL.length)) % DETAIL.length];
    blocks.push(`${who}${act}，${mood}。${detail}`);
    k += 1;
  }
  if (final) blocks.push(PUNCH);
  return blocks.join('\n\n');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'authorization,content-type',
    });
    res.end();
    return;
  }
  if (req.url?.startsWith('/v1/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'stub-model' }] }));
    return;
  }
  if (req.method !== 'POST' || !req.url?.startsWith('/v1/chat/completions')) {
    res.writeHead(404).end('not found');
    return;
  }

  const body = await readBody(req);
  const sys = body.messages?.find((m) => m.role === 'system')?.content ?? '';
  const user = body.messages?.find((m) => m.role === 'user')?.content ?? '';
  const wantStream = Boolean(body.stream);

  let content;
  if (user.includes('连通成功')) {
    content = '连通成功';
  } else if (sys.includes('商业卡点清洗专家')) {
    const marker = '下面是需要清洗的原始文本：';
    const idx = user.indexOf(marker);
    const raw = idx >= 0 ? user.slice(idx + marker.length).trim() : user;
    content = JSON.stringify({
      source_type: 'raw_text',
      cleaned_text: raw,
      total_char_count: raw.length,
      length_tier: 'STANDARD_PAYWALL_30_45_PCT',
      ending_anchor: raw.slice(-300),
      paywall_detected: false,
    });
  } else if (sys.includes('爆款短篇网文主编')) {
    const m = user.match(/目标续写字数\s*\n?\s*(\d+)/) ?? user.match(/(\d{4,5})\s*字/);
    const total = m ? Number(m[1]) : 7500;
    const parts = [0.27, 0.4, 0.33].map((w) => Math.max(800, Math.round(total * w)));
    content = JSON.stringify({
      story_bible: {
        pov: '第一人称（“我”）',
        bait_type: '憋屈 → 反击',
        style_fingerprint: {
          avg_sentence_len: 18,
          dialogue_ratio: '40%',
          tone_keywords: ['快节奏', '强情绪'],
          forbidden_cliches: ['嘴角勾起一抹弧度'],
        },
        characters: [
          { name: '我（主角）', role: '主角', traits: '清醒', current_state: '刚亮出证据，手里还有第二层底牌' },
          { name: '对手', role: '反派', traits: '傲慢', current_state: '以为还能压住场面' },
        ],
      },
      segment_outlines: parts.map((words, i) => ({
        segment_index: i + 1,
        segment_role: ['第 1 段 · 卡点即时兑现段', '第 2 段 · 二次反转与情绪加码段', '第 3 段 · 终局清算与金句收尾段'][i],
        target_words: words,
        beats: {
          qi: `起：第 ${i + 1} 段正面兑现悬念`,
          cheng: '承：旁观者态度倒戈',
          zhuan: '转：反派反扑被当场反杀',
          he: '合：留出过渡钩子',
        },
      })),
    });
  } else {
    const m = user.match(/(?:目标约|再补约|约)\s*(\d+)\s*字/);
    const target = m ? Number(m[1]) : 1200;
    content = prose(target, /终局红线|第 3\/3 段|最后 1 段/.test(user));
  }

  if (!wantStream) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'stub',
        choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: content.length },
      }),
    );
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
  });
  const chunkSize = 40;
  for (let i = 0; i < content.length; i += chunkSize) {
    const piece = content.slice(i, i + chunkSize);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
    await sleep(6);
  }
  res.write('data: [DONE]\n\n');
  res.end();
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`假模型上游已启动 → http://127.0.0.1:${PORT}/v1 （仅供链路验证）`);
});
