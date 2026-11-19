export interface Account {
  remaining: number;
  guest: boolean;
  phoneVerified: boolean;
  balanceCents: number;
  storyPriceCents: number;
  announcement: string;
  paused: boolean;
  tiers: { id: string; label: string; maxOutput: number; priceCents: number }[];
  entitlements: { id: string; name: string; expires: number | null; quota_left: number }[];
}

export interface Plan {
  id: string; name: string; price_cents: number; period_days: number;
  quota: number; kind: 'subscription' | 'recharge'; active: number;
}

export interface Order {
  id: string; sku: string; name: string; amount_cents: number;
  kind: Plan['kind'] | null;
  status: 'pending' | 'fulfilled' | 'closed'; created: number; fulfilled: number | null; phone?: string;
}

export const yuan = (cents: number) => `¥${(cents / 100).toFixed(2)}`;
export const orderLabel = { pending: '待支付', fulfilled: '已入账', closed: '已关闭' } as const;
