import type { ReactNode } from 'react';
import { Check, X, Info } from 'lucide-react';
import { GATE_LABELS } from '../config/agentSpecs';
import { GATE_ORDER } from '../lib/gates';
import type { GateResult } from '../types';

export type Tone = 'neutral' | 'amber' | 'emerald' | 'rose' | 'indigo' | 'slate';

const TONE_BADGE: Record<Tone, string> = {
  neutral: 'bg-white text-zinc-700 border-line',
  amber: 'bg-amber-50 text-amber-900 border-amber-300',
  emerald: 'bg-emerald-50 text-emerald-900 border-emerald-300',
  rose: 'bg-rose-50 text-rose-900 border-rose-300',
  indigo: 'bg-indigo-50 text-indigo-900 border-indigo-300',
  slate: 'bg-zinc-900 text-white border-zinc-900',
};

export function Badge({
  children,
  tone = 'neutral',
  className = '',
  title,
}: {
  children: ReactNode;
  tone?: Tone;
  className?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-semibold leading-none ${TONE_BADGE[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

export function SectionLabel({
  icon,
  children,
  right,
}: {
  icon?: ReactNode;
  children: ReactNode;
  right?: ReactNode;
}) {
  return (
    <div className="mb-2 flex items-center justify-between gap-2">
      <span className="flex items-center gap-1.5 text-[11px] font-bold tracking-wide text-zinc-800">
        {icon}
        {children}
      </span>
      {right}
    </div>
  );
}

export function Panel({
  children,
  className = '',
  header,
  toolbar,
}: {
  children: ReactNode;
  className?: string;
  header?: ReactNode;
  toolbar?: ReactNode;
}) {
  return (
    <section
      className={`flex min-h-0 flex-col overflow-hidden rounded-2xl border border-line bg-white shadow-[0_1px_2px_rgba(28,25,23,0.04)] ${className}`}
    >
      {(header || toolbar) && (
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-paper-2 px-3.5 py-2.5">
          <div className="flex min-w-0 items-center gap-2">{header}</div>
          {toolbar}
        </header>
      )}
      {children}
    </section>
  );
}

export function IconButton({
  title,
  onClick,
  disabled,
  active,
  children,
  className = '',
}: {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex h-7 w-7 items-center justify-center rounded-lg border transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        active
          ? 'border-amber-300 bg-amber-50 text-amber-900'
          : 'border-line bg-white text-zinc-600 hover:border-line-strong hover:text-zinc-900'
      } ${className}`}
    >
      {children}
    </button>
  );
}

export function ProgressBar({
  percent,
  label,
  running,
  right,
}: {
  percent: number;
  label: string;
  running?: boolean;
  right?: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-3 text-[11px]">
        <span className="flex min-w-0 items-center gap-1.5 text-zinc-800">
          <span
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${running ? 'animate-pulse bg-indigo-600' : 'bg-emerald-600'}`}
          />
          <span className="truncate">{label}</span>
        </span>
        <span className="shrink-0 font-mono text-[11px] font-bold text-indigo-700">{percent}%</span>
      </div>
      <div className="flex items-center gap-2">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-zinc-200">
          <div
            className={`h-full rounded-full transition-all duration-300 ${running ? 'bg-indigo-600' : 'bg-indigo-700'}`}
            style={{ width: `${Math.max(2, Math.min(100, percent))}%` }}
          />
        </div>
        {right}
      </div>
    </div>
  );
}

export function GateDots({ gate, compact = false }: { gate?: GateResult; compact?: boolean }) {
  if (!gate) {
    return <span className="font-mono text-[10px] text-zinc-400">未质检</span>;
  }
  return (
    <span className={`inline-flex items-center ${compact ? 'gap-0.5' : 'gap-1'}`}>
      {GATE_ORDER.map((key) => {
        const ok = gate.gates[key];
        return (
          <span
            key={key}
            title={`${ok ? '通过' : '未通过'} · ${GATE_LABELS[key]}：${gate._meta.details[key]}`}
            className={`block rounded-full ${compact ? 'h-1.5 w-1.5' : 'h-2 w-2'} ${
              ok ? 'bg-emerald-500' : 'bg-rose-500'
            }`}
          />
        );
      })}
    </span>
  );
}

export function GateRows({ gate }: { gate: GateResult }) {
  return (
    <ul className="space-y-1.5">
      {GATE_ORDER.map((key) => {
        const ok = gate.gates[key];
        return (
          <li key={key} className="flex items-start gap-2 text-[11px] leading-relaxed">
            <span
              className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full ${
                ok ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700'
              }`}
            >
              {ok ? <Check className="h-3 w-3" strokeWidth={3} /> : <X className="h-3 w-3" strokeWidth={3} />}
            </span>
            <span className="min-w-0">
              <span className={`font-semibold ${ok ? 'text-emerald-900' : 'text-rose-900'}`}>{GATE_LABELS[key]}</span>
              <span className="text-zinc-500"> · </span>
              <span className="text-zinc-600">{gate._meta.details[key]}</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  hint,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <label className={`flex cursor-pointer items-start gap-2 ${disabled ? 'opacity-50' : ''}`}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`mt-0.5 h-4 w-7 shrink-0 rounded-full border transition-colors ${
          checked ? 'border-indigo-700 bg-indigo-600' : 'border-zinc-300 bg-zinc-200'
        }`}
      >
        <span
          className={`block h-3 w-3 rounded-full bg-white shadow-sm transition-transform ${
            checked ? 'translate-x-3.5' : 'translate-x-0.5'
          }`}
        />
      </button>
      <span className="min-w-0">
        <span className="block text-[11px] font-semibold text-zinc-800">{label}</span>
        {hint && <span className="mt-0.5 block text-[10px] leading-snug text-zinc-500">{hint}</span>}
      </span>
    </label>
  );
}

export function EmptyState({
  icon,
  title,
  desc,
  action,
}: {
  icon: ReactNode;
  title: string;
  desc: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-line-strong bg-paper px-6 py-10 text-center">
      <div className="text-amber-600">{icon}</div>
      <p className="text-xs font-bold text-zinc-800">{title}</p>
      <p className="max-w-sm text-[11px] leading-relaxed text-zinc-500">{desc}</p>
      {action}
    </div>
  );
}

export interface ToastData {
  kind: 'ok' | 'err' | 'info';
  text: string;
}

export function Toast({ toast, onClose }: { toast: ToastData | null; onClose: () => void }) {
  if (!toast) return null;
  const tone =
    toast.kind === 'ok'
      ? 'border-emerald-300 bg-emerald-50 text-emerald-950'
      : toast.kind === 'err'
        ? 'border-rose-300 bg-rose-50 text-rose-950'
        : 'border-indigo-300 bg-indigo-50 text-indigo-950';
  return (
    <div className="pointer-events-none fixed bottom-5 left-1/2 z-[70] -translate-x-1/2 px-4">
      <div
        className={`pointer-events-auto flex max-w-[560px] items-start gap-2 rounded-xl border px-3.5 py-2.5 text-xs shadow-lg ${tone}`}
        role="status"
      >
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span className="leading-relaxed">{toast.text}</span>
        <button type="button" onClick={onClose} className="ml-1 shrink-0 opacity-60 hover:opacity-100">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
