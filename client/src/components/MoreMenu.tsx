import { useEffect, useRef } from 'react';
import { Icon } from './ui/DesignSystem';
import { useTheme, type ThemePref } from '../state/theme';

const CHOICES: { id: ThemePref; label: string }[] = [
  { id: 'system', label: 'Match system' }, { id: 'light', label: 'Light' }, { id: 'dark', label: 'Dark' }
];

/** The header's More (…) menu: appearance (system, light, dark). Closes on a pick, Escape or a click outside. */
export default function MoreMenu() {
  const { pref, setPref } = useTheme();
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = (e: Event) => {
      const d = ref.current; if (!d?.open) return;
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !d.contains(e.target as Node)) d.open = false;
    };
    document.addEventListener('pointerdown', close); document.addEventListener('keydown', close);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', close); };
  }, []);
  return (
    <details ref={ref} className="ds-menu" data-testid="more-menu">
      <summary className="ds-icon-btn" aria-label="More"><Icon name="more" size={18} /></summary>
      <div className="ds-menu-list" role="group" aria-label="Appearance">
        <span className="ds-menu-note">Appearance</span>
        {CHOICES.map(c => (
          <button key={c.id} type="button" role="menuitemradio" aria-checked={pref === c.id}
            onClick={() => { setPref(c.id); if (ref.current) ref.current.open = false; }}>
            {c.label}{pref === c.id && <Icon name="check" size={16} />}
          </button>
        ))}
      </div>
    </details>
  );
}
