# Radar replay fixture

`radar-2026-10-16.json` contains public, normalized Cloudflare Radar likely-automated HTTP request volume for Côte d’Ivoire, Sénégal, Burkina Faso and Bénin. No credentials or account-specific data are included.

Captured on 16 October 2026 with `/client/v4/radar/http/timeseries`, parameters `botClass=LIKELY_AUTOMATED`, `aggInterval=15m`, `normalization=MIN0_MAX`, `dateStart=2026-10-01T07:45:00Z`, `dateEnd=2026-10-16T07:45:00Z`, and the respective `location` code. Timestamps and value strings are preserved from the response. `step` is milliseconds. Mali had no alerts in the reviewed set and is omitted.

The replay evaluates samples from 15 October 10:00 UTC to 16 October 06:00 UTC with the earlier points available only as baseline history. It compares the original single-crossing episode rule with the new persistence rule. The outcome is specific to this snapshot; it is not an estimate of future accuracy or a proof of malicious traffic.
