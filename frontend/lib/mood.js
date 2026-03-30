export const deriveBotMood = ({ stale, diagnosticsOk, positions }) => {
  if (!diagnosticsOk) return 'disconnected';
  if (stale) return 'caution';
  const active = (positions || []).length;
  if (active === 0) return 'cooling down';
  if (active >= 4) return 'hunting';
  return 'holding';
};
