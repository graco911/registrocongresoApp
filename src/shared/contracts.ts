import { z } from 'zod';
import { cleanEmail, isMexicanPhone, normalizePhone } from './contact';

export type Role = 'admin' | 'cashier' | 'reception';
export type Operator = { id: number; username: string; role: Role };
export type Session = { id: number; name: string; session_date: string | null };
export type EventSettings = {
  id: number; name: string; default_fee_cents: number; allow_debt: number;
};
const nullableText = z.string().nullable();
export const personRecord = z.object({
  id: z.number(), attendee_id: z.number(), folio: z.string(), full_name: z.string(),
  phone: nullableText, email: nullableText, church: nullableText, role: nullableText,
  city: nullableText, registration_date: nullableText, registered_by: nullableText,
  notes: nullableText, fee_cents: z.number(), paid_cents: z.number(),
  balance_cents: z.number(), excess_cents: z.number(),
  payment_status: z.enum(['paid', 'partial', 'pending']), issue_count: z.number(),
  checked_in_at: nullableText,
});
export type Person = z.infer<typeof personRecord>;
export const paymentRecord = z.object({
  id: z.number(), amount_cents: z.number(), kind: z.string(), paid_at: nullableText,
  method: nullableText, reference: nullableText, notes: nullableText,
  recorded_by: nullableText, recorded_at: z.string(), voided_at: nullableText,
  void_reason: nullableText,
});
export type Payment = z.infer<typeof paymentRecord>;
export const checkinRecord = z.object({
  id: z.number(), session_id: z.number(), name: z.string(), checked_in_at: z.string(),
  recorded_by: z.string(), voided_at: nullableText, void_reason: nullableText,
});
export type Checkin = z.infer<typeof checkinRecord>;
export const issueRecord = z.object({
  id: z.number(), field: z.string(), message: z.string(), resolved_at: nullableText,
});
export type Issue = z.infer<typeof issueRecord>;
export type Detail = {
  person: Person; payments: Payment[]; checkins: Checkin[]; issues: Issue[];
  source: Record<string, string> | null;
};
export type Filters = { query: string; status: string; church: string; attendance: string; sessionId: number | null };
export type Snapshot = {
  event: EventSettings; sessions: Session[];
  stats: { count: number; paid: number; balance: number; issues: number };
  churches: string[]; roles: string[]; cities: string[];
};
export type ImportRow = {
  row: number; name: string; phone: string | null; church: string | null;
  role: string | null; city: string | null; date: string | null;
  registeredBy: string | null; paid: number; method: string | null;
  notes: string | null; source: Record<string, string>; warnings: string[];
  duplicate: boolean;
};
export type ImportPreview = { token: string; filename: string; rows: ImportRow[] };
const cents = z.number().int().min(0).max(100_000_000);
const text = z.string().trim().max(500);
export const idSchema = z.number().int().positive();
export const dateSchema = z.string().refine(value =>
  /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) &&
  new Date(value).toISOString().slice(0, 10) === value, 'Fecha inválida');
export const personSchema = z.object({
  id: idSchema.optional(), full_name: text.min(1, 'Escribe el nombre'),
  phone: text.refine(v => !v || isMexicanPhone(v), 'Escribe 10 dígitos, con +52 opcional.').transform(normalizePhone),
  email: z.string().transform(cleanEmail).pipe(text.refine(v => !v || z.email().safeParse(v).success, 'Correo inválido: usa usuario@dominio.ext')),
  church: text, role: text, city: text,
  registration_date: dateSchema, notes: z.string().trim().max(5000),
  fee_cents: cents,
});
export type PersonInput = z.infer<typeof personSchema>;
export const paymentSchema = z.object({
  registrationId: idSchema, amount_cents: cents.min(1),
  paid_at: dateSchema, method: text.min(1), reference: text, notes: text,
});
export type PaymentInput = z.infer<typeof paymentSchema>;
export const settingsSchema = z.object({
  name: text.min(1), default_fee_cents: cents, allow_debt: z.boolean(),
  sessions: z.array(z.object({ id: idSchema.optional(), name: text.min(1), session_date: dateSchema.or(z.literal('')) })).min(1, 'Debe existir al menos una sesión.').max(30),
});
export type SettingsInput = z.infer<typeof settingsSchema>;
export const accountSchema = z.object({
  username: z.string().trim().min(3).max(50),
  password: z.string().min(10, 'La contraseña debe tener al menos 10 caracteres').max(128),
  role: z.enum(['admin', 'cashier', 'reception']),
});
export const methods = [
  'bootstrap', 'setup', 'login', 'logout', 'snapshot', 'list', 'detail', 'savePerson',
  'addPayment', 'voidPayment', 'checkin', 'voidCheckin', 'resolveIssue',
  'saveSettings', 'operators', 'addOperator', 'disableOperator',
  'previewImport', 'commitImport', 'exportExcel', 'backup', 'restore', 'loadInitial',
] as const;
export type Method = typeof methods[number];
export type Api = {
  bootstrap(): Promise<{ needsSetup: boolean; user: Operator | null; databasePath: string }>;
  setup(input: { username: string; password: string }): Promise<Operator>;
  login(input: { username: string; password: string }): Promise<Operator>;
  logout(): Promise<void>;
  snapshot(): Promise<Snapshot>;
  list(filters: Filters): Promise<Person[]>;
  detail(id: number): Promise<Detail>;
  savePerson(input: PersonInput): Promise<number>;
  addPayment(input: PaymentInput): Promise<void>;
  voidPayment(input: { id: number; reason: string }): Promise<void>;
  checkin(input: { registrationId: number; sessionId: number }): Promise<{ existing: boolean; time: string }>;
  voidCheckin(input: { id: number; reason: string }): Promise<void>;
  resolveIssue(id: number): Promise<void>;
  saveSettings(input: SettingsInput): Promise<void>;
  operators(): Promise<(Operator & { active: number })[]>;
  addOperator(input: { username: string; password: string; role: Role }): Promise<void>;
  disableOperator(id: number): Promise<void>;
  previewImport(): Promise<ImportPreview | null>;
  commitImport(input: { token: string; rows: number[] }): Promise<number>;
  exportExcel(): Promise<string | null>;
  backup(): Promise<string | null>;
  restore(): Promise<boolean>;
  loadInitial(): Promise<boolean>;
};
export type Reply = { ok: true; value: unknown } | { ok: false; error: string };
declare global { interface Window { congress: Api } }
