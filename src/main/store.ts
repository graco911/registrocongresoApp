import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import {
  accountSchema, dateSchema, idSchema, personSchema, paymentSchema, settingsSchema,
  personRecord, paymentRecord, checkinRecord, issueRecord,
  type Person, type Detail, type Operator, type Filters, type Snapshot,
  type ImportRow, type Role,
} from '../shared/contracts';

export class AppError extends Error {}
export const normalize = (value: string) => value.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('es').trim();
const empty = (v: string) => v.trim() || null;
const reasonSchema = z.object({ id: idSchema, reason: z.string().trim().min(3).max(500) });
const filtersSchema = z.object({
  query: z.string().max(500), status: z.enum(['', 'paid', 'partial', 'pending']),
  church: z.string().max(500), attendance: z.enum(['', 'yes', 'no']),
  sessionId: idSchema.nullable(),
});
const personSelect = `
  SELECT r.id,r.attendee_id,r.folio,a.full_name,a.phone,a.email,a.church,a.role,a.city,
  r.registration_date,r.registered_by,r.notes,b.fee_cents,b.paid_cents,b.balance_cents,
  b.excess_cents,b.payment_status,
  (SELECT count(*) FROM import_issues i WHERE i.registration_id=r.id AND i.resolved_at IS NULL) issue_count,
  NULL AS checked_in_at
  FROM registrations r JOIN attendees a ON a.id=r.attendee_id
  JOIN registration_balances b ON b.registration_id=r.id WHERE r.event_id=1`;

