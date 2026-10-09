# EasyPost for Swell

Connects a Swell store to [EasyPost](https://www.easypost.com). Customers see live EasyPost carrier rates at checkout. The app buys the shipping label from your EasyPost account, automatically when an order is paid or with a button on the order page, fulfills the order in Swell with the carrier and tracking number, and keeps the tracking status on the order.

## Features

- **Live rates at checkout:** a Swell shipping extension. When a cart's shipping address or items change, the app asks EasyPost for rates (`POST /shipments`) from your ship-from address to the customer's, for one parcel. Every carrier service becomes a checkout option, named like `USPS Priority` or `UPS Ground`, with estimated delivery days. You can limit carrier accounts and services, and add a markup and a handling fee. Other shipping services (Swell's own, or other apps') stay as they are.
- **Labels:** the app creates an EasyPost shipment for the order and buys the rate for the service the customer chose at checkout (`POST /shipments/{id}/buy`). If that service isn't available, or the order was shipped with a non-EasyPost service, it buys the cheapest rate, or stops, depending on **Label service**. International labels include a customs declaration built from the order items. Labels are bought:
  - automatically when an order is paid or submitted (**Buy labels** setting), or
  - with **Buy EasyPost label** on the order page (the default, so nothing is charged until you choose).
- **Fulfillment:** after buying, the app creates a Swell shipment for everything still to ship, with the carrier, service and tracking number.
- **Void label:** **Void EasyPost label** on the order page asks the carrier to refund the label (`POST /shipments/{id}/refund`), cancels its Swell shipment, and lets you buy a new label.
- **Tracking:** every hour the app refreshes the EasyPost tracker of each label that hasn't been delivered yet, and saves the status, latest scan and estimated delivery on the order. **Refresh tracking now** in the app settings runs it right away. With the optional webhook, updates arrive as they happen.
- **Order tab:** an **EasyPost** tab on the order page shows the status, EasyPost shipment ID, carrier, service, tracking number, tracking status and details, estimated delivery, tracking page, label link, postage, refund status and the last error. The orders list gets an **EasyPost** status column.
- **Test connection:** the action in the app settings checks the API key, lists your carrier accounts (production keys only) and flags a missing ship-from address or webhook secret.

## Settings

All credentials and options are app settings (`settings/easypost.json`). Nothing is hard-coded.

| Setting | Required | Default | Description |
|---|---|---|---|
| API key | yes | | EasyPost → Account Settings → API Keys. Use a test key (`EZTK…`) in Swell's test environment and a production key (`EZAK…`) in live. Stored as a secret. |
| Enabled | no | on | Turns off rates, labels, tracking and webhooks without uninstalling the app. |
| **Ship-from address** | | | |
| Name, Company | no | | Sender name. The company is used as the name when the name is empty. |
| Street, Street line 2 | Street: yes | | |
| City | yes | | |
| State / province code | for some countries | | e.g. `CA`. Needed for US, Canada and other countries where carriers require it. |
| Postal code | yes | | |
| Country code | yes | | 2-letter ISO code, e.g. `US`. |
| Phone, Email | no | | Some carriers need a phone number to buy a label. |
| **Checkout rates** | | | |
| Show EasyPost rates at checkout | no | on | Turns checkout rates off while keeping labels and tracking. |
| Carrier accounts | no | all | Comma-separated EasyPost carrier account IDs (`ca_…`) to quote. Also applies to labels. |
| Services | no | all | Comma-separated `Carrier:Service` pairs to offer, e.g. `USPS:Priority, UPS:Ground`. Case doesn't matter. Also limits the cheapest-rate fallback for labels. |
| Markup (%) | no | 0 | Added to each EasyPost rate. |
| Handling fee | no | 0 | Flat amount added to each rate after the markup, in the checkout currency. |
| Show estimated delivery days | no | on | Shows "Estimated delivery in N days" under each option. |
| **Default parcel** | | | |
| Length, Width, Height, Unit | no | 10 × 8 × 4 in | Box size used for every rate and label. Unit is `in` or `cm` (sent to EasyPost in inches). |
| Default weight, Weight unit | no | 1 lb | Used when the items have no shipping weight. Unit is `lb`, `oz`, `kg` or `g` (sent to EasyPost in ounces). |
| **Labels** | | | |
| Buy labels | no | Only with Buy label on the order page | Or **Automatically when an order is paid** (`order.paid`) or **submitted** (`order.submitted`). Labels are charged to your EasyPost account. |
| Label service | no | Service the customer chose, else the cheapest | **Only the service the customer chose** never substitutes. **Always the cheapest** ignores the customer's choice. Orders shipped with a non-EasyPost service get the cheapest rate, unless set to the customer's choice only. |
| Label format | no | PDF | `PDF`, `PNG` or `ZPL` (thermal printers). |
| Create Swell shipment when a label is bought | no | on | Fulfills the Swell order. When off, the label and tracking are still saved on the EasyPost tab. |
| Customs signer | no | ship-from name | Name that signs customs forms for international labels. |
| **Webhook** | | | |
| Webhook secret | no (recommended) | | Any long random string. When set, enter the same value as the webhook secret in EasyPost: events must carry a valid signature, and unsigned ones are rejected. When empty, events are accepted unsigned. Stored as a secret. |
| Webhook URL | read-only | `https://{store-id}:{public-key}@{store-id}.swell.store/functions/easypost/easypost-webhook` | The URL pattern to add in EasyPost, with the placeholders replaced. |

**Actions:** **Test connection** and **Refresh tracking now** are in the Actions menu on the app's settings page. **Buy EasyPost label** and **Void EasyPost label** are on each order's page; Void shows only while the order has a label. While **Enabled** is off, Buy, Void and Refresh tracking now do nothing and say so; Test connection still works.

## Setup

1. In EasyPost, connect your carrier accounts (or use EasyPost's default USPS account). Copy an API key from **Account Settings → API Keys**: the test key for Swell's test environment, the production key for live. Production labels need a payment method in EasyPost.
2. Install the app in Swell and open its settings. Enter the **API key** and the **Ship-from address**, adjust the **Default parcel**, choose when to **Buy labels**, and save.
3. Run **Test connection** from the Actions menu. It should say "Connected to EasyPost".
4. Go to **Settings → Shipping**. Turn on **EasyPost** in the list and click **Save changes**. Checkout rates appear only after this step.
5. *(Optional)* Set up the EasyPost webhook as described in [Webhook setup](#webhook-setup).
6. Add an item to a cart and enter a shipping address. EasyPost rates should show at checkout.
7. Place and pay a test order. With **Buy labels** on automatic, its EasyPost tab says **Label purchased** within a few seconds. Otherwise open the order and click **Buy EasyPost label**. The order gets a shipment with the tracking number. Test-key labels are free samples.

## Webhook setup

The webhook is optional. Without it, the app refreshes tracking every hour. With it, EasyPost sends tracker updates as the carrier scans the parcel.

**What it handles**

| EasyPost event | What the app does |
|---|---|
| `tracker.created`, `tracker.updated` | Loads the tracker from EasyPost and saves its status, latest scan, estimated delivery and tracking page on the order with that tracker or tracking number. |

Other events are acknowledged and ignored. Labels and voids don't need the webhook, because the app makes those calls itself.

**Steps**

1. **Pick a secret (recommended).** In the app settings, set **Webhook secret** to a long random string (for example the output of `openssl rand -hex 32`) and save. With a secret, only events EasyPost signed with it are accepted. Without one, the webhook accepts unsigned events; skip the secret in steps 3 and 4 then.
2. **Build the URL.** Take the pattern from the read-only **Webhook URL** setting:

   ```
   https://{store-id}:{public-key}@{store-id}.swell.store/functions/easypost/easypost-webhook
   ```

   - `{store-id}`: your Swell store ID, the subdomain of your `*.swell.store` address.
   - `{public-key}`: a Swell **public** key from **Developer → API keys**. Use the test key to reach the test environment and the live key for live. Never use a secret key here.
3. **Add it in EasyPost.** In EasyPost, open **Account Settings → Webhooks**, add the URL and, if you set one in step 1, enter the **same secret** as its webhook secret. EasyPost webhooks belong to a mode: add a test webhook (Swell test key URL) for your test API key and a production webhook (Swell live key URL) for your production key. You can also create it with EasyPost's API: `POST https://api.easypost.com/v2/webhooks` with `{"webhook": {"url": "…", "webhook_secret": "…"}}`, authenticated with the API key of the mode you want. EasyPost doesn't show the secret again, so keep a copy.
4. **Test it.** Buy a test label from a Swell order (**Buy EasyPost label**). EasyPost sends `tracker.created` for the new tracker, and the order's EasyPost tab gets its tracking status. To send a request yourself, sign the exact body with the secret (without a secret, leave out the `X-Hmac-Signature` header):

   ```bash
   BODY='{"object":"Event","description":"tracker.updated","result":{"object":"Tracker","id":"trk_test"}}'
   SIG="hmac-sha256-hex=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac '{webhook-secret}' | awk '{print $NF}')"
   curl -X POST 'https://{store-id}:{public-key}@{store-id}.swell.store/functions/easypost/easypost-webhook' \
     -H 'Content-Type: application/json' -H "X-Hmac-Signature: $SIG" -d "$BODY"
   ```

   A working webhook answers `200` with `{"received":true,"event":"tracker.updated"}`. Then check the app's function logs (`swell logs --type function -s EasyPost`) for the `easypost-webhook` call. With the made-up tracker ID the background step logs a 404 from EasyPost, which is expected.

**Troubleshooting**

| Response | Cause |
|---|---|
| `401` | **Webhook secret** is set, and the event has no `X-Hmac-Signature` or was signed with a different secret (for example, the secret isn't entered in the EasyPost webhook). Log entry: `EasyPost: webhook rejected`, with `has_signature` and `has_secret`. |
| `404` `Function app.easypost.easypost-webhook not found` | The public key is missing from the URL, belongs to another store, or the app isn't installed in that environment. |
| `200` but nothing changes | **Enabled** is off, the webhook and the API key are in different modes (test vs production), or no order has that tracker. |

To rotate the secret, change **Webhook secret** in the app settings and in the EasyPost webhook at the same time. Events signed with the old secret are rejected in between, and the hourly refresh catches up.

## How it works

| Function | Trigger | What it does |
|---|---|---|
| `functions/shipping-rates.ts` | `after:order.shipping`, extension `easypost` | Gets EasyPost rates and adds them to `shipment_rating.services`. |
| `functions/easypost-order-events.ts` | `order.submitted`, `order.paid` | Buys the label on the event chosen in **Buy labels**. |
| `functions/refresh-tracking.ts` | Cron, every hour | Refreshes trackers of labels not delivered yet. |
| `functions/easypost-webhook.ts` | Public route, `POST` | Receives EasyPost tracker events. |
| `functions/test-connection.ts` | Settings action | Checks the key and lists carrier accounts. |
| `functions/refresh-tracking-now.ts` | Settings action | Runs the tracking refresh now. |
| `functions/buy-label.ts` | Order page action | Buys the label for one order. |
| `functions/void-label.ts` | Order page action | Refunds the order's label. |
| `functions/lib/easypost.ts` | Shared | EasyPost API client, addresses, unit conversion, parcels, customs, rate mapping, label rate choice. |
| `functions/lib/labels.ts` | Shared | Buying and voiding labels, Swell shipment creation, tracking. |

Data stored on each order under `$app.easypost` (`models/orders.json`): `easypost_status` (`label_purchased`, `voided` or `error`), `easypost_shipment_id`, `easypost_tracker_id`, `easypost_tracking_code`, `easypost_tracking_url`, `easypost_label_url`, `easypost_carrier`, `easypost_service`, `easypost_label_cost`, `easypost_label_currency`, `easypost_refund_status`, `easypost_swell_shipment_id`, `easypost_tracking_status`, `easypost_tracking_details`, `easypost_tracking_date`, `easypost_eta`, `easypost_checked_at`, `easypost_error`.

**Rates:** each option's ID is `easypost_<carrier>_<service>` in lowercase, e.g. `easypost_usps_priority`, so it stays stable between rate requests and the label can be bought for the same service later. Options also carry `easypost_carrier` and `easypost_service`. The rating hook's data holds only the cart fields that changed (shipping address, rating, currency). The rest of the cart, including items and `account_id`, comes from the stored record in `$record`, and the app merges the two. The customer's email is looked up from `account_id` and sent with the ship-to address.

**Units:** Swell item weights are line totals in the store's weight unit (`/settings/shipments` → `weight_unit`). They're summed and converted to ounces, the unit EasyPost uses, with one decimal. Dimensions are converted to inches. If no item has a weight, the default weight and unit are used.

**Buying a label:** the app creates an EasyPost shipment with the order's addresses, the parcel, the order number as `reference`, the label format and, for international orders, `customs_info`. It picks the rate (see **Label service**) and buys it. The EasyPost shipment ID is saved on the order before buying. Swell functions have 10 seconds, so the create and buy calls get 5 and 4 seconds. If a run times out after EasyPost bought the label, the next try (the model-event retry, or **Buy EasyPost label** again) finds that shipment, sees its label and uses it instead of buying a second one.

**Customs:** one customs item per order item, with the product name, quantity, line total, weight in ounces, SKU, `hs_code` and `origin_country` from the product when set (otherwise the ship-from country). Contents type is `merchandise`, EEL/PFC is `NOEEI 30.37(a)` and undeliverable parcels are returned.

**Swell shipments:** `carrier` is the EasyPost carrier in lowercase (`USPS` → `usps`), `service` is the readable service name (`GroundAdvantage` → `Ground Advantage`), and `notes` has the EasyPost shipment ID and tracking page.

**Tracking:** each pass refreshes up to 20 labels with `GET /trackers/{id}`, least recently checked first, stopping after about 6 seconds. Labels delivered, returned, failed or canceled, and orders older than 60 days, are no longer refreshed. Updates older than the last saved one are skipped, and a tracker whose shipment isn't the order's label is ignored.

**Webhook security:** with a **Webhook secret** set, EasyPost signs each event with it: `X-Hmac-Signature: hmac-sha256-hex=<HMAC-SHA256 of the raw body>`, with the secret normalized to Unicode NFKD, as EasyPost's client libraries do. The handler computes the signature over `req.rawBody` (the exact text EasyPost sent) and compares it in constant time; anything unsigned or mis-signed gets a `401`. Without a secret, the signature isn't checked. Either way the handler never trusts the payload: it loads the tracker again with `GET /trackers/{id}` using your API key, so a forged event can at most trigger a refresh of a real tracker. It answers right away and does the work after responding.

## Limits

- **One parcel, one label per order:** rates and labels use one box with the default dimensions. Split shipments and multi-parcel labels aren't supported.
- **Rates aren't reserved:** the label is bought at the price EasyPost quotes when buying, which can differ from the checkout price.
- **Currencies:** a rate is shown only if EasyPost quoted it in the cart currency (usually USD). Otherwise it's skipped, and a warning is logged.
- **Checkout speed:** EasyPost has 8 seconds to return rates. If it fails or takes longer, checkout shows only the other services, and the error is logged.
- **Customs:** rate requests don't include customs, so a few international rates may be missing at checkout. Labels include a basic declaration; carriers that need more (for example commercial invoices or tax IDs) fail with EasyPost's error on the order.
- **Voiding:** carriers refund only unused labels within their own time limits. A rejected refund leaves the label and shipment in place. The refund status is saved when you void; later changes aren't followed.
- **Carrier accounts:** EasyPost lists carrier accounts only for production keys, so **Test connection** skips them with a test key.
- **Tracking:** without the webhook, tracking can be up to an hour old.
- **Webhook URL credentials:** the Swell public key goes in the URL (`https://{store-id}:{public-key}@…`), the way Swell routes public functions to the right environment. If EasyPost refuses URLs with credentials, use the hourly refresh.
- **Retries:** errors are saved to the order's `easypost_error`. EasyPost 5xx, network and Swell errors are rethrown, so automatic buys are retried by the platform; 4xx errors (bad address, no rates, insufficient funds) are not. Model-event functions that keep failing are turned off by the platform after about 4 days.

## Development

Source: [swellstores/easypost_app](https://github.com/swellstores/easypost_app) (MIT, see `LICENSE`). Needs the [Swell CLI](https://developers.swell.is/cli) (`swell login`) and Node 20+.

```bash
git clone https://github.com/swellstores/easypost_app && cd easypost_app
npm install
swell app dev          # run functions locally against the test environment
npm test               # vitest: unit tests + read-only integration tests
npm run typecheck
swell app push         # deploy to the store's test environment
swell inspect functions --app=.
swell inspect extensions app.easypost.easypost   # checkout rates activation
swell logs --type function -s EasyPost
```

- **Unit tests** (`test/unit/`) mock Swell and the EasyPost API (`fetch`) and cover every function and the shared libraries.
- **Integration tests** (`test/integration/`) are read-only and use your `swell login` session against the test store. They check the store weight unit, the app settings and the tracking query.
- **Test keys:** with an `EZTK…` key, EasyPost returns test rates and free sample labels. Tracking codes like `EZ1000000001` (pre-transit) to `EZ4000000004` (delivered) simulate tracker statuses.
- **Extension activation:** `swell app push` doesn't turn on checkout rates. `swell inspect extensions app.easypost.easypost` shows `not activated` until a merchant turns on EasyPost in Settings → Shipping and saves.
- **Actions:** `test-connection`, `refresh-tracking-now`, `buy-label` and `void-label` are action functions (`action: true`). They can only be run from the dashboard, not with `swell api`.
- **Schema validation:** in Swell CLI 2.9.19, `swell schema <type> <file>` fails on every file with `no schema with key or ref "https://json-schema.org/draft/2020-12/schema"`. The manifests were checked against the CLI's bundled schemas (`swell schema <type> --format=json-schema-bundle`) with Ajv's 2020-12 validator, and the platform validates everything again on `swell app push`. Content fields don't accept `float`; use `number`.
- **Webhook URL:** the webhook only responds after `swell app push`; under `swell app dev` it isn't reachable publicly.
- **Webhook signature:** the signature is checked against `req.rawBody`. Swell keeps the exact text only for calls through the storefront gateway (the `{store-id}.swell.store` webhook URL). `swell api post '/functions/easypost/easypost-webhook'` re-serializes the body, so signed test calls must go to the webhook URL itself.

Listing assets: `assets/icon.png` is the EasyPost hexagon mark (512×512, EasyPost blue `#164DFF` on white), rendered from the official vector icon on docs.easypost.com. `images` in `swell.json` points at four 3200×1800 App Store images in `assets/screenshots/`: `1-settings.png` (API key and ship-from address), `2-shipping.png` (turning on EasyPost in Settings → Shipping), `3-orders.png` (the EasyPost status column in the order list) and `4-order.png` (the EasyPost tab of a delivered order).
