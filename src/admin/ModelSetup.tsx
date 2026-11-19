import { useState } from 'react';
import type { FormEvent } from 'react';
import { Check, FlaskConical, KeyRound } from 'lucide-react';
import { MODEL_VENDORS } from '../lib/model-vendors';
import type { CatalogModel, ModelVendor } from '../lib/model-vendors';
import { request } from '../reader/api';
import { yuan } from '../reader/account';

export interface ModelSettings {
  defaultModel: string;
  paused: boolean;
  guestFree: boolean;
  announcement: string;
  envPaused: boolean;
}

export interface ModelTier {
  id: string;
  label: string;
  model: string;
  vendor: ModelVendor | null;
  active: number;
  key_configured: boolean;
  price_cents: number | null;
  input_cost: number;
  output_cost: number;
}

type VendorStatus = Record<ModelVendor, { configured: boolean }>;
interface Props {
  vendors: VendorStatus;
  tiers: ModelTier[];
  settings: ModelSettings;
  defaultId: string | null;
  basePrice: number;
  working: boolean;
  refresh: () => Promise<void>;
  perform: (action: () => Promise<void>, success?: string) => Promise<void>;
  message: (text: string) => void;
}

const keys = ['deepseek', 'gemini'] as const;
const CUSTOM = 'custom';

