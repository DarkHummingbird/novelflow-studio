import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { BookOpen, Gauge, KeyRound, Layers, ListOrdered, Users, Workflow } from 'lucide-react';
import { ReaderError, request } from '../reader/api';
import { orderLabel, yuan } from '../reader/account';
import type { Order, Plan } from '../reader/account';

import ModelSetup from './ModelSetup';
import type { ModelSettings, ModelTier } from './ModelSetup';
import type { ModelVendor } from '../lib/model-vendors';

interface User {
  id: string; phone: string; status: string; remaining: number; balanceCents: number; generations: number;
}
interface Stats {
  total: number; success: number | null; tokens_in: number | null; tokens_out: number | null;
  cost_cents: number | null; metered: number; wallet_charge_cents: number | null; p50: number | null; p95: number | null;
  failures: { status: string; count: number }[];
}
interface Dashboard {
  stats: Stats; settings: ModelSettings; models: ModelTier[]; plans: Plan[]; orders: Order[];
  storyPriceCents: number; paymentsEnabled: boolean;
  vendors: Record<ModelVendor, { configured: boolean }>; effectiveDefaultModel: string | null;
}
const sections = [
  { id: 'overview', name: '运行概览', icon: Gauge },
  { id: 'models', name: '模型与开关', icon: Workflow },
  { id: 'plans', name: '订阅与定价', icon: Layers },
  { id: 'orders', name: '支付订单', icon: ListOrdered },
  { id: 'users', name: '用户', icon: Users },
] as const;
const messages: Record<string, string> = {
  admin_unconfigured: '管理后台尚未初始化。',
  admin_local_only: '请在运行服务的电脑上通过本机地址打开管理后台。',
  admin_credentials: '登录信息有误，请核对后再试。',
  invalid_input: '请检查字段格式与范围。',
  endpoint_not_allowed: '该模型地址未加入服务端允许列表。',
  replacement_key_required: '该端点需要单独配置 API Key。',
  settings_secret_required: '请先配置服务端加密主密钥 NF_SETTINGS_SECRET。',
  model_unconfigured: '请先保存对应模型服务的 API Key。',
  vendor_unreachable: '暂时连不上厂商接口，请检查服务端网络。',
  vendor_key_invalid: '厂商未接受这个 Key，请在厂商平台检查 Key 和项目权限。',
  vendor_balance: '厂商账户余额不足，请在厂商平台查看账单。',
  vendor_model_missing: '此 Key 无法使用该模型，请查看可用模型后重选。',
  vendor_rate_limited: '厂商限制了查询频率，请稍后再试。',
  model_test_failed: '模型连通性测试失败，请检查端点、型号和凭据。',
  generation_running: '该用户正在生成，请稍后再减少额度。',
  insufficient_quota: '扣减额度超出该用户当前可用篇数。',
  plan_unavailable: '请先启用所选套餐。',
  rate_limited: '操作过于频繁，请稍后重试。',
};

function errorMessage(error: unknown) {
  return error instanceof ReaderError ? messages[error.code] ?? '操作失败，请稍后重试。' : '连接失败，请稍后重试。';
}

