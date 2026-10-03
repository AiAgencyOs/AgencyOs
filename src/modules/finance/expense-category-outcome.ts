import type { FormState } from '@/modules/identity/types';

/** What the person is told for each answer of `finance.set_expense_category`. Pure, so it is tested. */
export function expenseCategoryOutcomeMessage(outcome: string | undefined, label: string): FormState {
  switch (outcome) {
    case 'added':
      return { status: 'success', message: `"${label}" added. New expenses can be filed under it.` };
    case 'renamed':
      return { status: 'success', message: `Renamed to "${label}". Expenses already filed under it keep it.` };
    case 'retired':
      return { status: 'success', message: 'Retired. It is no longer offered on a new expense; every expense already filed under it keeps it.' };
    case 'restored':
      return { status: 'success', message: 'Restored. It is offered on new expenses again.' };
    case 'unchanged':
      return { status: 'success', message: 'Nothing to change.' };
    case 'exists':
      return { status: 'error', message: 'A category with that name already exists (retired ones count — restore it instead).' };
    case 'invalid_label':
      return { status: 'error', message: 'Give the category a name of 1 to 60 characters; the name of a new category must start with a letter.' };
    case 'last_active':
      return { status: 'error', message: 'This is the last active category. Add another before retiring it, so an expense always has somewhere to go.' };
    case 'not_found':
      return { status: 'error', message: 'That category was not found.' };
    case 'forbidden':
      return { status: 'error', message: 'The database refused: only an owner or ops admin may change the categories.' };
    default:
      return { status: 'error', message: 'Could not save the category.' };
  }
}
