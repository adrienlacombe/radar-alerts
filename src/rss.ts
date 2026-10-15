import { countries, type CountryCode } from "./countries.ts";

export type FeedItem = {
  id: string; country: CountryCode; time: number; published: number;
  value: number; baseline: number; threshold: number; samples: number;
};
export type FeedSnapshot = { items: FeedItem[]; lastChecked: number };

export function matchesEtag(header: string | null, etag: string): boolean {
  return header !== null && header.split(",").some(value => {
    const candidate = value.trim();
    return candidate === "*" || candidate.replace(/^W\//, "") === etag.replace(/^W\//, "");
  });
}

export function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

export function renderFeed(snapshots: FeedSnapshot[], feedUrl: string): string {
  const items = snapshots.flatMap(snapshot => snapshot.items)
    .sort((a, b) => b.published - a.published || b.time - a.time || a.id.localeCompare(b.id)).slice(0, 200);
  const latest = Math.max(Date.UTC(2026, 9, 15), ...snapshots.map(s => s.lastChecked), ...items.map(i => i.published));
  const entries = items.map(item => {
    const name = countries[item.country];
    const title = `${name} (${item.country}): unusual bot traffic spike — ${new Date(item.time).toISOString()}`;
    const description = `Bot traffic exceeded its usual time-of-day pattern in ${name}. ` +
      `Sample start (UTC): ${new Date(item.time).toISOString()}. ` +
      `Normalized traffic: ${item.value.toFixed(4)}; expected: ${item.baseline.toFixed(4)}; ` +
      `threshold: ${item.threshold.toFixed(4)}; baseline days: ${item.samples}. ` +
      "These are normalized request volumes, not request counts or bot percentages. A detected anomaly is not proof of malicious activity.";
    return `<item><title>${xml(title)}</title><link>https://radar.cloudflare.com/bots/${item.country.toLowerCase()}</link>` +
      `<guid isPermaLink="false">${xml(item.id)}</guid><pubDate>${new Date(item.published).toUTCString()}</pubDate>` +
      `<category>${xml(name)}</category><description>${xml(description)}</description></item>`;
  }).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel>
<title>Radar bot traffic spike alerts — West Africa</title>
<link>${xml(feedUrl)}</link>
<atom:link href="${xml(feedUrl)}" rel="self" type="application/rss+xml"/>
<description>Unusual upward bot traffic spikes in Côte d’Ivoire, Sénégal, Mali, Burkina Faso and Bénin. Checked every 15 minutes against each country’s normal daily cycle. One item per country per spike episode. New alerts are published from RSS activation onward.</description>
<language>en</language><ttl>15</ttl><lastBuildDate>${new Date(latest).toUTCString()}</lastBuildDate>
${entries}
</channel></rss>`;
}
