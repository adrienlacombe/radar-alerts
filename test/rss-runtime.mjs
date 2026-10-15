import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const persist = mkdtempSync(join(tmpdir(), "radar-rss-test-"));
const seen = new Set();
const countries = ["CI", "SN", "ML", "BF", "BJ"];
const now = Date.now(), step = 900_000;
const latest = Math.floor((now - 30 * 60_000 - step) / step) * step;
const timestamps = Array.from({ length: 15 * 96 }, (_, i) => new Date(latest - (15 * 96 - 1 - i) * step).toISOString());
const values = timestamps.map((_t, i) => String(i === timestamps.length - 1 ? 0.95 : 0.35 + 0.2 * Math.sin(2 * Math.PI * (i % 96) / 96)));
const options = {
  name: "radar-rss-runtime", modules: true, scriptPath: "dist/index.js", compatibilityDate: "2026-10-15",
  durableObjects: { MONITOR: { className: "BotMonitor", useSQLite: true } },
  durableObjectsPersist: persist,
  bindings: { COUNTRIES: countries.join(","), RADAR_API_TOKEN: "mock-token", INTERVAL: "15m", SIGMA_MULTIPLIER: "4", MIN_DAILY_SWING_FRACTION: "0.15" },
  outboundService: async request => {
    const url = new URL(request.url);
    assert.equal(url.origin, "https://api.cloudflare.com");
    assert.equal(url.pathname, "/client/v4/radar/http/timeseries");
    const country = url.searchParams.get("location");
    assert.ok(countries.includes(country)); seen.add(country);
    return Response.json({ success: true, result: {
      meta: { normalization: "MIN0_MAX", aggInterval: "FIFTEEN_MINUTES", lastUpdated: new Date(now).toISOString(), confidenceInfo: { level: null } },
      serie_0: { timestamps, values },
    } });
  },
};
let mf;
try {
  mf = new Miniflare({ ...convertV4MiniflareOptions(options), resourcePersistencePath: persist });
  const empty = await mf.dispatchFetch("https://feed.example/feed.xml");
  assert.equal(empty.status, 200);
  assert.ok(!(await empty.text()).includes("<item>"));
  assert.equal(seen.size, 0, "public feed reads must not initiate Radar requests");
  const worker = await mf.getWorker();
  const scheduled = await worker.scheduled({ cron: "*/15 * * * *" });
  assert.equal(scheduled.outcome, "ok");
  assert.equal(seen.size, 5);
  const response = await mf.dispatchFetch("https://feed.example/feed.xml");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("Content-Type"), /application\/rss\+xml/);
  const body = await response.text();
  assert.equal((body.match(/<item>/g) ?? []).length, 5);
  for (const country of countries) assert.ok(body.includes(`radar-${country.toLowerCase()}-spike-`));
  assert.ok(!body.includes("mock-token"));
  assert.ok(!body.includes("@starknet.org"));
  const etag = response.headers.get("ETag");
  assert.equal((await mf.dispatchFetch("https://feed.example/feed.xml", { headers: { "If-None-Match": etag } })).status, 304);
  assert.equal((await mf.dispatchFetch("https://feed.example/feed.xml", { headers: { "If-None-Match": `W/${etag}` } })).status, 304);
  assert.equal((await mf.dispatchFetch("https://feed.example/feed.xml", { method: "HEAD" })).status, 200);
  assert.equal((await mf.dispatchFetch("https://feed.example/check", { method: "POST" })).status, 405);
  assert.equal((await mf.dispatchFetch("https://feed.example/missing")).status, 404);
  assert.equal((await worker.scheduled({ cron: "*/15 * * * *" })).outcome, "ok");
  assert.equal(((await (await mf.dispatchFetch("https://feed.example/feed.xml")).text()).match(/<item>/g) ?? []).length, 5);
  await mf.dispose();
  mf = new Miniflare({ ...convertV4MiniflareOptions(options), resourcePersistencePath: persist });
  const persisted = await (await mf.dispatchFetch("https://feed.example/feed.xml")).text();
  assert.equal((persisted.match(/<item>/g) ?? []).length, 5, "feed items must survive Worker restart");
  console.log("RSS runtime checks passed: five independent spikes, deduplication, persistence, read-only feed, ETag and routes.");
} finally {
  await mf?.dispose();
  rmSync(persist, { recursive: true, force: true });
}
