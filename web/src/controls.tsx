import React, { useEffect, useRef, useState } from 'react';
import { parseMoney } from '../../shared/model.js';

export function Money({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const invalid = parseMoney(draft) === null;
  return <label className="money-input"><span>{label}</span><span className="money-entry"><span aria-hidden="true">$</span><input aria-label={`${label} amount`} aria-invalid={invalid} inputMode="decimal" value={draft} placeholder="0.00" maxLength={24} onChange={e => { const v = e.target.value; setDraft(v); onChange(v); }}/></span>{invalid && <small className="error">Enter a non-negative amount with up to two decimal places.</small>}</label>;
}
export function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  const heading = React.useId();
  const panel = useRef<HTMLElement>(null), close = useRef(onClose); close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const focusable = () => Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]') ?? []);
    (focusable().find(el => el.tagName === 'INPUT') ?? focusable()[0])?.focus();
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close.current();
      if (e.key === 'Tab') { const nodes = focusable(), first = nodes[0], last = nodes.at(-1); if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); } }
    };
    document.addEventListener('keydown', handler); return () => { document.removeEventListener('keydown', handler); previous?.focus(); };
  }, []);
  return <div className="modal-backdrop"><section ref={panel} className="modal" role="dialog" aria-modal="true" aria-labelledby={heading}><header><h2 id={heading}>{title}</h2><button type="button" className="icon-button" aria-label="Close dialog" onClick={onClose}>×</button></header>{children}</section></div>;
}
