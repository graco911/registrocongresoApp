import { useState } from 'react';
import type { Detail, Operator, Person, PersonInput, Snapshot } from '../shared/contracts';
import { cents, Field, localDate, Modal, money, Status, time, type Run } from './ui';
import { PhoneInput } from './PhoneInput';
import { cleanEmail } from '../shared/contact';

const api = window.congress;
export function PersonDialog({ person, snapshot, user, busy, run, close, saved }: {
  person?: Person; snapshot: Snapshot; user: Operator; busy: boolean; run: Run;
  close: () => void; saved: (id: number) => void;
}) {
  const [matches, setMatches] = useState<Person[]>([]);
  const [pending, setPending] = useState<PersonInput>();
  const submit = async (input: PersonInput) => {
    if (!input.id) {
      const found = await api.list({ query: input.full_name, status: '', church: '', attendance: '', sessionId: null });
      if (found.length) { setMatches(found); setPending(input); return; }
    }
    saved(await api.savePerson(input));
  };
  return <Modal title={person ? 'Editar congresista' : 'Nueva inscripción'} close={close}>
    {pending ? <div className="dialog-body"><div className="alert warning">Hay personas con nombres similares. Verifica antes de crear otra inscripción.</div>{matches.map(p => <p key={p.id}><strong>{p.full_name}</strong> · {p.folio} · {p.church ?? 'Sin iglesia'} · {p.phone ?? 'Sin teléfono'}</p>)}<div className="actions"><button className="secondary" onClick={() => setPending(undefined)}>Volver</button><button disabled={busy} onClick={() => void run(async () => saved(await api.savePerson(pending)))}>Es otra persona: crear inscripción</button></div></div> :
      <form className="dialog-body" onSubmit={e => {
        e.preventDefault(); const f = new FormData(e.currentTarget);
        void run(() => submit({
          id: person?.id, full_name: String(f.get('full_name')), phone: String(f.get('phone')),
          email: String(f.get('email')), church: String(f.get('church')), role: String(f.get('role')),
          city: String(f.get('city')), registration_date: String(f.get('registration_date')),
          fee_cents: person && user.role !== 'admin' ? person.fee_cents : cents(f.get('fee')),
          notes: String(f.get('notes')),
        }));
      }}>
        <div className="form-grid">
          <div className="span2"><Field label="Nombre completo *"><input name="full_name" required maxLength={500} defaultValue={person?.full_name} autoFocus /></Field></div>
          <div><Field label="Teléfono / WhatsApp"><PhoneInput initialValue={person?.phone ?? ''} /></Field><p id="phone-help" className="muted small">10 dígitos: (993) 123-4567. Prefijo +52 opcional.</p></div>
          <div><Field label="Correo electrónico"><input name="email" type="email" maxLength={500} autoComplete="email" autoCapitalize="none" spellCheck={false} placeholder="usuario@dominio.ext" aria-describedby="email-help" defaultValue={person?.email ?? ''} onChange={e => {
            const input = e.currentTarget;
            const value = cleanEmail(input.value);
            if (value !== input.value) input.value = value;
          }} /></Field><p id="email-help" className="muted small">Sin espacios. Ejemplo: usuario@dominio.ext.</p></div>
          <Field label="Iglesia / congregación"><input name="church" list="churches" maxLength={500} defaultValue={person?.church ?? ''} /></Field>
          <Field label="Cargo"><input name="role" list="roles" maxLength={500} defaultValue={person?.role ?? ''} /></Field>
          <Field label="Ciudad / municipio"><input name="city" list="cities" maxLength={500} defaultValue={person?.city ?? ''} /></Field>
          <Field label="Fecha de inscripción *"><input name="registration_date" type="date" required defaultValue={person ? person.registration_date ?? '' : localDate()} /></Field>
          <Field label="Costo asignado (MXN) *"><input name="fee" type="number" min="0" max="1000000" step="0.01" required disabled={!!person && user.role !== 'admin'} defaultValue={((person?.fee_cents ?? snapshot.event.default_fee_cents) / 100).toFixed(2)} /></Field>
          <div className="span2"><Field label="Observaciones"><textarea name="notes" maxLength={5000} rows={3} defaultValue={person?.notes ?? ''} /></Field></div>
        </div>
        <datalist id="churches">{snapshot.churches.map(v => <option key={v} value={v} />)}</datalist>
        <datalist id="roles">{snapshot.roles.map(v => <option key={v} value={v} />)}</datalist>
        <datalist id="cities">{snapshot.cities.map(v => <option key={v} value={v} />)}</datalist>
        <p className="muted small">Los pagos se capturan en el expediente después de guardar. No se inventarán datos de contacto faltantes.</p>
        <div className="actions"><button type="button" className="secondary" onClick={close}>Cancelar</button><button disabled={busy}>Guardar inscripción</button></div>
      </form>}
  </Modal>;
}
export function DetailDialog({ detail, snapshot, user, busy, run, close, edit, changed }: {
  detail: Detail; snapshot: Snapshot; user: Operator; busy: boolean; run: Run;
  close: () => void; edit: () => void; changed: () => Promise<void>;
}) {
  const [tab, setTab] = useState('data');
  const [paymentForm, setPaymentForm] = useState(false);
  const [voiding, setVoiding] = useState<{ type: 'payment' | 'checkin'; id: number }>();
  const [sessionId, setSessionId] = useState('');
  const [checkMessage, setCheckMessage] = useState('');
  const [confirmPay, setConfirmPay] = useState(false);
  const p = detail.person;
  return <Modal title={`${p.folio} · Expediente`} close={close}>
    <div className="profile-header"><h2>{p.full_name}</h2><p>{p.church ?? 'Sin iglesia'} · {p.city ?? 'Sin ciudad'}</p><Status value={p.payment_status} />{p.excess_cents > 0 && <span className="badge partial">Excedente: {money(p.excess_cents)}</span>}</div>
    <div className="tabs">{[['data','Datos'], ['payments','Pagos'], ['attendance','Asistencia'], ['issues', `Revisión (${detail.issues.filter(i => !i.resolved_at).length})`]].map(([key, label]) => <button key={key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>{label}</button>)}</div>
    <div className="dialog-body">
      {tab === 'data' && <>
        <dl className="details">{[['Teléfono',p.phone],['Correo',p.email],['Cargo',p.role],['Fecha de inscripción',p.registration_date],['Inscrito por',p.registered_by],['Observaciones',p.notes]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value ?? 'Sin dato'}</dd></div>)}</dl>
        {user.role !== 'reception' && <button onClick={edit}>Editar datos</button>}
      </>}
      {tab === 'payments' && <>
        <div className="balance-grid"><div>Costo<strong>{money(p.fee_cents)}</strong></div><div>Pagado<strong>{money(p.paid_cents)}</strong></div><div>Pendiente<strong>{money(p.balance_cents)}</strong></div></div>
        {user.role !== 'reception' && !paymentForm && <button onClick={() => setPaymentForm(true)}>＋ Registrar abono</button>}
        {paymentForm && <form className="subform" onSubmit={e => {
          e.preventDefault(); const f = new FormData(e.currentTarget);
          void run(async () => {
            const amount = cents(f.get('amount'));
            if (amount > p.balance_cents && !confirmPay) { setConfirmPay(true); return; }
            await api.addPayment({ registrationId: p.id, amount_cents: amount, paid_at: String(f.get('date')), method: String(f.get('method')), reference: String(f.get('reference')), notes: String(f.get('notes')) });
            setPaymentForm(false); setConfirmPay(false); await changed();
          });
        }}>
          <h3>Nuevo abono</h3><div className="form-grid">
            <Field label="Importe (MXN)"><input name="amount" type="number" step="0.01" min="0.01" max="1000000" defaultValue={p.balance_cents ? (p.balance_cents / 100).toFixed(2) : ''} required onChange={() => setConfirmPay(false)} autoFocus /></Field>
            <Field label="Fecha"><input name="date" type="date" defaultValue={localDate()} required /></Field>
            <Field label="Forma de pago"><select name="method" required><option>Efectivo</option><option>Transferencia</option><option>Tarjeta</option><option>Otro</option></select></Field>
            <Field label="Referencia"><input name="reference" maxLength={500} /></Field>
            <div className="span2"><Field label="Observación"><input name="notes" maxLength={500} /></Field></div>
          </div>{confirmPay && <p className="alert warning">El importe excede el adeudo. Revisa la cantidad y confirma nuevamente para registrar el excedente.</p>}
          <div className="actions"><button type="button" className="secondary" onClick={() => { setPaymentForm(false); setConfirmPay(false); }}>Cancelar abono</button><button disabled={busy}>{confirmPay ? 'Confirmar importe con excedente' : 'Guardar abono'}</button></div>
        </form>}
        <h3>Movimientos</h3>{!detail.payments.length && <p className="muted">Sin pagos registrados.</p>}
        {detail.payments.map(payment => <article className={`movement ${payment.voided_at ? 'voided' : ''}`} key={payment.id}><div><strong>{money(payment.amount_cents)} · {payment.kind === 'opening_balance' ? 'Acumulado inicial del Excel' : 'Abono'}</strong><p>{payment.paid_at ?? 'Fecha no disponible'} · {payment.method ?? 'Forma no disponible'} · {payment.recorded_by ?? 'Origen Excel'}</p>{payment.reference && <p>Referencia: {payment.reference}</p>}{payment.notes && <small>{payment.notes}</small>}{payment.voided_at && <p className="debt">Anulado: {payment.void_reason}</p>}</div>{user.role === 'admin' && !payment.voided_at && <button className="danger secondary" onClick={() => setVoiding({ type: 'payment', id: payment.id })}>Anular pago</button>}</article>)}
      </>}
      {tab === 'attendance' && <>
        <div className="inline-form"><Field label="Sesión para registrar ingreso"><select value={sessionId} onChange={e => setSessionId(e.target.value)}><option value="">Selecciona sesión</option>{snapshot.sessions.map(s => <option key={s.id} value={s.id}>{s.name} · {s.session_date ?? 'Sin fecha'}</option>)}</select></Field><button disabled={busy || !sessionId} onClick={() => void run(async () => {
          const result = await api.checkin({ registrationId: p.id, sessionId: Number(sessionId) });
          setCheckMessage(`${result.existing ? 'Ya tenía ingreso registrado' : 'Ingreso registrado'}: ${time(result.time)}`); await changed();
        })}>Registrar ingreso</button></div>
        {checkMessage && <p role="status" className="alert success">{checkMessage}</p>}
        {!detail.checkins.length && <p className="muted">Sin ingresos registrados.</p>}
        {detail.checkins.map(c => <article className={`movement ${c.voided_at ? 'voided' : ''}`} key={c.id}><div><strong>{c.name}</strong><p>{time(c.checked_in_at)} · {c.recorded_by}</p>{c.voided_at && <p>Anulado: {c.void_reason}</p>}</div>{user.role === 'admin' && !c.voided_at && <button className="secondary danger" onClick={() => setVoiding({ type: 'checkin', id: c.id })}>Anular ingreso</button>}</article>)}
      </>}
      {tab === 'issues' && <>
        <p className="muted">Corrige los datos en su pestaña antes de marcar una incidencia como revisada. Esta acción no modifica el dato original.</p>
        {!detail.issues.length && <p>Sin incidencias de importación.</p>}
        {detail.issues.map(i => <article className="movement" key={i.id}><div><strong>{i.resolved_at ? '✓ Revisada' : 'Por revisar'}</strong><p>{i.message}</p></div>{!i.resolved_at && user.role !== 'reception' && <button className="secondary" disabled={busy} onClick={() => void run(async () => { await api.resolveIssue(i.id); await changed(); })}>Marcar revisada</button>}</article>)}
        {detail.source && <details><summary>Valores originales del Excel</summary><dl className="details">{Object.entries(detail.source).map(([key, value]) => <div key={key}><dt>Columna {key}</dt><dd>{value || 'Vacío'}</dd></div>)}</dl></details>}
      </>}
      {voiding && <form className="subform" onSubmit={e => {
        e.preventDefault(); const f = new FormData(e.currentTarget);
        void run(async () => {
          const input = { id: voiding.id, reason: String(f.get('reason')) };
          await (voiding.type === 'payment' ? api.voidPayment(input) : api.voidCheckin(input));
          setVoiding(undefined); await changed();
        });
      }}><h3>Confirmar anulación</h3><Field label="Motivo obligatorio"><input name="reason" minLength={3} maxLength={500} required autoFocus /></Field><div className="actions"><button className="secondary" type="button" onClick={() => setVoiding(undefined)}>Cancelar anulación</button><button className="danger" disabled={busy}>Confirmar anulación</button></div></form>}
    </div>
  </Modal>;
}
