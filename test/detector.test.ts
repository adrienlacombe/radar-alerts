import { test } from "node:test";
import assert from "node:assert/strict";
import { advance, DAY, initialState, parseRadar, score, type Point } from "../src/detector.ts";

const step = 900_000;
const start = Date.UTC(2026, 8, 20);
function history(): Point[] {
  return Array.from({ length: 15 * 96 }, (_, i) => ({ time: start + i * step,
    value: 0.35 + 0.25 * Math.sin(2 * Math.PI * ((i % 96) / 96 - 0.25)) + (Math.floor(i / 96) % 3) * 0.003 }));
}
test("normal day/night cycles never trigger", () => {
  const points = history();
  for (const p of points.slice(14 * 96)) assert.equal(score(points, p).spike, false);
});
test("both night and daytime spikes trigger", () => {
  const points = history();
  for (const index of [14 * 96, 14 * 96 + 48]) {
    const p = { ...points[index], value: points[index].value + 0.25 };
    assert.equal(score(points, p).spike, true);
  }
});
test("downward disruption is not an upward spike", () => {
  const points = history();
  assert.equal(score(points, { ...points.at(-1)!, value: 0 }).spike, false);
});
test("isolated historical spikes do not lift the robust baseline", () => {
  const points = history();
  const target = points.at(-1)!;
  const normal = score(points, target);
  points[points.length - 1 - 96].value = 1;
  points[points.length - 1 - 192].value = 1;
  assert.ok(Math.abs(score(points, target).baseline - normal.baseline) < 0.01);
  assert.equal(score(points, { ...target, value: target.value + 0.3 }).spike, true);
});
test("shared normalization scaling preserves decisions", () => {
  const points = history(), p = { ...points.at(-1)!, value: 0.9 };
  const result = score(points, p);
  const scaled = score(points.map(p => ({ ...p, value: p.value / 4 })), { ...p, value: p.value / 4 });
  assert.equal(result.spike, scaled.spike);
  assert.ok(Math.abs(result.threshold / 4 - scaled.threshold) < 1e-10);
});
test("one email per episode; two contiguous healthy samples re-arm", () => {
  const points = history(), p = points.at(-1)!;
  const spike = score(points, { ...p, value: 0.9 });
  const first = advance(initialState(), spike, step);
  assert.equal(first.alert, true);
  assert.equal(advance(first.state, spike, step).alert, false);
  const repeated = advance(first.state, { ...spike, time: p.time + step }, step);
  assert.equal(repeated.alert, false);
  const healthy = { ...spike, value: spike.baseline, spike: false };
  const one = advance(repeated.state, { ...healthy, time: p.time + 2 * step }, step);
  assert.equal(one.state.active, true);
  const two = advance(one.state, { ...healthy, time: p.time + 3 * step }, step);
  assert.equal(two.state.active, false);
  assert.equal(advance(two.state, { ...spike, time: p.time + 4 * step }, step).alert, true);
});
test("missing samples do not count as consecutive recovery", () => {
  const points = history(), result = score(points, points.at(-1)!);
  const one = advance({ lastTime: result.time - step, active: true, healthy: 0 }, result, step);
  const afterGap = advance(one.state, { ...result, time: result.time + 2 * step }, step);
  assert.equal(afterGap.state.active, true);
  assert.equal(afterGap.state.healthy, 1);
});
test("insufficient baseline is rejected", () => {
  const points = history().slice(-96);
  assert.throws(() => score(points, points.at(-1)!), /seven prior days/);
});

const now = start + 15 * DAY;
function payload() {
  return { success: true, result: {
    meta: { normalization: "MIN0_MAX", aggInterval: "FIFTEEN_MINUTES", lastUpdated: new Date(now - step).toISOString(), confidenceInfo: { level: null as number | null } },
    serie_0: { timestamps: [new Date(now - 3 * step).toISOString(), new Date(now - step).toISOString()], values: ["0.5", "0.8"] as (string | null)[] }
  } };
}
test("partial recent samples excluded; null confidence is accepted", () => {
  assert.deepEqual(parseRadar(payload(), now, step), [{ time: now - 3 * step, value: 0.5 }]);
});
test("missing values never become zero", () => {
  const p = payload(); p.result.serie_0.values[0] = null;
  assert.throws(() => parseRadar(p, now, step), /empty/);
});
test("explicit low confidence rejected", () => {
  const p = payload(); p.result.meta.confidenceInfo.level = 3;
  assert.throws(() => parseRadar(p, now, step), /confidence/);
});
test("stale dataset and stale last sample rejected", () => {
  const p = payload(); p.result.meta.lastUpdated = new Date(now - DAY).toISOString();
  assert.throws(() => parseRadar(p, now, step), /Stale Radar/);
  const q = payload(); q.result.serie_0.timestamps = [new Date(now - DAY).toISOString()]; q.result.serie_0.values = ["0.5"];
  assert.throws(() => parseRadar(q, now, step), /Stale or empty/);
});
test("normalization, interval, invalid values and duplicate points rejected", () => {
  const p = payload(); p.result.meta.normalization = "MIN_MAX";
  assert.throws(() => parseRadar(p, now, step), /normalization/);
  const q = payload(); q.result.meta.aggInterval = "ONE_HOUR";
  assert.throws(() => parseRadar(q, now, step), /interval/);
  const r = payload(); r.result.serie_0.values[0] = "nonsense";
  assert.throws(() => parseRadar(r, now, step), /traffic value/);
  const s = payload(); s.result.serie_0.timestamps[1] = s.result.serie_0.timestamps[0];
  assert.throws(() => parseRadar(s, now, step), /Duplicate/);
});
