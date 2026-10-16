import { test } from "node:test";
import assert from "node:assert/strict";
import { configuredCountries, checkCountries, countries, type CountryCode } from "../src/countries.ts";
import { advance, initialState, type State } from "../src/detector.ts";

test("the five requested countries have distinct ISO codes", () => {
  assert.deepEqual(configuredCountries("CI,SN,ML,BF,BJ"), ["CI", "SN", "ML", "BF", "BJ"]);
  assert.equal(countries.BJ, "Bénin");
  for (const invalid of ["CI,CI", "CI,XX", "", "SN,"]) assert.throws(() => configuredCountries(invalid));
});
test("a failed country does not prevent the other four checks", async () => {
  const checked: CountryCode[] = [];
  await assert.rejects(checkCountries(configuredCountries("CI,SN,ML,BF,BJ"), async code => {
    checked.push(code);
    if (code === "ML") throw new Error("Data unavailable");
  }), /Country checks failed: ML/);
  assert.deepEqual(checked, ["CI", "SN", "ML", "BF", "BJ"]);
});
test("simultaneous country spikes each alert, then suppress repeats independently", async () => {
  const states = new Map<CountryCode, State>();
  const alerts: CountryCode[] = [];
  const sample = { time: 900_000, value: 0.9, baseline: 0.3, threshold: 0.6,
    immediateThreshold: 0.9, recoveryThreshold: 0.4, samples: 14, spike: true };
  const codes = configuredCountries("CI,SN,ML,BF,BJ");
  for (const time of [900_000, 1_800_000]) await checkCountries(codes, async code => {
    const next = advance(states.get(code) ?? initialState(), { ...sample, time }, 900_000);
    states.set(code, next.state);
    if (next.alert) alerts.push(code);
  });
  assert.deepEqual(alerts, codes);
});
test("a synchronous country routing failure also leaves other countries running", async () => {
  const checked: CountryCode[] = [];
  await assert.rejects(checkCountries(configuredCountries("CI,SN,ML,BF,BJ"), code => {
    checked.push(code);
    if (code === "CI") throw new Error("Routing failure");
    return Promise.resolve();
  }), /Country checks failed: CI/);
  assert.deepEqual(checked, ["CI", "SN", "ML", "BF", "BJ"]);
});