export default function ModelSetup({ vendors, tiers, settings, defaultId, basePrice, working, refresh, perform, message }: Props) {
  const [catalog, setCatalog] = useState<Partial<Record<ModelVendor, CatalogModel[]>>>({});
  const [editing, setEditing] = useState<ModelTier>();
  const [vendor, setVendor] = useState<ModelVendor>(vendors.gemini.configured && !vendors.deepseek.configured ? 'gemini' : 'deepseek');
  const [model, setModel] = useState<string>(MODEL_VENDORS[vendor].models[0].id);
  const [formVersion, setFormVersion] = useState(0);
  const options = catalog[vendor] ?? MODEL_VENDORS[vendor].models;
  const known = options.some((item) => item.id === model);

  function resetEditor(next?: ModelTier) {
    const nextVendor = next?.vendor ?? vendor;
    setEditing(next);
    setVendor(nextVendor);
    setModel(next?.model ?? (catalog[nextVendor] ?? MODEL_VENDORS[nextVendor].models)[0]?.id ?? CUSTOM);
    setFormVersion((version) => version + 1);
  }

  function submit(event: FormEvent<HTMLFormElement>, action: (data: FormData, form: HTMLFormElement) => Promise<void>, success?: string) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    void perform(() => action(data, form), success);
  }

  async function queryCatalog(id: ModelVendor) {
    const data = await (await request('/admin/model-providers/catalog', '', { vendor: id })).json() as { models: CatalogModel[] };
    setCatalog((previous) => ({ ...previous, [id]: data.models }));
    if (id === vendor && !editing && !data.models.some((item) => item.id === model)) setModel(data.models[0]?.id ?? CUSTOM);
    message(`${MODEL_VENDORS[id].label} 返回了 ${data.models.length} 个可选文字模型。具体型号可以在档位里测试。`);
  }

  return <>
    <section className="admin-panel">
      <h2>接入模型服务</h2>
      <div className="model-providers">
        {keys.map((id) => {
          const item = MODEL_VENDORS[id];
          return <article key={id} className="model-provider">
            <div className="model-card-title">
              <h3>{item.label}</h3>
              <span className="model-connection" data-configured={vendors[id].configured}>
                {vendors[id].configured ? <><Check size={14} aria-hidden="true" /> 已接入 Key</> : '待接入'}
              </span>
            </div>
            <p>用同一个 Key 添加这家的不同模型档位。</p>
            <form onSubmit={(event) => submit(event, async (data, form) => {
              await request('/admin/model-providers', '', { vendor: id, apiKey: data.get('key') });
              form.reset();
              setCatalog((previous) => ({ ...previous, [id]: undefined }));
              if (!editing && !vendors[vendor].configured) {
                setVendor(id);
                setModel(MODEL_VENDORS[id].models[0].id);
              }
              await refresh();
            }, `${item.label} Key 已保存。`)}>
              <fieldset disabled={working}>
                <label>{item.label} API Key<input type="password" name="key" autoComplete="off" spellCheck={false}
                  placeholder={vendors[id].configured ? '更换时输入新的 Key' : '粘贴厂商生成的 API Key'} maxLength={1024} required /></label>
                <div className="model-actions">
                  <button type="submit"><KeyRound size={15} aria-hidden="true" /> 保存 Key</button>
                  <button type="button" className="admin-secondary" disabled={!vendors[id].configured}
                    onClick={() => void perform(() => queryCatalog(id))}>查看可用模型</button>
                  <a href={item.keyUrl} target="_blank" rel="noopener noreferrer">获取 Key</a>
                </div>
                {catalog[id] && <small>已读取 {catalog[id].length} 个文字模型</small>}
              </fieldset>
            </form>
          </article>;
        })}
      </div>
    </section>

    <section className="admin-panel">
      <div className="admin-header">
        <h2>续写档位</h2>
        {editing && <button type="button" className="admin-secondary" disabled={working} onClick={() => resetEditor()}>新增档位</button>}
      </div>
      <p className="model-note">档位名和余额单价会显示在续写页。用户有订阅篇数时，各档位都只记 1 篇。</p>
      <div className="model-tier-list">
        {tiers.filter((item) => item.id !== 'env' || item.model).map((item) => {
          const price = item.price_cents ?? basePrice;
          return <article className="model-tier" key={item.id}>
            <div>
              <div className="model-card-title"><strong>{item.label}</strong>
                {defaultId === item.id && <span className="model-connection" data-configured>默认</span>}</div>
              <p>{item.vendor ? MODEL_VENDORS[item.vendor].label + ' · ' : ''}{item.model}</p>
              <small>{item.active ? '已启用' : '已停用'} · {item.key_configured ? (price > 0 ? `${yuan(price)}/篇` : '余额单价待设置') : '待接入 Key'}</small>
            </div>
            <div className="model-actions">
              <button type="button" className="admin-secondary" disabled={working || !item.key_configured}
                onClick={() => void perform(async () => {
                  const result = await (await request('/admin/models/test', '', { id: item.id })).json();
                  message(`${item.label} 已连通，耗时 ${result.latencyMs} 毫秒。`);
                })}><FlaskConical size={15} aria-hidden="true" /> 测试连通</button>
              {item.active && item.key_configured && defaultId !== item.id && <button type="button" className="admin-secondary" disabled={working}
                onClick={() => void perform(async () => {
                  await request('/admin/model-tiers/default', '', { id: item.id });
                  await refresh();
                }, `已将 ${item.label} 设为默认档位。`)}>设为默认</button>}
              {item.vendor && <button type="button" className="admin-secondary" disabled={working} onClick={() => resetEditor(item)}>编辑档位</button>}
              {item.id !== 'env' && <button type="button" className="admin-secondary" disabled={working}
                onClick={() => void perform(async () => {
                  await request('/admin/model-tiers/toggle', '', { id: item.id, active: !item.active });
                  await refresh();
                }, item.active ? '档位已停用。' : '档位已启用。')}>{item.active ? '停用' : '启用'}</button>}
            </div>
          </article>;
        })}
      </div>

      <form key={formVersion} className="model-tier-form" onSubmit={(event) => submit(event, async (data) => {
        const price = String(data.get('price') ?? '').trim();
        await request('/admin/model-tiers', '', {
          ...(editing ? { id: editing.id } : {}), vendor,
          model: model === CUSTOM ? data.get('custom_model') : model,
          label: data.get('label'), priceCents: price ? Math.round(Number(price) * 100) : null,
          inputCost: Number(data.get('input_cost') ?? 0), outputCost: Number(data.get('output_cost') ?? 0),
        });
        resetEditor();
        await refresh();
      }, '续写档位已保存。')}>
        <h3>{editing ? '编辑档位' : '添加档位'}</h3>
        <fieldset disabled={working || !keys.some((key) => vendors[key].configured)} className="admin-grid">
          <label>模型服务<select name="vendor" value={vendor} onChange={(event) => {
            const next = event.target.value as ModelVendor;
            setVendor(next);
            setModel((catalog[next] ?? MODEL_VENDORS[next].models)[0]?.id ?? CUSTOM);
          }}>
            {keys.map((key) => <option value={key} key={key}>{MODEL_VENDORS[key].label}{vendors[key].configured ? '' : '（待接入 Key）'}</option>)}
          </select></label>
          <label>选择模型<select name="model" value={model} onChange={(event) => setModel(event.target.value)}>
            {options.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
            {!known && model !== CUSTOM && <option value={model}>{model}</option>}
            <option value={CUSTOM}>输入其他模型 ID</option>
          </select></label>
          {model === CUSTOM && <label>模型 ID<input name="custom_model" required maxLength={100} /></label>}
          <label>档位显示名<input name="label" placeholder="例如 快速续写" defaultValue={editing?.label} required maxLength={60} /></label>
          <label>余额单价（元/篇）<input name="price" type="number" min={0.01} max={1000} step={0.01}
            defaultValue={editing?.price_cents != null ? editing.price_cents / 100 : undefined}
            placeholder={basePrice ? `留空使用基础单价 ${yuan(basePrice)}` : '填写单篇售价'} /></label>
          <button type="submit" disabled={!vendors[vendor].configured}>保存档位</button>
          <details className="model-costs">
            <summary>可选：填写厂商成本</summary>
            <div className="admin-grid">
              <label>输入成本（元/百万 tokens）<input name="input_cost" type="number" min={0} step="any" defaultValue={editing?.input_cost || undefined} /></label>
              <label>输出成本（元/百万 tokens）<input name="output_cost" type="number" min={0} step="any" defaultValue={editing?.output_cost || undefined} /></label>
            </div>
          </details>
        </fieldset>
        {!vendors[vendor].configured && <p className="model-note">保存 {MODEL_VENDORS[vendor].label} 的 Key 后，就可以添加档位。</p>}
      </form>
    </section>

    <section className="admin-panel">
      <h2>运营开关</h2>
      <form key={JSON.stringify(settings)} onSubmit={(event) => submit(event, async (data) => {
        await request('/admin/settings', '', {
          paused: data.has('paused'), guestFree: data.has('guestFree'), announcement: data.get('announcement'),
        });
        await refresh();
      }, '运营设置已保存。')}>
        <fieldset disabled={working} className="admin-grid">
          <label>首页公告<input name="announcement" maxLength={160} defaultValue={settings.announcement} /></label>
          <label className="admin-check"><input type="checkbox" name="paused" defaultChecked={settings.paused} /> 暂停接收新续写</label>
          <label className="admin-check"><input type="checkbox" name="guestFree" defaultChecked={settings.guestFree} /> 游客首篇免费</label>
          <button type="submit">保存开关</button>
        </fieldset>
        {settings.envPaused && <p className="model-note">服务端已暂停生成。</p>}
      </form>
    </section>
  </>;
}