export default function Admin() {
  const [tab, setTab] = useState<typeof sections[number]['id']>('overview');
  const [view, setView] = useState<Dashboard>();
  const [state, setState] = useState<'loading' | 'locked' | 'ready'>('loading');
  const [working, setWorking] = useState(false);
  const [loginMode, setLoginMode] = useState<{ configured: boolean; otpRequired: boolean }>();
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [users, setUsers] = useState<User[]>([]);
  const [q, setQ] = useState('');
  const [editPlan, setEditPlan] = useState<Plan>();
  const [productKind, setProductKind] = useState<Plan['kind']>('subscription');
  const [day, setDay] = useState(() => {
    const date = new Date();
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  });
  const planKey = editPlan?.id ?? 'new';

  async function loadDashboard(selectedDay = day) {
    const date = new Date(selectedDay + 'T00:00:00');
    const since = date.getTime();
    const until = date.setDate(date.getDate() + 1);
    try {
      const data = await (await request(`/admin/dashboard?since=${since}&until=${until}`, '')).json() as Dashboard;
      setView(data);
      setState('ready');
    } catch (problem) {
      if (problem instanceof ReaderError && problem.code === 'admin_required') {
        const mode = await (await request('/admin/login', '')).json();
        setLoginMode(mode);
        setView(undefined); setUsers([]); setEditPlan(undefined); setState('locked');
      } else throw problem;
    }
  }

  async function searchUsers(query = q) {
    const data = await (await request(`/admin/users?q=${encodeURIComponent(query)}`, '')).json();
    setUsers(data.users);
  }

  useEffect(() => {
    void loadDashboard().catch((problem) => { setError(errorMessage(problem)); setState('locked'); });
  // Load the initial dashboard once.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function perform(action: () => Promise<void>, success?: string) {
    if (working) return;
    setWorking(true);
    setMessage('');
    setError('');
    try {
      await action();
      if (success) setMessage(success);
    } catch (problem) {
      if (problem instanceof ReaderError && problem.code === 'admin_required') {
        setView(undefined); setUsers([]); setEditPlan(undefined); setState('locked');
      }
      setError(errorMessage(problem));
    } finally {
      setWorking(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>, action: (data: FormData) => Promise<void>, success?: string) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    void perform(() => action(data), success);
  }

  const feedback = <div className="admin-feedback" aria-live="polite">
    {error && <p className="admin-error" role="alert">{error}</p>}
    {message && <p className="admin-message">{message}</p>}
  </div>;

  if (state !== 'ready' || !view) return (
    <main className="admin-login">
      <BookOpen size={26} aria-hidden="true" /><h1>续章工坊管理后台</h1>
      {state === 'loading' ? <p>正在加载…</p> : loginMode?.configured ? <form onSubmit={(event) => submit(event, async (data) => {
        await request('/admin/login', '', {
          password: data.get('password'), ...(loginMode.otpRequired ? { otp: data.get('otp') } : {}),
        });
        await loadDashboard();
      })}>
        <fieldset disabled={working}>
          <label>管理员密码<input type="password" name="password" autoComplete="current-password" required maxLength={256} /></label>
          {loginMode.otpRequired && <label>动态验证码<input name="otp" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required /></label>}
          <button type="submit"><KeyRound size={17} aria-hidden="true" /> 登录后台</button>
        </fieldset>
      </form> : loginMode && <p>管理后台尚未初始化。</p>}
      {feedback}
    </main>
  );

  const { stats, settings } = view;
  return (
    <div className="admin-shell">
      <aside>
        <div className="admin-brand"><BookOpen size={21} aria-hidden="true" /> 续章工坊</div>
        <nav aria-label="管理模块">{sections.map(({ id, name, icon: Icon }) => (
          <button key={id} value={id} type="button" aria-current={id === tab ? 'page' : undefined}
            disabled={working} onClick={() => {
              setTab(id); setError(''); setMessage('');
              if (id === 'users') void perform(() => searchUsers());
            }}><Icon size={17} aria-hidden="true" />{name}</button>
        ))}</nav>
      </aside>
      <main className="admin-main">
        <header className="admin-header">
          <h1>{sections.find((item) => item.id === tab)?.name}</h1>
          <button className="admin-secondary" disabled={working} onClick={() => void perform(async () => {
            await request('/admin/logout', '', {}); await loadDashboard();
          })}>退出后台</button>
        </header>
        {feedback}
        {tab === 'overview' && <>
          <form className="admin-toolbar" onSubmit={(event) => submit(event, async () => loadDashboard())}>
            <label>统计日期<input type="date" value={day} onChange={(event) => setDay(event.target.value)} required /></label>
            <button className="admin-secondary" disabled={working}>查询</button>
          </form>
          <div className="admin-metrics">
            <div><span>生成次数</span><strong>{stats.total}</strong></div>
            <div><span>成功率</span><strong>{stats.total ? `${Math.round((stats.success ?? 0) * 100 / stats.total)}%` : '—'}</strong></div>
            <div><span>估算模型成本</span><strong>{stats.cost_cents === null ? '—' : yuan(stats.cost_cents)}</strong><small>{stats.metered} 次有完整用量</small></div>
            <div><span>单篇模型成本</span><strong>{stats.cost_cents === null || !stats.metered ? '—' : yuan(stats.cost_cents / stats.metered)}</strong></div>
            <div><span>P50 / P95 延迟</span><strong>{stats.p50 == null || stats.p95 == null ? '—' : `${(stats.p50 / 1000).toFixed(1)} / ${(stats.p95 / 1000).toFixed(1)} 秒`}</strong></div>
            <div><span>输入 / 输出 tokens</span><strong>{stats.tokens_in ?? 0} / {stats.tokens_out ?? 0}</strong></div>
            <div><span>续写余额扣款</span><strong>{yuan(stats.wallet_charge_cents ?? 0)}</strong></div>
          </div>
          <section className="admin-panel"><h2>失败分布</h2>
            {stats.failures.length ? <ul>{stats.failures.map((row) => <li key={row.status}>
              {{ degraded: '质检降级', failed: '生成失败', cancelled: '取消', timeout: '生成超时',
                analysis_failed: '前文分析未完成', upstream_rate: '模型限流', upstream_auth: '模型鉴权失败', upstream_failed: '模型响应失败' }[row.status] ?? row.status} · {row.count}
            </li>)}</ul> : <p>该时段暂无失败记录。</p>}
          </section>
        </>}
        {tab === 'models' && <ModelSetup vendors={view.vendors} tiers={view.models} settings={settings}
          defaultId={view.effectiveDefaultModel} basePrice={view.storyPriceCents}
          working={working} refresh={loadDashboard} perform={perform} message={setMessage} />}
        {tab === 'plans' && <>
          <section className="admin-panel">
            <h2>基础单篇价格</h2>
            <p>余额付费时，未单独定价的续写档位使用这里的价格。</p>
            <form key={view.storyPriceCents} className="admin-toolbar" onSubmit={(event) => submit(event, async (data) => {
              await request('/admin/story-price', '', { priceCents: Number(data.get('story_price')) });
              await loadDashboard();
            }, '单篇价格已保存。')}>
              <label>每篇价格（分）<input name="story_price" type="number" min={1} max={100000}
                defaultValue={view.storyPriceCents || undefined} required /></label>
              <button disabled={working}>保存单篇价格</button>
            </form>
          </section>
          <section className="admin-panel">
            <h2>订阅和充值商品</h2>
            {!view.paymentsEnabled && <p>在线支付尚未配置。</p>}
            <div className="admin-table"><table><thead><tr><th>名称</th><th>类型</th><th>售价</th><th>权益</th><th>状态</th><th>操作</th></tr></thead>
              <tbody>{view.plans.map((plan) => <tr key={plan.id}><td>{plan.name}</td>
                <td>{plan.kind === 'subscription' ? '订阅' : '余额充值'}</td><td>{yuan(plan.price_cents)}</td>
                <td>{plan.kind === 'subscription' ? `${plan.period_days} 天 · ${plan.quota} 篇` : `到账 ${yuan(plan.price_cents)}`}</td>
                <td>{plan.active ? '在售' : '下架'}</td><td><button className="admin-secondary" onClick={() => {
                  setEditPlan(plan); setProductKind(plan.kind);
                }}>编辑</button></td></tr>)}</tbody></table></div>
            <h3>{editPlan ? '编辑商品' : '新增商品'}</h3>
            {editPlan && <button className="admin-secondary" onClick={() => {
              setEditPlan(undefined); setProductKind('subscription');
            }}>新建商品</button>}
            <form key={planKey} onSubmit={(event) => {
              const form = event.currentTarget;
              submit(event, async (data) => {
              await request('/admin/plans', '', {
                id: editPlan?.id ?? data.get('id'), kind: productKind, name: data.get('name'),
                price_cents: Number(data.get('price_cents')), period_days: Number(data.get('period_days')),
                quota: Number(data.get('quota')), active: data.has('active'),
              });
              if (!editPlan) form.reset();
              await loadDashboard();
            }, '商品已保存。'); }}>
              <fieldset disabled={working} className="admin-grid">
                <label>商品类型<select name="kind" value={productKind} onChange={(event) => setProductKind(event.target.value as Plan['kind'])}>
                  <option value="subscription">订阅</option><option value="recharge">余额充值</option>
                </select></label>
                <label>商品 ID<input name="id" required pattern="[a-z0-9](?:[a-z0-9]|-)*" maxLength={56} defaultValue={editPlan?.id} readOnly={Boolean(editPlan)} /></label>
                <label>商品名称<input name="name" required maxLength={60} defaultValue={editPlan?.name} /></label>
                <label>售价（分）<input name="price_cents" type="number" min={1} max={10000000} required defaultValue={editPlan?.price_cents} /></label>
                {productKind === 'subscription' && <>
                  <label>含篇数<input name="quota" type="number" min={1} max={10000} required defaultValue={editPlan?.quota || 1} /></label>
                  <label>有效天数<input name="period_days" type="number" min={1} max={365} required defaultValue={editPlan?.period_days || 30} /></label>
                </>}
                <label className="admin-check"><input type="checkbox" name="active" defaultChecked={editPlan?.active !== 0} /> 在售</label>
                <button type="submit">保存商品</button>
              </fieldset>
            </form>
          </section>
        </>}
        {tab === 'orders' && <section className="admin-panel">
          <div className="admin-header"><h2>支付订单</h2>
            <button className="admin-secondary" disabled={working} onClick={() => void perform(() => loadDashboard())}>刷新订单</button></div>
          <div className="admin-table"><table><thead><tr><th>订单号</th><th>手机</th><th>商品</th><th>类型</th><th>金额</th><th>状态</th><th>创建时间</th></tr></thead>
            <tbody>{view.orders.map((order) => <tr key={order.id}><td><code>{order.id}</code></td><td>{order.phone}</td>
              <td>{order.name}</td><td>{order.kind === 'subscription' ? '订阅' : order.kind === 'recharge' ? '余额充值' : '历史订单'}</td>
              <td>{yuan(order.amount_cents)}</td><td>{orderLabel[order.status]}</td>
              <td>{new Date(order.created).toLocaleString()}</td></tr>)}</tbody></table></div>
        </section>}
        {tab === 'users' && <section className="admin-panel">
          <h2>用户与额度</h2>
          <form className="admin-toolbar" onSubmit={(event) => submit(event, async () => searchUsers())}>
            <label>按手机号查找<input type="search" maxLength={30} value={q} onChange={(event) => setQ(event.target.value)} /></label>
            <button className="admin-secondary" disabled={working}>查询</button>
          </form>
          <div className="admin-table"><table><thead><tr><th>手机</th><th>剩余 / 余额</th><th>生成次数</th><th>账号与额度调整</th></tr></thead>
            <tbody>{users.map((user) => <tr key={user.id}>
              <td>{user.phone}</td><td>{user.remaining} 篇 · {yuan(user.balanceCents)}</td><td>{user.generations}</td>
              <td><form key={`${user.status}:${user.remaining}`} onSubmit={(event) => submit(event, async (data) => {
                await request('/admin/users', '', { id: user.id, delta: Number(data.get('delta')), status: data.get('status') });
                await searchUsers();
              }, '用户设置已更新。')}><fieldset disabled={working} className="admin-inline">
                <select name="status" aria-label="账号状态" defaultValue={user.status}>
                  <option value="active">正常</option><option value="blocked">封禁</option></select>
                <input type="number" name="delta" min={-10000} max={10000} required defaultValue={0} aria-label="增减篇数" />
                <button className="admin-secondary">应用</button>
              </fieldset></form></td>
            </tr>)}</tbody></table></div>
          {!users.length && <p>暂无符合条件的用户。</p>}
        </section>}
      </main>
    </div>
  );
}
