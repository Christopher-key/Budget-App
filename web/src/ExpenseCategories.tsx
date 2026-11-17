import { useState, type FormEvent } from 'react';
import type { Ledger } from '../../shared/contracts.js';
import { addExpenseCategory, expenseCategoryDefinitions, setExpenseCategoryActive } from '../../shared/categories.js';
import { Modal } from './controls.js';
import './categories.css';

export function ExpenseCategoryManager({ ledger, update }: { ledger: Ledger; update: (next: Ledger) => void }) {
  const [open, setOpen] = useState(false), [name, setName] = useState('');
  const [error, setError] = useState(''), [message, setMessage] = useState('');
  const categories = expenseCategoryDefinitions(ledger);
  function add(event: FormEvent) {
    event.preventDefault(); setError(''); setMessage('');
    try { update(addExpenseCategory(ledger, name)); setName(''); setMessage('Expense category added to this month and future budgets.'); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Check the category name.'); }
  }
  function change(category: string, active: boolean) {
    setError(''); setMessage('');
    try {
      update(setExpenseCategoryActive(ledger, category, active));
      setMessage(active ? 'Expense category restored for this month and future budgets.' : 'Expense category removed from entry fields. Previously entered amounts are retained.');
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'The expense category could not be updated.'); }
  }
  return <div className="expense-category-manager">
    <button className="secondary" onClick={() => { setOpen(true); setError(''); setMessage(''); }}>Manage expenses</button>
    {open && <Modal title="Manage expense categories" onClose={() => setOpen(false)}>
      <p className="muted small">Choose the expense fields you use. Changes apply to the current calendar month and future budgets, regardless of the month you are viewing. Earlier months keep their original categories.</p>
      <form onSubmit={add}>
        <label className="field">New expense category<input aria-label="New expense category" required maxLength={80} placeholder="Childcare, property tax…" value={name} onChange={event => setName(event.target.value)}/></label>
        <button className="primary full" disabled={!name.trim() || categories.length >= 100}>Add expense category</button>
      </form>
      {error && <p className="error" role="alert">{error}</p>}
      {message && <p className="success small" role="status">{message}</p>}
      <p className="privacy-note">Removing a category hides its entry fields. Amounts already entered remain in totals and appear under Previously recorded. Clear a planned amount first if it is no longer owed, or restore the category to edit it later.</p>
      <section className="expense-category-list" aria-label="Active expense categories">
        <h3>Active categories</h3>
        {!categories.some(category => category.isActive) && <p className="muted small">No active categories. Add one above or restore a category below.</p>}
        {categories.filter(category => category.isActive).map(category => {
          const fixed = (ledger.fixedPayments ?? []).filter(payment => payment.isApplied && payment.category === category.name);
          return <div className="expense-category-row" key={category.name}>
            <div><strong>{category.name}</strong>{fixed.length > 0 && <small className="muted">Unapply or move its fixed payments before removing this category.</small>}</div>
            <button className="secondary" aria-label={`Remove ${category.name} expense category`} disabled={fixed.length > 0} onClick={() => change(category.name, false)}>Remove</button>
          </div>;
        })}
      </section>
      {categories.some(category => !category.isActive) && <section className="expense-category-list" aria-label="Removed expense categories">
        <h3>Removed categories</h3>
        {categories.filter(category => !category.isActive).map(category => <div className="expense-category-row" key={category.name}>
          <strong>{category.name}</strong><button className="secondary" aria-label={`Restore ${category.name} expense category`} onClick={() => change(category.name, true)}>Restore</button>
        </div>)}
      </section>}
    </Modal>}
  </div>;
}
