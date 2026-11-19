import { useEffect, useRef, useState } from 'react';
import { request, errorText } from './api';
import { orderLabel, yuan } from './account';
import type { Account, Order, Plan } from './account';

interface Props {
  mode: 'login' | 'plans';
  close: () => void;
  session: string;
  account?: Account;
  returnOrder?: string;
  onSession: (value: string) => void;
  onAccount: (value: Account) => void;
}

interface OrderResponse { order: Order; account: Account; checkoutUrl: string | null }

function upsert(orders: Order[], order: Order) {
  return [order, ...orders.filter((item) => item.id !== order.id)].sort((a, b) => b.created - a.created);
}

export default function AccountDialog({ mode, close, session, account, returnOrder, onSession, onAccount }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [phone, setPhone] = useState('');
  const [otp, setOtp] = useState('');
  const [sent, setSent] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const [catalog, setCatalog] = useState<{ plans: Plan[]; paymentsEnabled: boolean }>();
  const [orders, setOrders] = useState<Order[]>([]);
  const [tracking, setTracking] = useState(returnOrder);
  const [returnChecked, setReturnChecked] = useState(false);
  const phoneVerified = account?.phoneVerified === true;

  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => {
    if (mode !== 'plans') return;
    const controller = new AbortController();
    void request('/plans', '', undefined, controller.signal).then((r) => r.json()).then(setCatalog)
      .catch((error) => { if (!controller.signal.aborted) setMessage(errorText(error)); });
    if (session && phoneVerified) {
      void request('/orders', session, undefined, controller.signal).then((r) => r.json()).then((data) => {
        if (!controller.signal.aborted) setOrders((previous) => previous.reduce(upsert, data.orders as Order[]));
      }).catch((error) => { if (!controller.signal.aborted) setMessage(errorText(error)); });
    }
    return () => controller.abort();
  }, [mode, session, phoneVerified]);

  useEffect(() => {
    if (!tracking || !session || !phoneVerified) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    setMessage('正在查询支付结果…');
    async function poll() {
      try {
        const data = await (await request(`/orders/${tracking}`, session, undefined, controller.signal)).json() as OrderResponse;
        if (controller.signal.aborted) return;
        onAccount(data.account);
        setOrders((previous) => upsert(previous, data.order));
        if (data.order.status === 'fulfilled') {
          setMessage(data.order.kind === 'recharge' ? '充值已到账。' : '订阅已生效。');
          setReturnChecked(true);
        } else if (data.order.status === 'closed') {
          setMessage('该订单已关闭，可以重新购买。');
          setReturnChecked(true);
        } else if (++attempts < 6) {
          timer = setTimeout(() => void poll(), 2500);
        } else {
          setReturnChecked(true);
          setMessage('暂未收到支付确认。可在订单记录里刷新状态或继续支付。');
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        setReturnChecked(true);
        setMessage(errorText(error));
      }
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [tracking, session, phoneVerified, onAccount]);

  async function perform(action: () => Promise<void>) {
    if (pending) return;
    setPending(true);
    setMessage('');
    try { await action(); } catch (error) { setMessage(errorText(error)); }
    finally { setPending(false); }
  }

  async function verify() {
    const data = await (await request('/auth/verify', session, { phone, code: otp })).json();
    onSession(data.session);
    if (mode === 'login') close();
    else setMessage('已登录，可以购买订阅或充值。');
  }

  function openCheckout(data: OrderResponse) {
    onAccount(data.account);
    setOrders((previous) => upsert(previous, data.order));
    if (data.checkoutUrl) window.location.assign(data.checkoutUrl);
    else if (data.order.status === 'fulfilled') setMessage('支付已入账。');
    else if (data.order.status === 'closed') setMessage('该订单已关闭，请重新购买。');
    else setMessage('支付正在确认，请稍后刷新订单状态。');
  }

  async function buy(plan: Plan) {
    openCheckout(await (await request('/orders', session, {
      sku: plan.id, kind: plan.kind, amountCents: plan.price_cents, periodDays: plan.period_days, quota: plan.quota,
    })).json());
  }

  function refreshStatus(id: string) {
    if (tracking === id) {
      void perform(async () => openCheckout(await (await request(`/orders/${id}`, session)).json()));
      return;
    }
    setReturnChecked(false);
    setTracking(id);
  }

  return (
    <dialog className="reader-dialog commerce-dialog" ref={dialog} onClose={close}
      aria-labelledby="account-title" onCancel={(event) => { if (pending) event.preventDefault(); }}>
      <header className="reader-output-header">
        <h2 id="account-title">{mode === 'plans' ? '订阅与充值' : '账号'}</h2>
        <button type="button" className="reader-link" onClick={close} disabled={pending}>关闭</button>
      </header>
      {phoneVerified && account ? (
        <>
          <p className="reader-disclosure">剩余 {account.remaining} 篇 · 余额 {yuan(account.balanceCents)}
            {' · 余额按续写档位计费'}</p>
          {account.entitlements.length > 0 && <details>
            <summary>我的订阅与篇数</summary>
            <ul>{account.entitlements.map((item) => <li key={item.id}>
              {item.name} · 剩余 {item.quota_left} 篇 · {item.expires ? `${new Date(item.expires).toLocaleDateString()} 到期` : '长期有效'}
            </li>)}</ul>
          </details>}
        </>
      ) : (
        <form onSubmit={(event) => { event.preventDefault(); void perform(verify); }}>
          <fieldset disabled={pending}>
            <legend>手机号登录</legend>
            <label htmlFor="reader-phone">手机号</label>
            <input id="reader-phone" type="tel" autoComplete="tel" required value={phone} onChange={(event) => {
              setPhone(event.target.value); setSent(false);
            }} />
            <div className="reader-actions"><button type="button" disabled={!phone.trim()} onClick={() => void perform(async () => {
              await request('/auth/request-code', session, { phone });
              setSent(true); setMessage('验证码已发送，5 分钟内有效。');
            })}>{sent ? '重新发送验证码' : '发送验证码'}</button></div>
            <label htmlFor="reader-otp">短信验证码</label>
            <input id="reader-otp" inputMode="numeric" autoComplete="one-time-code" required pattern="[0-9]{6}"
              maxLength={6} value={otp} onChange={(event) => setOtp(event.target.value)} />
            <div className="reader-actions"><button type="submit" disabled={otp.length !== 6}>登录</button></div>
          </fieldset>
        </form>
      )}
      {mode === 'plans' && <>
        {catalog && !catalog.paymentsEnabled && <p className="reader-disclosure">在线支付暂未开通。</p>}
        {(['subscription', 'recharge'] as const).map((kind) => {
          const items = catalog?.plans.filter((plan) => plan.kind === kind) ?? [];
          if (!items.length) return null;
          return <section className="commerce-product-group" key={kind} aria-label={kind === 'subscription' ? '订阅' : '余额充值'}>
            <h3>{kind === 'subscription' ? '订阅' : '余额充值'}</h3>
            <div className="commerce-plans">{items.map((plan) => <article key={plan.id} className="commerce-plan">
              <strong>{plan.name}</strong><strong>{yuan(plan.price_cents)}</strong>
              <span>{plan.kind === 'subscription' ? `${plan.period_days} 天有效 · 含 ${plan.quota} 篇`
                : `到账余额 ${yuan(plan.price_cents)}`}</span>
              <button type="button" className="reader-link" disabled={!phoneVerified || pending || !catalog?.paymentsEnabled}
                onClick={() => void perform(() => buy(plan))}>{plan.kind === 'subscription' ? '购买订阅' : '充值'}</button>
            </article>)}</div>
          </section>;
        })}
        {catalog && !catalog.plans.length && <p className="reader-disclosure">暂无可购买的订阅或充值金额。</p>}
        {catalog?.plans.some((plan) => plan.kind === 'subscription') && <p className="reader-disclosure">订阅为一次性购买，到期后可按需续购。</p>}
        {message && <p role="status" className="reader-notice">{message}</p>}
        {orders.length > 0 && <details open={Boolean(returnOrder)}>
          <summary>订单记录</summary>
          <ul className="commerce-orders">{orders.map((order) => <li key={order.id}>
            <span>{order.name} · {yuan(order.amount_cents)} · {orderLabel[order.status]}</span>
            {order.status === 'pending' && <div>
              <button type="button" className="reader-link" disabled={pending || (tracking === order.id && !returnChecked)}
                onClick={() => refreshStatus(order.id)}>刷新支付状态</button>
              <button type="button" className="reader-link" disabled={pending || !catalog?.paymentsEnabled}
                onClick={() => void perform(async () => openCheckout(await (await request(`/orders/${order.id}/checkout`, session, {})).json()))}>继续支付</button>
            </div>}
          </li>)}</ul>
        </details>}
      </>}
      {mode === 'login' && session && <button type="button" className="reader-link" disabled={pending}
        onClick={() => void perform(async () => { await request('/auth/logout', session, {}); onSession(''); close(); })}>退出登录</button>}
      {mode === 'login' && message && <p role="status" className="reader-notice">{message}</p>}
    </dialog>
  );
}
