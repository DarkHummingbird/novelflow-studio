import { readSSE } from '../lib/api';
import type { StoryAnalysis } from '../lib/story-analysis';
import type { Account } from './account';

export type Length = 'short' | 'medium' | 'long';
export type StreamEvent =
  | { type: 'meta'; id: string }
  | { type: 'analysis'; analysis: StoryAnalysis }
  | { type: 'delta'; text: string }
  | { type: 'reset'; text: string }
  | { type: 'done'; text: string; charged: boolean; chargedCents: number; account: Account }
  | { type: 'error'; code: string };

export class ReaderError extends Error {
  constructor(readonly code: string) { super(code); }
}

export async function request(path: string, session: string, body?: object, signal?: AbortSignal) {
  const headers = new Headers();
  if (session) headers.set('Authorization', `Bearer ${session}`);
  if (body) headers.set('Content-Type', 'application/json');
  const response = await fetch(`/api${path}`, {
    headers, signal, method: body ? 'POST' : 'GET', body: body && JSON.stringify(body),
  });
  return checked(response);
}

async function checked(response: Response) {
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new ReaderError(data?.code ?? 'unavailable');
  }
  return response;
}

export async function extractText(file: File, session: string, signal: AbortSignal): Promise<{ text: string; gaps: number }> {
  const format: Record<string, string> = { mp4: 'video/mp4', mov: 'video/quicktime', m4v: 'video/x-m4v' };
  const extension = file.name.split('.').at(-1)?.toLowerCase() ?? '';
  if (!Object.hasOwn(format, extension)) throw new ReaderError('video_format');
  if (file.size > 100 * 1024 * 1024) throw new ReaderError('video_size');
  const headers = new Headers({ 'Content-Type': format[extension] });
  if (session) headers.set('Authorization', `Bearer ${session}`);
  const response = await fetch('/api/ocr', { method: 'POST', headers, signal, body: file });
  return (await checked(response)).json();
}

export async function streamStory(
  text: string, length: Length, session: string, signal: AbortSignal, maxCharge: number, tierId: string,
  onEvent: (event: StreamEvent) => void,
) {
  const response = await request('/generate', session, { text, length, maxCharge, tierId }, signal);
  let completed = false;
  await readSSE(response, (data) => {
    const event = JSON.parse(data) as StreamEvent;
    if (event.type === 'error') throw new ReaderError(event.code);
    onEvent(event);
    if (event.type !== 'done') return 'continue';
    completed = true;
    return 'done';
  });
  if (!completed) throw new ReaderError('unavailable');
}

const messages: Record<string, string> = {
  video_format: '请选择 MP4、MOV 或 M4V 录屏。',
  video_size: '录屏超过 100 MB，请截短后重新上传。',
  video_duration: '录屏超过 3 分钟，请截短后重新上传。',
  invalid_video: '无法读取这个视频，请确认文件能正常播放后再上传。',
  ocr_empty: '没有识别到文字。请换一段清晰、滚动较慢的录屏，或使用文字输入。',
  ocr_busy: '有一段录屏正在处理，请稍后重试。',
  ocr_unavailable: '录屏识别暂时不可用，可以先使用文字输入。',
  invalid_input: '请检查输入内容。',
  invalid_code: '短信验证码无效，请检查后重试。',
  invalid_phone: '请输入有效的手机号。',
  sms_unavailable: '短信暂时无法发送，请稍后再试。',
  plan_unavailable: '该商品当前不可购买。',
  payment_unavailable: '在线支付暂不可用，请稍后再试。',
  price_changed: '商品价格或权益已更新，请重新打开订阅与充值确认。',
  payment_mismatch: '订单支付信息不匹配，暂未入账。',
  not_found: '未找到该订单，请核对登录的手机号。',
  phone_required: '请先完成手机号登录。',
  quota_exhausted: '续写额度不足，可以购买订阅或充值。',
  confirm_price: '单篇价格已变化，请刷新额度后确认。',
  login_required: '登录已过期，请重新登录。',
  account_blocked: '此账号已停用。',
  generation_running: '请先等待当前续写结束。',
  tier_unavailable: '该续写档位已停用，请重新选一个档位。',
  length_unavailable: '当前暂不支持这个续写长度。',
  rate_limited: '操作过于频繁，请稍后重试。',
  cancelled: '已停止生成，本次不扣次数。',
  analysis_failed: '前文分析未完成，可以重试。本次不扣次数或余额。',
  unavailable: '服务暂时繁忙，请稍后重试。',
};

export function errorText(error: unknown) {
  return error instanceof ReaderError ? messages[error.code] ?? messages.unavailable : '连接中断，请刷新后重试。';
}
