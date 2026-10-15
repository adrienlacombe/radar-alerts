import { test } from "node:test";
import assert from "node:assert/strict";
import { matchesEtag, renderFeed, xml, type FeedItem } from "../src/rss.ts";
import { countries } from "../src/countries.ts";

const item: FeedItem = { id: "radar-ci-spike-123", country: "CI", time: Date.UTC(2026, 9, 15, 7),
  published: Date.UTC(2026, 9, 15, 8), value: 0.8, baseline: 0.2, threshold: 0.4, samples: 14 };
test("conditional requests accept CDN-weakened ETags and tag lists", () => {
  assert.equal(matchesEtag('W/"abc"', '"abc"'), true);
  assert.equal(matchesEtag('"old", W/"abc"', '"abc"'), true);
  assert.equal(matchesEtag('*', '"abc"'), true);
  assert.equal(matchesEtag('W/"other"', '"abc"'), false);
  assert.equal(matchesEtag(null, '"abc"'), false);
});
test("empty feed is valid RSS with every country named and no invented alerts", () => {
  const feed = renderFeed([{ items: [], lastChecked: item.published }], "https://example.com/feed.xml");
  assert.match(feed, /^<\?xml version="1.0"/);
  assert.match(feed, /<rss version="2.0"/);
  for (const country of Object.values(countries)) assert.ok(feed.includes(country));
  assert.ok(!feed.includes("<item>"));
  assert.ok(feed.includes("Thu, 15 Oct 2026 08:00:00 GMT"));
});
test("feed merges separate country spikes newest first with stable unique GUIDs", () => {
  const sn: FeedItem = { ...item, id: "radar-sn-spike-123", country: "SN", published: item.published + 60_000 };
  const feed = renderFeed([{ items: [item], lastChecked: 0 }, { items: [sn], lastChecked: 0 }], "https://example.com/feed.xml");
  assert.ok(feed.indexOf("radar-sn-spike-123") < feed.indexOf(item.id));
  assert.match(feed, /<guid isPermaLink="false">radar-ci-spike-123<\/guid>/);
  assert.ok(feed.includes("https://radar.cloudflare.com/bots/sn"));
  assert.ok(feed.includes("expected: 0.2000; threshold: 0.4000"));
});
test("XML text and attribute values are escaped", () => {
  assert.equal(xml('&<>"\''), "&amp;&lt;&gt;&quot;&apos;");
  const feed = renderFeed([{ items: [{ ...item, id: '<unsafe&"' }], lastChecked: 0 }], "https://example.com/feed.xml?a=1&b=2");
  assert.ok(feed.includes("&lt;unsafe&amp;&quot;"));
  assert.ok(feed.includes("?a=1&amp;b=2"));
  assert.ok(!feed.includes("<unsafe"));
});
test("combined feed is bounded to the newest 200 items", () => {
  const items = Array.from({ length: 250 }, (_, i) => ({ ...item, id: `item-${i}`, published: item.published + i }));
  const feed = renderFeed([{ items, lastChecked: 0 }], "https://example.com/feed.xml");
  assert.equal((feed.match(/<item>/g) ?? []).length, 200);
  assert.ok(!feed.includes('>item-0<'));
  assert.ok(feed.includes('>item-249<'));
});
