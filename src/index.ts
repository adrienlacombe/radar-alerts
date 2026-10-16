import { DurableObject } from "cloudflare:workers";
import { advance, DAY, initialState, parseRadar, score, type State } from "./detector.ts";
import { countries, configuredCountries, checkCountries, type CountryCode } from "./countries.ts";
import { matchesEtag, renderFeed, type FeedItem, type FeedSnapshot } from "./rss.ts";

export class BotMonitor extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS lease (id INTEGER PRIMARY KEY, expires INTEGER NOT NULL)");
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS rss_state (id INTEGER PRIMARY KEY, state TEXT NOT NULL, checked INTEGER NOT NULL)");
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS rss_items (id TEXT PRIMARY KEY, time INTEGER NOT NULL, payload TEXT NOT NULL)");
  }

  getFeed(): FeedSnapshot {
    const items = this.ctx.storage.sql.exec<{ payload: string }>(
      "SELECT payload FROM rss_items WHERE time >= ? ORDER BY time DESC LIMIT 200", Date.now() - 30 * DAY)
      .toArray().map(row => JSON.parse(row.payload) as FeedItem);
    const rows = this.ctx.storage.sql.exec<{ checked: number }>("SELECT checked FROM rss_state WHERE id=1").toArray();
    return { items, lastChecked: rows[0]?.checked ?? 0 };
  }

  async check(country: CountryCode): Promise<void> {
    if (!Object.hasOwn(countries, country)) throw new Error("Unsupported country");
    const now = Date.now();
    const lock = this.ctx.storage.sql.exec<{ id: number }>(
      "INSERT INTO lease(id, expires) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET expires=excluded.expires WHERE lease.expires < ? RETURNING id",
      now + 180_000, now).toArray();
    if (!lock.length) return;
    try {
      const rows = this.ctx.storage.sql.exec<{ state: string }>("SELECT state FROM rss_state WHERE id=1").toArray();
      // Preserve each country's existing detector state on the first RSS deployment.
      const legacy = rows.length ? undefined : await this.ctx.storage.get<{ state: State }>("monitor");
      let state: State = rows.length ? JSON.parse(rows[0].state) as State : legacy?.state ?? initialState();
      if (!this.env.RADAR_API_TOKEN) throw new Error("RADAR_API_TOKEN is missing");
      const step = this.env.INTERVAL === "15m" ? 900_000 : 3_600_000;
      const sigma = Number(this.env.SIGMA_MULTIPLIER), fraction = Number(this.env.MIN_DAILY_SWING_FRACTION);
      if (!(sigma >= 2 && sigma <= 10 && fraction > 0 && fraction <= 1)) throw new Error("Invalid sensitivity configuration");
      const end = Math.floor(now / step) * step;
      const url = new URL("https://api.cloudflare.com/client/v4/radar/http/timeseries");
      url.search = new URLSearchParams({ location: country, botClass: "LIKELY_AUTOMATED",
        dateStart: new Date(end - 15 * DAY).toISOString(), dateEnd: new Date(end).toISOString(),
        aggInterval: this.env.INTERVAL, normalization: "MIN0_MAX", format: "JSON" }).toString();
      const response = await fetch(url, { headers: { Authorization: `Bearer ${this.env.RADAR_API_TOKEN}` },
        signal: AbortSignal.timeout(25_000) });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Radar HTTP ${response.status}; check token and requested time range/interval`);
      }
      const points = parseRadar(await response.json(), now, step);
      const pending = state.lastTime === 0 ? points.slice(-1) :
        points.filter(p => p.time > state.lastTime && p.time + step >= now - 6 * 3_600_000);
      for (const point of pending) {
        if (Date.now() - now > 120_000) break;
        const result = score(points, point, sigma, fraction);
        const next = advance(state, result, step);
        this.ctx.storage.transactionSync(() => {
          if (next.alert) {
            const item: FeedItem = { id: `radar-${country.toLowerCase()}-spike-${point.time}`, country,
              time: point.time, published: now, value: result.value, baseline: result.baseline,
              threshold: result.threshold, samples: result.samples };
            this.ctx.storage.sql.exec("INSERT OR IGNORE INTO rss_items(id,time,payload) VALUES(?,?,?)",
              item.id, item.time, JSON.stringify(item));
          }
          this.ctx.storage.sql.exec("INSERT INTO rss_state(id,state,checked) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state, checked=excluded.checked",
            JSON.stringify(next.state), now);
        });
        state = next.state;
        console.log(JSON.stringify({ event: "evaluated", country, ...result, active: state.active,
          crossings: state.crossings, published: next.alert, alertReason: next.reason }));
      }
      this.ctx.storage.sql.exec("INSERT INTO rss_state(id,state,checked) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET checked=excluded.checked", JSON.stringify(state), now);
      this.ctx.storage.sql.exec("DELETE FROM rss_items WHERE time < ? OR id NOT IN (SELECT id FROM rss_items ORDER BY time DESC LIMIT 200)", now - 30 * DAY);
      console.log(JSON.stringify({ event: "country_check_complete", country, latestSample: points.at(-1)!.time }));
    } catch (error) {
      console.error(JSON.stringify({ event: "monitor_failed", country, message: error instanceof Error ? error.message : "Unknown error" }));
      throw error;
    } finally {
      this.ctx.storage.sql.exec("DELETE FROM lease WHERE id=1");
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!["GET", "HEAD"].includes(request.method)) return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
    const url = new URL(request.url);
    if (!["/", "/feed.xml", "/rss.xml"].includes(url.pathname)) return new Response("Not found", { status: 404 });
    try {
      const snapshots = await Promise.all(configuredCountries(env.COUNTRIES).map(country =>
        env.MONITOR.getByName(`${country.toLowerCase()}-bot-traffic`).getFeed()));
      const body = renderFeed(snapshots, `${url.origin}/feed.xml`);
      const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
      const etag = `"${Array.from(new Uint8Array(hash), v => v.toString(16).padStart(2, "0")).join("")}"`;
      const headers = { "Content-Type": "application/rss+xml; charset=utf-8", "Cache-Control": "public, max-age=300",
        "X-Content-Type-Options": "nosniff", ETag: etag };
      if (matchesEtag(request.headers.get("If-None-Match"), etag)) return new Response(null, { status: 304, headers });
      return new Response(request.method === "HEAD" ? null : body, { headers });
    } catch {
      console.error(JSON.stringify({ event: "rss_read_failed" }));
      return new Response("Feed temporarily unavailable", { status: 503, headers: { "Retry-After": "60" } });
    }
  },
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await checkCountries(configuredCountries(env.COUNTRIES), country =>
      env.MONITOR.getByName(`${country.toLowerCase()}-bot-traffic`).check(country));
  },
} satisfies ExportedHandler<Env>;
