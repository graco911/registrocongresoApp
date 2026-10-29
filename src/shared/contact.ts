export const cleanEmail = (value: string) => value.replace(/\s/g, '');

export function normalizePhone(value: string): string {
  const compact = value.replace(/[\s().-]/g, '');
  if (/^52\d{10}$/.test(compact)) return `+${compact}`;
  return compact;
}

export function isMexicanPhone(value: string): boolean {
  return /^(?:\+52)?\d{10}$/.test(normalizePhone(value));
}

export function maskPhone(value: string): string {
  const compact = normalizePhone(value);
  if (!compact || compact === '+' || compact === '+5') return compact;
  const prefix = compact.startsWith('+52') ? '+52' : '';
  const digits = prefix ? compact.slice(3) : compact;
  // Keep unsupported/overlong numbers visible so validation never discards data.
  if (!/^\d*$/.test(digits) || digits.length > 10) return value;
  if (!digits) return prefix;
  let result = `(${digits.slice(0, 3)}`;
  if (digits.length >= 3) result += ')';
  if (digits.length > 3) result += ` ${digits.slice(3, 6)}`;
  if (digits.length > 6) result += `-${digits.slice(6)}`;
  return `${prefix ? `${prefix} ` : ''}${result}`;
}
