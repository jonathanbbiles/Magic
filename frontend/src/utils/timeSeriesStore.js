import AsyncStorage from '@react-native-async-storage/async-storage';

const SERIES_KEY = 'stage_dashboard_series_v1';
const MAX_POINTS = 720;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

function trimSeries(series) {
  const now = Date.now();
  const cutoff = now - MAX_AGE_MS;
  const filtered = (series || []).filter((point) => point?.t >= cutoff && Number.isFinite(point?.v));
  if (filtered.length <= MAX_POINTS) return filtered;
  return filtered.slice(filtered.length - MAX_POINTS);
}

export async function loadSeries() {
  try {
    const raw = await AsyncStorage.getItem(SERIES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return trimSeries(Array.isArray(parsed) ? parsed : []);
  } catch (error) {
    console.warn('series_load_failed', error?.message || error);
    return [];
  }
}

export async function appendSeriesPoint(value, timestamp = Date.now()) {
  const v = Number(value);
  if (!Number.isFinite(v)) return [];
  const nextPoint = { t: timestamp, v };
  const existing = await loadSeries();
  const next = trimSeries([...existing, nextPoint]);
  try {
    await AsyncStorage.setItem(SERIES_KEY, JSON.stringify(next));
  } catch (error) {
    console.warn('series_save_failed', error?.message || error);
  }
  return next;
}
