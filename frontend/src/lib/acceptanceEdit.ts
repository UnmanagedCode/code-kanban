// Whether a card edit's PATCH carries an `acceptance` field at all.
//
// An edit that never touched the acceptance textarea must NOT send
// {replace:[...]}: update_card's replaceAcceptance preserves ticks by TEXT, so
// re-sending unchanged content can silently retick a DIFFERENT criterion that
// shares text with an untouched one (duplicate-text criteria with different
// `done` flags). So the textarea's value is compared with the prefill captured
// when the form was built; identical → undefined, and the caller omits the field,
// leaving update_card's `'acceptance' in fields` gate closed.

export function acceptanceFieldForEdit(currentValue: string, prefillValue: string): { replace: string[] } | undefined {
  if (currentValue === prefillValue) return undefined;
  return { replace: currentValue.split('\n').map((s) => s.trim()).filter(Boolean) };
}
