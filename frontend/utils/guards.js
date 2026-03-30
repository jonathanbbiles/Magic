export const asNumber = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

export const asArray = (value) => (Array.isArray(value) ? value : []);

export const asObject = (value) => (value && typeof value === 'object' ? value : {});
