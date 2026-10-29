import { useLayoutEffect, useRef, useState } from 'react';
import { isMexicanPhone, maskPhone } from '../shared/contact';

export function PhoneInput({ initialValue }: { initialValue: string }) {
  const [value, setValue] = useState(() => maskPhone(initialValue));
  const ref = useRef<HTMLInputElement>(null);
  const caret = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (caret.current !== null) {
      ref.current?.setSelectionRange(caret.current, caret.current);
      caret.current = null;
    }
  });
  return <input ref={ref} name="phone" type="tel" autoComplete="tel" inputMode="tel"
    placeholder="(993) 123-4567" aria-describedby="phone-help" value={value}
    onChange={event => {
      const input = event.currentTarget;
      const raw = input.value;
      const position = input.selectionStart ?? raw.length;
      let digitsBeforeCaret = raw.slice(0, position).replace(/\D/g, '').length;
      let next = raw;
      const inputType = (event.nativeEvent as InputEvent).inputType;
      if (raw.length < value.length && raw.replace(/\D/g, '') === value.replace(/\D/g, '') &&
          (inputType === 'deleteContentBackward' || inputType === 'deleteContentForward')) {
        const index = digitsBeforeCaret - (inputType === 'deleteContentBackward' ? 1 : 0);
        const positions = [...raw.matchAll(/\d/g)].map(match => match.index);
        if (index >= 0 && index < positions.length) {
          const at = positions[index];
          next = raw.slice(0, at) + raw.slice(at + 1);
          if (inputType === 'deleteContentBackward') digitsBeforeCaret--;
        }
      }
      const formatted = maskPhone(next);
      let end = 0, count = 0;
      while (end < formatted.length && count < digitsBeforeCaret) {
        if (/\d/.test(formatted[end])) count++;
        end++;
      }
      caret.current = position === raw.length ? formatted.length : end;
      input.setCustomValidity(!formatted || isMexicanPhone(formatted) ? '' : 'Escribe 10 dígitos, con +52 opcional.');
      setValue(formatted);
    }}
    onInvalid={event => {
      if (value && !isMexicanPhone(value)) event.currentTarget.setCustomValidity('Escribe 10 dígitos, con +52 opcional.');
    }}
    pattern={String.raw`(?:\+52\s?)?\(\d{3}\)\s\d{3}-\d{4}`} />;
}
