import { useEffect, useRef, useState } from 'react';
import { ArrowDown, BookOpen, Copy, Download, RotateCcw, FileText, Film, Upload } from 'lucide-react';
import { errorText, extractText, request, ReaderError, streamStory } from './api';
import type { Length } from './api';
import { loadDraft, saveDraft } from './draft';
import { countWords } from '../lib/text';
import type { StoryAnalysis } from '../lib/story-analysis';
import AccountDialog from './AccountDialog';
import { yuan } from './account';
import type { Account } from './account';

const lengths: { id: Length; label: string; goal: number }[] = [
  { id: 'short', label: '短', goal: 4000 },
  { id: 'medium', label: '中', goal: 6000 },
  { id: 'long', label: '长', goal: 8000 },
];

type Generation = { controller: AbortController; id?: string };

const sessionKey = 'novelflow-reader-session';

export default function Reader() {
  const [session, setSession] = useState(() => localStorage.getItem(sessionKey) || '');
  const [account, setAccount] = useState<Account>();
  const remaining = account?.remaining;
  const [tierId, setTierId] = useState('');
  const tier = account?.tiers.find((item) => item.id === tierId) ?? account?.tiers[0];
  const storyCharge = remaining === 0 ? tier?.priceCents ?? 0 : 0;
  const [returnedOrder, setReturnedOrder] = useState(() => {
    const value = new URLSearchParams(window.location.search).get('payment');
    return value && /^[a-f0-9-]{36}$/.test(value) ? value : undefined;
  });
  const [dialog, setDialog] = useState<'login' | 'plans' | undefined>(() => returnedOrder ? 'plans' : undefined);
  const [refresh, setRefresh] = useState(0);
  const [source, setSource] = useState('');
  const [showEditor, setShowEditor] = useState(false);
  const [needsReview, setNeedsReview] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [sourceMessage, setSourceMessage] = useState('');
  const [recording, setRecording] = useState<File>();
  const [previewUrl, setPreviewUrl] = useState('');
  const [loadingText, setLoadingText] = useState(false);
  const [length, setLength] = useState<Length>('short');
  const [story, setStory] = useState('');
  const [analysis, setAnalysis] = useState<StoryAnalysis>();
  const [busy, setBusy] = useState(false);
  const [complete, setComplete] = useState(false);
  const [notice, setNotice] = useState('');
  const [draftError, setDraftError] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const output = useRef<HTMLElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const videoPicker = useRef<HTMLInputElement>(null);
  const textPicker = useRef<HTMLInputElement>(null);
  const extraction = useRef<AbortController | null>(null);
  const edited = useRef(false);
  const run = useRef<Generation | null>(null);
  const chars = countWords(source);
  const inputBusy = busy || extracting || loadingText;

  useEffect(() => {
    void loadDraft().then((draft) => {
      if (edited.current) return;
      setSource(draft.text);
      setNeedsReview(draft.needsReview);
      if (draft.text) setShowEditor(true);
    })
      .catch(() => setDraftError(true));
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void request('/me', session, undefined, controller.signal)
      .then((response) => response.json())
      .then((data: Account) => setAccount(data))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof ReaderError && error.code === 'login_required') {
          localStorage.removeItem(sessionKey);
          setSession('');
        }
        setNotice(errorText(error));
      });
    return () => controller.abort();
  }, [session, refresh]);

  useEffect(() => {
    if (!recording) {
      setPreviewUrl('');
      return;
    }
    const url = URL.createObjectURL(recording);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [recording]);

  useEffect(() => {
    setLength((value) => (lengths.find((item) => item.id === value)?.goal ?? 4000) > (tier?.maxOutput ?? 9000) ? 'short' : value);
  }, [tier?.maxOutput]);

  function updateDraft(text: string, review = needsReview) {
    edited.current = true;
    setSource(text);
    setNeedsReview(review);
    void saveDraft({ text, needsReview: review }).catch(() => setDraftError(true));
  }

  async function importRecording(file: File) {
    if (inputBusy || extraction.current) return;
    edited.current = true;
    const controller = new AbortController();
    extraction.current = controller;
    setExtracting(true);
    setRecording(file);
    setSourceMessage('正在上传并识别录屏，请保留此页面。');
    try {
      const result = await extractText(file, session, controller.signal);
      updateDraft(result.text, true);
      setShowEditor(true);
      setSourceMessage(result.gaps
        ? `识别完成，有 ${result.gaps} 处相邻画面未可靠接上。请对照录屏补齐漏段并核对文字。`
        : '识别完成，请对照录屏核对文字和段落顺序。');
    } catch (error) {
      setSourceMessage(controller.signal.aborted ? '已取消录屏识别。' : errorText(error));
    } finally {
      extraction.current = null;
      setExtracting(false);
    }
  }

  async function importText(file: File) {
    if (inputBusy) return;
    setLoadingText(true);
    edited.current = true;
    try {
      if (!file.name.toLowerCase().endsWith('.txt') || file.size > 96_000) {
        throw new Error('只支持不超过 96 KB 的 TXT 文件。');
      }
      const bytes = await file.arrayBuffer();
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch { throw new Error('请将 TXT 另存为 UTF-8 编码后再上传。'); }
      if (!text.trim()) throw new Error('TXT 文件没有可用文字。');
      updateDraft(text, false);
      setShowEditor(true);
      setRecording(undefined);
      setSourceMessage('已导入 TXT，可以核对并修改前文。');
    } catch (error) {
      setSourceMessage(error instanceof Error ? error.message : 'TXT 导入失败。');
    } finally {
      setLoadingText(false);
    }
  }

  function closeDialog() {
    const url = new URL(window.location.href);
    if (returnedOrder) {
      url.searchParams.delete('payment');
      url.searchParams.delete('cancelled');
      window.history.replaceState(null, '', url);
      setReturnedOrder(undefined);
    }
    setDialog(undefined);
  }

  function updateSession(value: string) {
    if (value) localStorage.setItem(sessionKey, value);
    else localStorage.removeItem(sessionKey);
    setAccount(undefined);
    setSession(value);
  }

  async function start() {
    if (run.current || inputBusy || needsReview || !chars || chars > 8000) return;
    if (!tier) return;
    if (remaining === 0 && (!storyCharge || (account?.balanceCents ?? 0) < storyCharge)) return setDialog('plans');
    const current: Generation = { controller: new AbortController() };
    run.current = current;
    setBusy(true);
    setComplete(false);
    setStory('');
    setAnalysis(undefined);
    setNotice('');
    requestAnimationFrame(() => output.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
    try {
      await streamStory(source, length, session, current.controller.signal, storyCharge, tier.id, (event) => {
        if (event.type === 'meta') current.id = event.id;
        if (event.type === 'analysis') setAnalysis(event.analysis);
        if (event.type === 'reset') {
          setStory(event.text ?? '');
          setNotice('正在根据质检结果修订当前段，已完成的内容会保留。');
        }
        if (event.type === 'delta') setStory((previous) => previous + event.text);
        if (event.type === 'done') {
          setStory(event.text);
          setAccount(event.account);
          setComplete(true);
          setNotice(event.chargedCents > 0 ? `已从余额扣除 ${yuan(event.chargedCents)}。`
            : event.charged ? '' : '这篇续章未达到交付标准，已保留供阅读，本次不扣次数。');
        }
      });
    } catch (error) {
      if (current.controller.signal.aborted) setNotice('已停止生成，本次不扣次数。');
      else {
        setNotice(errorText(error));
        setRefresh((value) => value + 1);
        if (error instanceof ReaderError && error.code === 'login_required') {
          localStorage.removeItem(sessionKey);
          setSession('');
        }
      }
    } finally {
      run.current = null;
      setBusy(false);
      setCancelling(false);
    }
  }

  async function cancel() {
    const current = run.current;
    if (!current || cancelling) return;
    setCancelling(true);
    try {
      if (current.id) await request(`/generate/${current.id}/cancel`, session, {});
      else current.controller.abort();
    } catch {
      current.controller.abort();
    }
  }

  function download() {
    const link = document.createElement('a');
    const url = URL.createObjectURL(new Blob([story], { type: 'text/plain;charset=utf-8' }));
    link.href = url;
    link.download = '续章工坊.txt';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return (
    <main className="reader">
      <header className="reader-header">
        <span className="reader-brand"><BookOpen aria-hidden="true" size={21} /> 续章工坊</span>
        <div className="reader-account">
          <span aria-live="polite">{remaining === undefined ? '正在查询额度' :
            !session && remaining === 1 ? '剩 1 篇免费' : `剩余 ${remaining} 篇`}</span>
          {account?.phoneVerified && <span>余额 {yuan(account.balanceCents)}</span>}
          <button className="reader-link" disabled={busy} onClick={() => setDialog('login')}>{session ? '账号' : '登录'}</button>
          <button className="reader-link" disabled={busy} onClick={() => setDialog('plans')}>订阅与充值</button>
        </div>
      </header>

      {account?.announcement && <p className="reader-notice">{account.announcement}</p>}
      <section className="reader-input" aria-labelledby="reader-title">
        <h1 id="reader-title">从小说录屏续写</h1>
        <div className="recording-panel">
          <div className="recording-icon"><Film aria-hidden="true" size={25} /></div>
          <div className="recording-body">
            <h2>上传小说录屏</h2>
            <p>录下正文，从上往下慢慢滚动，让相邻画面保留几行相同文字。</p>
            <span>MP4、MOV 或 M4V · 最长 3 分钟 · 最大 100 MB</span>
          </div>
          <input type="file" ref={videoPicker} hidden aria-label="小说录屏"
            accept=".mp4,.mov,.m4v,video/mp4,video/quicktime,video/x-m4v" onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = '';
              if (file) void importRecording(file);
            }} />
          <button className="recording-button" disabled={inputBusy} onClick={() => videoPicker.current?.click()}>
            <Upload aria-hidden="true" size={17} />{extracting ? '正在识别…' : '选择录屏'}
          </button>
          {extracting && <button className="reader-link" onClick={() => extraction.current?.abort()}>取消识别</button>}
          {recording && <span className="recording-name">{recording.name}</span>}
        </div>
        {sourceMessage && <p className="reader-notice" role="status">{sourceMessage}</p>}
        {previewUrl && !extracting && <details className="recording-preview">
          <summary>对照原录屏</summary>
          <video controls preload="none" src={previewUrl} />
        </details>}
        <div className="text-alternative">
          <span>没有录屏？</span>
          <button className="reader-link" disabled={inputBusy} onClick={() => {
            setShowEditor(true);
            requestAnimationFrame(() => input.current?.focus());
          }}><FileText aria-hidden="true" size={16} /> 粘贴文本</button>
          <input type="file" ref={textPicker} hidden aria-label="TXT 文件" accept=".txt,text/plain" onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = '';
            if (file) void importText(file);
          }} />
          <button className="reader-link" disabled={inputBusy} onClick={() => textPicker.current?.click()}>上传 TXT</button>
        </div>
        {showEditor && <div className="source-editor">
          <label htmlFor="reader-source">{needsReview ? '核对识别出的前文' : '小说前文'}</label>
          <textarea id="reader-source" ref={input} value={source} disabled={inputBusy}
            onChange={(event) => updateDraft(event.target.value)}
            placeholder="粘贴希望接着写的小说前文。" rows={8} />
          <div className="reader-count" data-over={chars > 8000}>{draftError && '本地草稿不可用 · '}{chars.toLocaleString()} / 8,000 字</div>
          {needsReview && <button className="reader-secondary" disabled={inputBusy || !chars || chars > 8000} onClick={() => {
            updateDraft(source, false);
            setSourceMessage('前文已确认，可以开始续写。');
          }}>确认前文</button>}
        </div>}
        {tier && <fieldset className="reader-tier" disabled={inputBusy || needsReview}>
          <legend>续写档位</legend>
          <select aria-label="续写档位" value={tier.id} onChange={(event) => setTierId(event.target.value)}>
            {account?.tiers.map((option) => <option key={option.id} value={option.id}>{option.label}
              {remaining === 0 && option.priceCents > 0 ? ` · ${yuan(option.priceCents)}/篇` : ''}</option>)}
          </select>
          <span>{remaining && remaining > 0 ? (account?.guest ? '本次可免费试写' : '本次使用 1 篇额度')
            : tier.priceCents ? `通过质检后扣 ${yuan(tier.priceCents)}` : '该档位的余额单价待设置'}</span>
        </fieldset>}
        <fieldset disabled={inputBusy || needsReview}>
          <legend>续写长度</legend>
          <div className="reader-lengths">
            {lengths.map((item) => (
              <label key={item.id} className={length === item.id ? 'selected' : ''}>
                <input type="radio" name="reader-length" value={item.id} checked={length === item.id}
                  disabled={item.goal > (tier?.maxOutput ?? 9000)} onChange={() => setLength(item.id)} />
                <strong>{item.label}</strong><span>约 {item.goal.toLocaleString()} 字</span>
              </label>
            ))}
          </div>
        </fieldset>
        <button className="reader-primary" disabled={inputBusy || needsReview || account?.paused || !tier || !chars || chars > 8000} onClick={() => void start()}>
          {busy ? (analysis ? '正在续写…' : '正在分析…') : account?.paused ? '续写服务已暂停' : account && !tier ? '续写暂未开通' : storyCharge ? `开始续写 · ${yuan(storyCharge)}` : '开始续写'} <ArrowDown aria-hidden="true" size={17} />
        </button>
      </section>

      <section ref={output} className="reader-output" aria-labelledby="reader-output-title">
        <div className="reader-output-header">
          <h2 id="reader-output-title">续章</h2>
          {busy && <button className="reader-link" disabled={cancelling} onClick={() => void cancel()}>停止生成</button>}
        </div>
        <p className="reader-disclosure">由 AI 生成，仅供参考</p>
        {notice && <p className="reader-notice" role="status">{notice}</p>}
        {analysis && <details className="story-analysis" open>
          <summary>前文分析</summary>
          <dl>
            <div><dt>主线剧情</dt><dd>{analysis.mainPlot}</dd></div>
            <div><dt>主要人物</dt><dd>{analysis.characters.length ? <ul>
              {analysis.characters.map((person, index) => (
                <li key={`${person.name}-${index}`}><strong>{person.name}</strong>{person.role && ` · ${person.role}`}
                  {person.state && `。 ${person.state}`}</li>
              ))}
            </ul> : '片段中未识别到明确的人物姓名或称呼。'}</dd></div>
            <div><dt>当前矛盾或待解事项</dt><dd>{analysis.conflict || '片段中没有明确的矛盾或阻碍。'}
              {analysis.openThreads.length > 0 && <ul>{analysis.openThreads.map((item, index) => <li key={index}>{item}</li>)}</ul>}
            </dd></div>
            <div><dt>录屏停在这里</dt><dd>{analysis.currentScene}</dd></div>
          </dl>
          <details>
            <summary>续写安排</summary>
            <ol>{analysis.partPlan.map((task, index) => <li key={index}>{task}</li>)}</ol>
          </details>
        </details>}
        {story && <div className="reader-story">{story}</div>}
        {!story && <p className="reader-placeholder">{busy ? (analysis ? '正在续写…' : '正在分析前文剧情和人物…') : '续写正文会显示在这里。'}</p>}
        {story && !busy && <div className="reader-actions">
          <button onClick={download}><Download size={16} aria-hidden="true" /> 下载 TXT</button>
          <button onClick={() => void navigator.clipboard.writeText(story).then(() => setNotice('已复制正文。'))
            .catch(() => setNotice('复制失败，可以下载 TXT。'))}><Copy size={16} aria-hidden="true" /> 复制</button>
          <button onClick={() => {
            updateDraft('', false); setStory(''); setAnalysis(undefined); setComplete(false); setNotice('');
            setSourceMessage(''); setRecording(undefined); setShowEditor(false);
          }}><RotateCcw size={16} aria-hidden="true" /> 换一篇</button>
        </div>}
        {story && !busy && !complete && <p className="reader-disclosure">当前显示已收到的正文片段。</p>}
      </section>

      {dialog && <AccountDialog mode={dialog} close={closeDialog} session={session} account={account} returnOrder={returnedOrder}
        onSession={updateSession} onAccount={setAccount} />}
    </main>
  );
}
