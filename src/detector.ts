export const DAY = 86_400_000;
export type Point = { time: number; value: number };
// Optional for compatibility with detector state written before persistence was added.
export type State = { lastTime: number; active: boolean; healthy: number; crossings?: number };
export const initialState = (): State => ({ lastTime: 0, active: false, healthy: 0 });

export function quantile(values: number[], q: number): number {
  if (!values.length) throw new Error("Empty baseline");
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  return sorted[Math.floor(pos)] + (sorted[Math.ceil(pos)] - sorted[Math.floor(pos)]) * (pos % 1);
}

export function score(points: Point[], point: Point, sigmaMultiplier = 4, swingFraction = 0.15) {
  // These countries have fixed UTC offsets: the same UTC slot preserves local time of day.
  const samples = points.filter(p => p.time < point.time && point.time - p.time <= 14 * DAY &&
    (point.time - p.time) % DAY === 0).map(p => p.value);
  if (samples.length < 7) throw new Error("Need at least seven prior days at this time of day");
  const baseline = quantile(samples, 0.5);
  const sigma = 1.4826 * quantile(samples.map(v => Math.abs(v - baseline)), 0.5);
  const history = points.filter(p => p.time < Math.floor(point.time / DAY) * DAY &&
    point.time - p.time <= 14 * DAY).map(p => p.value);
  const swing = quantile(history, 0.95) - quantile(history, 0.05);
  // Positive floors also handle flat or almost-zero series. MIN0_MAX is requested.
  const floor = Math.max(swingFraction * swing, 0.05 * baseline, 1e-9);
  const threshold = baseline + Math.max(sigmaMultiplier * sigma, floor);
  const immediateThreshold = baseline + 2 * (threshold - baseline);
  const recoveryThreshold = baseline + Math.max(2 * sigma, floor / 2);
  return { baseline, threshold, immediateThreshold, recoveryThreshold, samples: samples.length, value: point.value,
    time: point.time, spike: point.value > threshold };
}

export function advance(state: State, result: ReturnType<typeof score>, step: number) {
  if (result.time <= state.lastTime) return { state, alert: false };
  const contiguous = result.time - state.lastTime === step;
  const healthy = result.value <= result.recoveryThreshold ? (contiguous ? state.healthy : 0) + 1 : 0;
  const crossings = result.spike ? Math.min(2, (contiguous ? state.crossings ?? 0 : 0) + 1) : 0;
  const immediate = result.spike && result.value >= result.immediateThreshold;
  const alert = !state.active && (immediate || crossings >= 2);
  const reason = alert ? (immediate ? "large_spike" : "persistent_spike") : undefined;
  return { alert, reason, state: { lastTime: result.time, active: alert || (state.active && healthy < 2), healthy, crossings } };
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Malformed Radar response");
  return value as Record<string, unknown>;
}

export function parseRadar(body: unknown, now: number, step: number): Point[] {
  const root = object(body);
  if (root.success !== true) throw new Error("Radar API reported failure");
  const result = object(root.result), meta = object(result.meta), series = object(result.serie_0);
  if (meta.normalization !== "MIN0_MAX") throw new Error("Unexpected Radar normalization");
  if (meta.aggInterval !== (step === 900_000 ? "FIFTEEN_MINUTES" : "ONE_HOUR")) throw new Error("Unexpected Radar interval");
  if (typeof meta.lastUpdated !== "string" || !Number.isFinite(Date.parse(meta.lastUpdated)) ||
    now - Date.parse(meta.lastUpdated) > 2 * 3_600_000) throw new Error("Stale Radar dataset");
  const confidence = object(meta.confidenceInfo);
  // Radar returns null when no confidence assessment is supplied. Explicit low confidence is rejected.
  if (confidence.level !== null && (typeof confidence.level !== "number" || confidence.level < 5))
    throw new Error("Insufficient Radar confidence");
  if (!Array.isArray(series.timestamps) || !Array.isArray(series.values) ||
    series.timestamps.length !== series.values.length) throw new Error("Invalid Radar series");
  const points: Point[] = [];
  for (let i = 0; i < series.timestamps.length; i++) {
    const raw: unknown = series.values[i], timestamp: unknown = series.timestamps[i];
    if (typeof timestamp !== "string") throw new Error("Invalid timestamp");
    const time = Date.parse(timestamp);
    if (!Number.isFinite(time) || time % step !== 0) throw new Error("Unaligned timestamp");
    // Null/missing points stay missing; they must never become zero traffic.
    if (raw === null || raw === undefined || raw === "") continue;
    if (typeof raw !== "string" && typeof raw !== "number") throw new Error("Invalid traffic value");
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error("Invalid normalized traffic value");
    if (time + step <= now - 30 * 60_000) points.push({ time, value });
  }
  points.sort((a, b) => a.time - b.time);
  if (points.some((p, i) => i > 0 && p.time === points[i - 1].time)) throw new Error("Duplicate timestamp");
  if (!points.length || now - (points.at(-1)!.time + step) > 2 * 3_600_000) throw new Error("Stale or empty traffic series");
  return points;
}
