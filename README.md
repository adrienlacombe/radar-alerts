# Radar Alerts

A Cloudflare Worker that detects unusual upward bot traffic spikes and publishes a public RSS 2.0 feed for five West African countries.

**Live feed:** [Subscribe to Radar Alerts](https://radar-west-africa-rss.adrienlacombe.workers.dev/feed.xml)

Countries: Côte d’Ivoire (`CI`), Sénégal (`SN`), Mali (`ML`), Burkina Faso (`BF`), and Bénin (`BJ`). Add the feed URL to any RSS reader. Each country has an independent baseline and alert state; one spike episode produces one feed item per country.

## How it works

Every 15 minutes, a Cron Trigger queries the [Cloudflare Radar HTTP time series API](https://developers.cloudflare.com/api/resources/radar/subresources/http/methods/timeseries/) for bot request volume. The detector compares each complete sample with the same time of day over the previous 14 days. All five countries have fixed UTC offsets, so matching UTC slots preserves local time of day.

- Baseline: median of the historical same-time samples, with at least seven days required.
- Robust variability: `sigma = 1.4826 × median absolute deviation`.
- Spike threshold: `baseline + max(4 × sigma, 0.15 × historical swing, 0.05 × baseline, 1e-9)`.
- Historical swing: 95th percentile minus 5th percentile of prior traffic.
- Re-arming: two consecutive samples below a lower recovery threshold.

Current and historical data are requested together with `MIN0_MAX` normalization, ensuring comparable values. These are normalized request volumes, not request counts or bot share percentages. A flagged anomaly is not proof of malicious activity.

Each country uses a separate SQLite-backed Durable Object. Feed items and detector state are written atomically. Stable GUIDs prevent duplicate entries, including across restarts. The feed keeps up to 30 days and returns the newest 200 items across all countries.

## Run and deploy

Requires Node.js 22.18+ and a Cloudflare account.

```sh
npm ci
npm run types
npm run check
npx wrangler login
```

The deployed Worker keeps `RADAR_API_TOKEN` as an encrypted **Cloudflare Worker secret**. No local secret file or GitHub Actions secret is needed to build, test, or redeploy it. Tests use mocked credentials.

Choose your Worker name in `wrangler.jsonc`. For accounts with access to multiple Cloudflare accounts, set `CLOUDFLARE_ACCOUNT_ID` to the intended account ID before deploying.

```sh
npm run deploy
```

Wrangler preserves the existing secret on Cloudflare and prints the Worker URL. The config declares `RADAR_API_TOKEN` as required, so deployment fails if it is missing. The current deployment's feed is [https://radar-west-africa-rss.adrienlacombe.workers.dev/feed.xml](https://radar-west-africa-rss.adrienlacombe.workers.dev/feed.xml). For your own deployment, append `/feed.xml` to the Worker URL printed by Wrangler.

### Initial secret setup or rotation

Create a [Cloudflare API token](https://developers.cloudflare.com/radar/get-started/first-request/) with **Account → Radar → Read**. In the Cloudflare dashboard, select **Workers & Pages → your Worker → Settings → Variables and Secrets → Add**, choose **Secret**, enter `RADAR_API_TOKEN` and its value, then deploy the change. Do not put the value in this repository or a local file.

Alternatively, install it with an interactive prompt:

```sh
npx wrangler secret put RADAR_API_TOKEN
```

The value is sent to Cloudflare without being written to a local secret file. `secret put` immediately deploys a new Worker version. This setup is only necessary for a new Worker or token rotation; regular code deploys reuse the installed secret. See [Cloudflare's secret management documentation](https://developers.cloudflare.com/workers/configuration/secrets/).

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `COUNTRIES` | `CI,SN,ML,BF,BJ` | Country checks enabled |
| `INTERVAL` | `15m` | Radar sample interval |
| `SIGMA_MULTIPLIER` | `4` | Sensitivity to historical variability |
| `MIN_DAILY_SWING_FRACTION` | `0.15` | Minimum deviation relative to historical traffic swing |
| `RADAR_API_TOKEN` | Secret | Read access to Radar |

The Cron Trigger runs every 15 minutes. Feed reads never trigger a Radar request or mutate detector state. The public routes `/`, `/feed.xml`, and `/rss.xml` serve RSS; GET and HEAD are supported, with ETags and a five-minute cache lifetime.

## Validation

`npm run check` runs the unit suite, TypeScript checks, a Wrangler dry run, and bundled Worker integration tests using isolated Miniflare SQLite storage. Runtime tests cover five independent spikes, deduplication, persistence after restart, read-only feed access, HTTP methods, and conditional requests, including weak ETags introduced by CDN compression. Test traffic is mocked and is never published to the live feed.

### Production verification — 15 October 2026

Live Worker logs confirmed a successful automatic Cron Trigger execution at **09:00:21 UTC (11:00:21 Paris)**. All five country checks completed without errors, each using 14 baseline days. The deployed schedule was `*/15 * * * *`; this audit observed one scheduled cycle, so it does not establish uninterrupted execution across multiple cycles.

| Country | Sample start (UTC) | Normalized bot volume | Spike threshold | Result |
| --- | --- | --- | --- | --- |
| Côte d’Ivoire (`CI`) | 08:00 | 0.238195 | 0.308904 | No spike |
| Sénégal (`SN`) | 08:00 | 0.155090 | 0.196090 | No spike |
| Mali (`ML`) | 08:00 | 0.095137 | 0.177693 | No spike |
| Burkina Faso (`BF`) | 07:45 | 0.116022 | 0.198062 | No spike |
| Bénin (`BJ`) | 07:45 | 0.226415 | 0.434023 | No spike |

The public feed returned HTTP 200 with valid RSS, a `lastBuildDate` of `Thu, 15 Oct 2026 09:00:21 GMT`, and zero items, consistent with these results. Polling every 15 minutes does not mean Radar publishes fresh samples every 15 minutes.

The deployed JavaScript bundle matched the locally tested bundle byte for byte (SHA-256: `ccf74802969182e340b317fcfd635767637da9ea2e7495f921771730ad42395c`). All 22 unit tests and the bundled runtime integration tests passed, including publication of five simulated country spikes in isolated storage. A genuine production spike and its publication were **not observed** during this audit; no synthetic entries were inserted into the public feed.

## Operational limits

The newest 30 minutes are excluded to avoid incomplete samples. Actual detection delay also includes Radar publication delay, observed at roughly one hour during initial setup. Missing samples remain missing; stale data and explicitly low confidence are rejected. Null confidence metadata is accepted as unassessed.

First checks evaluate the latest eligible sample. Later checks catch up at most six hours, so longer outages can miss episodes. Errors are recorded in Cloudflare logs. Feed availability alone does not establish that scheduled checks are healthy.

An empty feed is valid and means no spike entries have been published yet. RSS readers choose their own polling cadence. No email provider or Healthchecks account is required.
