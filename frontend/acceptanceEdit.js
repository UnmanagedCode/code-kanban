// Pure decision logic for the GUI edit form's acceptance textarea — kept
// dependency-free (no DOM) so node:test can import it directly, same pattern
// as persist.js. doEdit (app.js) uses this to decide whether a card edit's
// PATCH should carry an `acceptance` field at all.
//
// A GUI edit that never touched the acceptance textarea must NOT send
// {replace:[...]}: update_task's replaceAcceptance preserves ticks by TEXT,
// so re-sending unchanged content through it can silently retick a DIFFERENT
// criterion that happens to share text with an untouched one — reachable
// whenever a card holds duplicate-text criteria with different `done` flags.
// Compare the textarea's current value against the prefill string captured
// when the form was built; identical -> return undefined so the caller omits
// the field entirely and update_task's `'acceptance' in fields` gate leaves
// the list untouched.
export function acceptanceFieldForEdit(currentValue, prefillValue) {
  if (currentValue === prefillValue) return undefined;
  return { replace: currentValue.split('\n').map((s) => s.trim()).filter(Boolean) };
}
