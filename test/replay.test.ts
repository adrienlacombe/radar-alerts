import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { advance, initialState, score, type State } from "../src/detector.ts";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/radar-2026-10-16.json", import.meta.url), "utf8")) as {
  timestamps: string[]; step: number; replayStart: string; values: Record<string, string[]>;
};
function replay(legacy: boolean) {
  const alerts: string[] = [];
  for (const [country, values] of Object.entries(fixture.values)) {
    const points = fixture.timestamps.map((time, i) => ({ time: Date.parse(time), value: Number(values[i]) }));
    let state: State = initialState();
    for (const point of points.filter(p => p.time >= Date.parse(fixture.replayStart) && p.time < Date.parse("2026-10-16T06:00Z"))) {
      const result = score(points, point);
      let alert: boolean;
      if (legacy) {
        const healthy = result.value <= result.recoveryThreshold ? (point.time - state.lastTime === fixture.step ? state.healthy : 0) + 1 : 0;
        alert = result.spike && !state.active;
        state = { lastTime: point.time, active: result.spike || (state.active && healthy < 2), healthy };
      } else {
        const next = advance(state, result, fixture.step);
        alert = next.alert; state = next.state;
      }
      if (alert) alerts.push(`${country} ${new Date(point.time).toISOString()}`);
    }
  }
  return alerts.sort();
}
test("historical replay reproduces the seven original alerts", () => {
  assert.deepEqual(replay(true), [
    "CI 2026-10-15T21:30:00.000Z", "CI 2026-10-15T23:30:00.000Z",
    "SN 2026-10-15T21:30:00.000Z", "BF 2026-10-15T21:30:00.000Z",
    "BJ 2026-10-15T21:15:00.000Z", "BJ 2026-10-16T02:15:00.000Z", "BJ 2026-10-16T03:45:00.000Z",
  ].sort());
});
test("persistence suppresses four marginal alerts and preserves three supported episodes", () => {
  const actual = replay(false);
  assert.deepEqual(actual, [
    "CI 2026-10-15T21:30:00.000Z",
    "BF 2026-10-15T21:45:00.000Z",
    "BJ 2026-10-16T02:30:00.000Z",
  ].sort());
  console.info("Historical replay: seven original alerts become three:", actual);
});
