import type { Ledger } from '../../shared/contracts.js';

export function AppearanceSettings({ ledger, update }: { ledger: Ledger; update: (next: Ledger) => void }) {
  return <section className="card settings-card">
    <h2>Appearance</h2>
    <p className="muted small">Your choices are saved with this account.</p>
    <label className="appearance-toggle"><span><strong>Animations</strong><small>Rotate the sun and twinkle the stars on Home.</small></span><input className="appearance-switch" type="checkbox" role="switch" aria-label="Animations" checked={ledger.animationsEnabled ?? true} onChange={event => update({ ...ledger, animationsEnabled: event.target.checked })}/></label>
    <label className="appearance-toggle"><span><strong>Dark mode</strong><small>Use a darker color palette for your budget.</small></span><input className="appearance-switch" type="checkbox" role="switch" aria-label="Dark mode" checked={ledger.darkModeEnabled ?? false} onChange={event => update({ ...ledger, darkModeEnabled: event.target.checked })}/></label>
  </section>;
}
