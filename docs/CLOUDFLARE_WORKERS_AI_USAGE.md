# Cloudflare Workers AI usage estimate for XFeed Paradise

Checked 2026-09-24. This is a capacity estimate, **not** a measurement of Cloudflare account consumption.

## Current project usage

XFeed Paradise v1.3.1 sends AI scoring requests to Groq (`api.groq.com`) and has no Cloudflare Workers AI endpoint, binding, or model reference in either the extension or `xfeed-paradise-backend` source. Its present Workers AI inference consumption is therefore **zero from the current project code**. Cloudflare DNS/CDN traffic or other projects on the same Cloudflare account are separate and are not included in this statement. The extension has not yet been verified as installed in Chrome, so there is no reliable observed daily post volume.

## If scoring moved to Cloudflare

Cloudflare's [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/) lists a free allocation of **10,000 Neurons per day**, reset at 00:00 UTC. For `@cf/openai/gpt-oss-20b`, the published rates are **18,182 Neurons per million input tokens** and **27,273 Neurons per million output tokens**. Paid usage above the allowance is listed at $0.011 per 1,000 Neurons, with the Workers Paid plan required to exceed the free allocation.

The extension caps post text at 200 characters and scores up to 10 items per request. Its batch timer is 150 ms, so requests are not guaranteed to be full. I sent synthetic, non-user examples through the extension's actual prompt and Groq GPT-OSS 20B request settings to obtain these token counts. Cloudflare tokenization and reasoning-token accounting may differ, so these conversions are approximate.

| Batch | Measured input / output tokens | Estimated Cloudflare GPT-OSS 20B Neurons | Approx. posts within 10,000 Neurons/day if all batches look like this |
| --- | ---: | ---: | ---: |
| 1 short post | 191 / 26 | 4.2 | 2,400 |
| 5 short posts | 241 / 80 | 6.6 | 7,600 |
| 10 short posts | 299 / 139 | 9.2 | 10,800 |
| 10 posts capped at 200 characters | 573 / 50 | 11.8 | 8,500 |

Formula: `Neurons ≈ input_tokens × 18,182 / 1,000,000 + output_tokens × 27,273 / 1,000,000`. Output length varies; a 10-item long batch with 140 output tokens would cost about 14.2 Neurons instead of 11.8.

At **200 scored posts/day**, this implies roughly **200–840 Neurons/day** (about **2–8%** of the free allocation), depending primarily on batch fill. At **1,000 posts/day**, roughly **900–4,200 Neurons/day** (about **9–42%**). These are scenarios, not measured user activity. Shared account-wide Workers AI use would reduce remaining headroom.

## What was not measured

The available Cloudflare account token could list two accounts but could not access the restricted billable-usage endpoint (authentication error). No account-wide Workers AI Neuron total or per-project attribution was obtained. For a future live comparison, check the [Workers AI dashboard](https://dash.cloudflare.com/) for daily Neurons, then record actual batch sizes and model token usage after a Cloudflare integration exists.