export class Store {
  readonly db: DatabaseSync;
  user: Operator | null = null;
  private failedLogins = 0;
  private retryAt = 0;
  constructor(readonly path: string, schemaPath: string) {
    this.db = new DatabaseSync(path);
    try {
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    const version = Number(this.db.prepare('PRAGMA user_version').get()!.user_version);
    if (version === 0) this.db.exec(readFileSync(schemaPath, 'utf8'));
    if (version > 2) throw new AppError('La base pertenece a una versión más reciente de la aplicación.');
    if (version < 2) this.transaction(() => {
      this.db.exec(`
        CREATE TABLE operators(
          id INTEGER PRIMARY KEY, username TEXT NOT NULL COLLATE NOCASE UNIQUE,
          password_hash TEXT NOT NULL, salt TEXT NOT NULL,
          role TEXT NOT NULL CHECK(role IN ('admin','cashier','reception')),
          active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1))
        );
        CREATE TABLE audit_log(
          id INTEGER PRIMARY KEY, operator_id INTEGER REFERENCES operators(id),
          action TEXT NOT NULL, entity_id INTEGER, detail TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        ALTER TABLE events ADD COLUMN allow_debt INTEGER NOT NULL DEFAULT 1 CHECK(allow_debt IN (0,1));
        INSERT OR IGNORE INTO events(id,name,default_fee_cents) VALUES(1,'Congreso',20000);
        PRAGMA user_version=2;
      `);
      if (!Number(this.db.prepare('SELECT count(*) n FROM sessions WHERE event_id=1').get()!.n)) {
        this.db.exec("INSERT INTO sessions(event_id,name) VALUES(1,'Viernes 13'),(1,'Sábado 14')");
      }
    });
    } catch (error) { this.db.close(); throw error; }
  }
  close() { this.db.close(); }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  require(...roles: Role[]): Operator {
    if (!this.user || (roles.length && !roles.includes(this.user.role))) throw new AppError('No tienes permiso para esta operación.');
    return this.user;
  }
  audit(action: string, id: number | null = null, detail: string | null = null) {
    this.db.prepare('INSERT INTO audit_log(operator_id,action,entity_id,detail) VALUES(?,?,?,?)')
      .run(this.user?.id ?? null, action, id, detail);
  }
  needsSetup() { return Number(this.db.prepare('SELECT count(*) n FROM operators').get()!.n) === 0; }
  setup(input: unknown) {
    if (!this.needsSetup()) throw new AppError('El administrador ya fue creado.');
    const data = accountSchema.parse({ ...z.object({ username: z.string(), password: z.string() }).parse(input), role: 'admin' });
    const id = this.insertAccount(data);
    this.user = { id, username: data.username, role: 'admin' };
    this.audit('setup', id);
    return this.user;
  }
  private insertAccount(input: z.infer<typeof accountSchema>) {
    if (this.db.prepare('SELECT id FROM operators WHERE username=?').get(input.username)) throw new AppError('Ese usuario ya existe.');
    const salt = randomBytes(32).toString('hex');
    const hash = scryptSync(input.password, salt, 64).toString('hex');
    return Number(this.db.prepare('INSERT INTO operators(username,password_hash,salt,role) VALUES(?,?,?,?)')
      .run(input.username, hash, salt, input.role).lastInsertRowid);
  }
  login(input: unknown) {
    if (Date.now() < this.retryAt) throw new AppError('Demasiados intentos. Espera un minuto.');
    const data = z.object({ username: z.string().trim().max(50), password: z.string().max(128) }).parse(input);
    const row = this.db.prepare('SELECT * FROM operators WHERE username=? AND active=1').get(data.username);
    const candidate = scryptSync(data.password, row ? String(row.salt) : 'unavailable', 64);
    if (!row || !timingSafeEqual(candidate, Buffer.from(String(row.password_hash), 'hex'))) {
      if (++this.failedLogins >= 5) { this.retryAt = Date.now() + 60_000; this.failedLogins = 0; }
      throw new AppError('Usuario o contraseña incorrectos.');
    }
    this.failedLogins = 0;
    this.user = { id: Number(row.id), username: String(row.username), role: z.enum(['admin', 'cashier', 'reception']).parse(row.role) };
    this.audit('login');
    return this.user;
  }
  snapshot(): Snapshot {
    this.require();
    const event = this.db.prepare('SELECT id,name,default_fee_cents,allow_debt FROM events WHERE id=1').get();
    const sessions = this.db.prepare('SELECT id,name,session_date FROM sessions WHERE event_id=1 ORDER BY id').all();
    const totals = this.db.prepare(`SELECT count(*) count,coalesce(sum(paid_cents),0) paid,
      coalesce(sum(balance_cents),0) balance FROM registration_balances WHERE event_id=1`).get()!;
    const issues = this.db.prepare('SELECT count(*) n FROM import_issues WHERE resolved_at IS NULL').get()!;
    const values = (column: 'church' | 'role' | 'city') =>
      this.db.prepare(`SELECT DISTINCT ${column} value FROM attendees WHERE ${column} IS NOT NULL ORDER BY ${column}`).all().map(row => String(row.value));
    return {
      event: z.object({ id: z.number(), name: z.string(), default_fee_cents: z.number(), allow_debt: z.number() }).parse(event),
      sessions: z.array(z.object({ id: z.number(), name: z.string(), session_date: z.string().nullable() })).parse(sessions),
      stats: { count: Number(totals.count), paid: Number(totals.paid), balance: Number(totals.balance), issues: Number(issues.n) },
      churches: values('church'), roles: values('role'), cities: values('city'),
    };
  }
  list(input: Filters): Person[] {
    this.require();
    const filters = filtersSchema.parse(input);
    const rows = z.array(personRecord).parse(this.db.prepare(personSelect + ' ORDER BY a.full_name COLLATE NOCASE').all());
    const checkins = filters.sessionId ? this.db.prepare(
      'SELECT registration_id,checked_in_at FROM checkins WHERE session_id=? AND event_id=1 AND voided_at IS NULL',
    ).all(filters.sessionId) : [];
    const times = new Map(checkins.map(c => [Number(c.registration_id), String(c.checked_in_at)]));
    const tokens = normalize(filters.query).split(/\s+/).filter(Boolean);
    return rows.map(p => ({ ...p, checked_in_at: times.get(p.id) ?? null })).filter(p => {
      const haystack = normalize([p.full_name, p.folio, p.phone, p.email, p.church, p.city].join(' '));
      return tokens.every(token => haystack.includes(token)) &&
        (!filters.status || p.payment_status === filters.status) &&
        (!filters.church || p.church === filters.church) &&
        (!filters.attendance || (filters.attendance === 'yes' ? !!p.checked_in_at : !p.checked_in_at));
    });
  }
  detail(input: unknown): Detail {
    this.require();
    const id = idSchema.parse(input);
    const row = this.db.prepare(personSelect + ' AND r.id=?').get(id);
    if (!row) throw new AppError('No se encontró la inscripción.');
    const person = personRecord.parse(row);
    const payments = z.array(paymentRecord).parse(this.db.prepare('SELECT * FROM payments WHERE registration_id=? ORDER BY id DESC').all(id));
    const checkins = z.array(checkinRecord).parse(this.db.prepare(`SELECT c.*,s.name FROM checkins c JOIN sessions s ON s.id=c.session_id
      WHERE c.registration_id=? ORDER BY c.id DESC`).all(id));
    const issues = z.array(issueRecord).parse(this.db.prepare('SELECT * FROM import_issues WHERE registration_id=? ORDER BY id').all(id));
    const raw = this.db.prepare('SELECT source_data_json FROM registrations WHERE id=?').get(id)!.source_data_json;
    return { person, payments, checkins, issues, source: raw ? z.record(z.string(), z.string()).parse(JSON.parse(String(raw))) : null };
  }
  savePerson(input: unknown) {
    const operator = this.require('admin', 'cashier');
    const p = personSchema.parse(input);
    return this.transaction(() => {
      if (p.id) {
        const old = this.detail(p.id).person;
        if (operator.role !== 'admin' && p.fee_cents !== old.fee_cents) throw new AppError('Solo administración puede cambiar la tarifa de una inscripción existente.');
        this.db.prepare('UPDATE attendees SET full_name=?,phone=?,email=?,church=?,role=?,city=? WHERE id=?')
          .run(p.full_name, empty(p.phone), empty(p.email), empty(p.church), empty(p.role), empty(p.city), old.attendee_id);
        this.db.prepare('UPDATE registrations SET registration_date=?,fee_cents=?,notes=? WHERE id=?')
          .run(p.registration_date, p.fee_cents, empty(p.notes), p.id);
        this.audit('update_registration', p.id, JSON.stringify({ before: old, after: p }));
        return p.id;
      }
      const attendeeId = Number(this.db.prepare('INSERT INTO attendees(full_name,phone,email,church,role,city) VALUES(?,?,?,?,?,?)')
        .run(p.full_name, empty(p.phone), empty(p.email), empty(p.church), empty(p.role), empty(p.city)).lastInsertRowid);
      const next = Number(this.db.prepare('SELECT coalesce(max(id),0)+1 n FROM registrations').get()!.n);
      const id = Number(this.db.prepare(`INSERT INTO registrations(event_id,attendee_id,folio,registration_date,registered_by,fee_cents,notes)
        VALUES(1,?,?,?,?,?,?)`).run(attendeeId, `C-${String(next).padStart(4, '0')}`, p.registration_date, operator.username, p.fee_cents, empty(p.notes)).lastInsertRowid);
      this.audit('create_registration', id);
      return id;
    });
  }
  addPayment(input: unknown) {
    const operator = this.require('admin', 'cashier');
    const p = paymentSchema.parse(input);
    this.transaction(() => {
      this.detail(p.registrationId);
      this.db.prepare(`INSERT INTO payments(registration_id,amount_cents,kind,paid_at,method,reference,recorded_by,notes)
        VALUES(?,?,'payment',?,?,?,?,?)`).run(p.registrationId, p.amount_cents, p.paid_at, p.method, empty(p.reference), operator.username, empty(p.notes));
      this.audit('add_payment', p.registrationId, JSON.stringify(p));
    });
  }
  voidPayment(input: unknown) {
    this.require('admin');
    const p = reasonSchema.parse(input);
    this.transaction(() => {
      const result = this.db.prepare("UPDATE payments SET voided_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),void_reason=? WHERE id=? AND voided_at IS NULL").run(p.reason, p.id);
      if (!result.changes) throw new AppError('El pago no existe o ya fue anulado.');
      this.audit('void_payment', p.id, p.reason);
    });
  }
  checkin(input: unknown) {
    const operator = this.require();
    const p = z.object({ registrationId: idSchema, sessionId: idSchema }).parse(input);
    return this.transaction(() => {
      const person = this.detail(p.registrationId).person;
      const session = this.db.prepare('SELECT * FROM sessions WHERE id=? AND event_id=1').get(p.sessionId);
      if (!session) throw new AppError('Selecciona una sesión válida.');
      if (!session.session_date) throw new AppError('Configura la fecha completa de la sesión antes de registrar ingresos.');
      const existing = this.db.prepare('SELECT checked_in_at FROM checkins WHERE registration_id=? AND session_id=? AND voided_at IS NULL').get(p.registrationId, p.sessionId);
      if (existing) return { existing: true, time: String(existing.checked_in_at) };
      if (person.balance_cents > 0 && !this.snapshot().event.allow_debt) throw new AppError('La política del evento no permite ingreso con adeudo.');
      const time = new Date().toISOString();
      this.db.prepare('INSERT INTO checkins(event_id,registration_id,session_id,checked_in_at,recorded_by) VALUES(1,?,?,?,?)')
        .run(p.registrationId, p.sessionId, time, operator.username);
      this.audit('checkin', p.registrationId, JSON.stringify(p));
      return { existing: false, time };
    });
  }
  voidCheckin(input: unknown) {
    this.require('admin');
    const p = reasonSchema.parse(input);
    this.transaction(() => {
      const result = this.db.prepare("UPDATE checkins SET voided_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),void_reason=? WHERE id=? AND voided_at IS NULL").run(p.reason, p.id);
      if (!result.changes) throw new AppError('El ingreso no existe o ya fue anulado.');
      this.audit('void_checkin', p.id, p.reason);
    });
  }
  resolveIssue(input: unknown) {
    this.require('admin', 'cashier');
    const id = idSchema.parse(input);
    this.transaction(() => {
      if (!this.db.prepare("UPDATE import_issues SET resolved_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND resolved_at IS NULL").run(id).changes) {
        throw new AppError('La incidencia no existe o ya fue revisada.');
      }
      this.audit('resolve_issue', id);
    });
  }
  saveSettings(input: unknown) {
    this.require('admin');
    const p = settingsSchema.parse(input);
    if (new Set(p.sessions.map(s => normalize(s.name))).size !== p.sessions.length) throw new AppError('Los nombres de las sesiones no deben repetirse.');
    this.transaction(() => {
      const current = z.array(z.object({ id: z.number(), name: z.string() })).parse(
        this.db.prepare('SELECT id,name FROM sessions WHERE event_id=1').all(),
      );
      const retained = p.sessions.flatMap(s => s.id === undefined ? [] : [s.id]);
      if (new Set(retained).size !== retained.length) throw new AppError('Una sesión no puede aparecer más de una vez.');
      if (retained.some(id => !current.some(s => s.id === id))) throw new AppError('Sesión inexistente.');
      const removed = current.filter(s => !retained.includes(s.id));
      for (const session of removed) {
        if (this.db.prepare('SELECT id FROM checkins WHERE session_id=? LIMIT 1').get(session.id)) {
          throw new AppError(`No se puede quitar "${session.name}": tiene ingresos registrados, incluso si fueron anulados.`);
        }
      }
      for (const session of removed) {
        this.db.prepare('DELETE FROM sessions WHERE id=? AND event_id=1').run(session.id);
        this.audit('delete_session', session.id, JSON.stringify(session));
      }
      // Free retained names first so renaming or swapping sessions is order independent.
      for (const id of retained) {
        this.db.prepare('UPDATE sessions SET name=? WHERE id=? AND event_id=1').run(`__editing_${randomUUID()}`, id);
      }
      this.db.prepare('UPDATE events SET name=?,default_fee_cents=?,allow_debt=? WHERE id=1').run(p.name, p.default_fee_cents, Number(p.allow_debt));
      for (const session of p.sessions) {
        if (session.id) {
          if (!this.db.prepare('UPDATE sessions SET name=?,session_date=? WHERE id=? AND event_id=1').run(session.name, empty(session.session_date), session.id).changes) throw new AppError('Sesión inexistente.');
        } else this.db.prepare('INSERT INTO sessions(event_id,name,session_date) VALUES(1,?,?)').run(session.name, empty(session.session_date));
      }
      this.audit('settings', 1, JSON.stringify(p));
    });
  }
  operators() {
    this.require('admin');
    return this.db.prepare('SELECT id,username,role,active FROM operators ORDER BY username').all();
  }
  addOperator(input: unknown) {
    this.require('admin');
    const p = accountSchema.parse(input);
    this.transaction(() => { const id = this.insertAccount(p); this.audit('add_operator', id); });
  }
  disableOperator(input: unknown) {
    const user = this.require('admin');
    const id = idSchema.parse(input);
    if (id === user.id) throw new AppError('No puedes desactivar tu propia cuenta.');
    this.transaction(() => {
      if (!this.db.prepare('UPDATE operators SET active=0 WHERE id=? AND active=1').run(id).changes) throw new AppError('El operador no existe o ya está inactivo.');
      this.audit('disable_operator', id);
    });
  }
  importRows(filename: string, hash: string, rows: ImportRow[]) {
    this.require('admin');
    if (this.db.prepare('SELECT id FROM import_batches WHERE event_id=1 AND sha256=?').get(hash)) throw new AppError('Este archivo ya fue importado.');
    return this.transaction(() => {
      const batchId = this.db.prepare("INSERT INTO import_batches(event_id,filename,sha256,sheet_name) VALUES(1,?,?,'Inscripciones')").run(filename, hash).lastInsertRowid;
      const fee = this.snapshot().event.default_fee_cents;
      for (const row of rows) {
        z.object({ name: z.string().trim().min(1).max(500), paid: z.number().int().min(0).max(100_000_000), row: idSchema }).parse(row);
        if (row.date) dateSchema.parse(row.date);
        const attendee = this.db.prepare('INSERT INTO attendees(full_name,phone,church,role,city) VALUES(?,?,?,?,?)').run(row.name, row.phone, row.church, row.role, row.city).lastInsertRowid;
        const next = Number(this.db.prepare('SELECT coalesce(max(id),0)+1 n FROM registrations').get()!.n);
        const id = Number(this.db.prepare(`INSERT INTO registrations(event_id,attendee_id,folio,registration_date,registered_by,fee_cents,notes,import_batch_id,source_row,source_data_json)
          VALUES(1,?,?,?,?,?,?,?,?,?)`).run(attendee, `C-${String(next).padStart(4, '0')}`, row.date, row.registeredBy, fee, row.notes, batchId, row.row, JSON.stringify(row.source)).lastInsertRowid);
        if (row.paid > 0) this.db.prepare(`INSERT INTO payments(registration_id,amount_cents,kind,method,notes) VALUES(?,?,'opening_balance',?,'Acumulado importado de Excel; fecha y desglose desconocidos.')`).run(id, row.paid, row.method);
        for (const warning of row.warnings) this.db.prepare("INSERT INTO import_issues(registration_id,field,code,message) VALUES(?,'source','review',?)").run(id, warning);
      }
      this.audit('import', Number(batchId), JSON.stringify({ filename, count: rows.length }));
      return rows.length;
    });
  }
}
