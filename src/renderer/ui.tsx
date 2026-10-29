import { useEffect, useRef, type ReactNode } from 'react';

export const money = (cents: number) => new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(cents / 100);
export const localDate = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
export const time = (value: string | null) => value ? new Date(value).toLocaleString('es-MX') : 'Sin fecha';
export function cents(value: FormDataEntryValue | null) {
  const text = String(value ?? '');
  if (!/^\d+(\.\d{1,2})?$/.test(text)) throw new Error('Escribe un importe válido con hasta dos decimales.');
  return Math.round(Number(text) * 100);
}
export function Status({ value }: { value: 'paid' | 'partial' | 'pending' }) {
  return <span className={`badge ${value}`}>{({ paid: 'Liquidado', partial: 'Parcial', pending: 'Pendiente' })[value]}</span>;
}
export function Modal({ title, children, close }: { title: string; children: ReactNode; close: () => void }) {
  const ref = useRef<HTMLElement>(null);
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    const previous = document.activeElement;
    const dialog = ref.current;
    if (!dialog) return;
    const controls = () => Array.from(dialog.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary,[tabindex="0"]'));
    if (!dialog.contains(document.activeElement)) controls()[0]?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); closeRef.current(); }
      if (event.key !== 'Tab') return;
      const items = controls();
      const first = items[0], last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    dialog.addEventListener('keydown', keydown);
    return () => { dialog.removeEventListener('keydown', keydown); if (previous instanceof HTMLElement) previous.focus(); };
  }, []);
  return <div className="overlay"><section ref={ref} role="dialog" aria-modal="true" aria-label={title} className="modal">
    <header><h2>{title}</h2><button className="ghost" onClick={close} aria-label="Cerrar ventana">✕</button></header>
    {children}
  </section></div>;
}
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="field"><span>{label}</span>{children}</label>;
}
export type Run = <T>(task: () => Promise<T>, success?: string) => Promise<T | undefined>;
