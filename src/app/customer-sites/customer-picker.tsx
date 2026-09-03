'use client';
import { useState, useEffect, useRef } from 'react';

type Customer = { id: number; name: string; parent_name: string | null };

export function CustomerPicker({
  value, onChange, placeholder = 'Customer name', inputStyle, disabled,
}: {
  value: string;
  onChange: (name: string) => void;
  placeholder?: string;
  inputStyle?: React.CSSProperties;
  disabled?: boolean;
}) {
  const [input, setInput] = useState(value);
  const [suggestions, setSuggestions] = useState<Customer[]>([]);
  const [open, setOpen] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { setInput(value); }, [value]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      const q = input.trim();
      const url = q ? `/api/customers?q=${encodeURIComponent(q)}` : '/api/customers';
      const r = await fetch(url);
      const d = await r.json();
      setSuggestions(d.customers ?? []);
    }, 150);
  }, [input]);

  function pick(name: string) {
    setInput(name); onChange(name); setOpen(false);
  }

  return (
    <div style={{ position: 'relative' }}>
      <input
        value={input}
        onChange={e => { setInput(e.target.value); onChange(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder={placeholder}
        disabled={disabled}
        style={{ padding: 3, fontSize: '0.7rem', border: '1px solid #ccc', borderRadius: 4, width: '100%', ...inputStyle }}
      />
      {open && suggestions.length > 0 && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 10,
          background: '#fff', border: '1px solid #ccc', borderRadius: 4, marginTop: 1,
          maxHeight: 200, overflowY: 'auto', fontSize: '0.7rem',
        }}>
          {suggestions.slice(0, 12).map(c => (
            <div key={c.id} onMouseDown={() => pick(c.name)}
                 style={{ padding: '3px 6px', cursor: 'pointer' }}
                 onMouseEnter={e => e.currentTarget.style.background = '#eef'}
                 onMouseLeave={e => e.currentTarget.style.background = ''}>
              {c.name}
              {c.parent_name && <span style={{ color: '#999' }}> · under {c.parent_name}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
