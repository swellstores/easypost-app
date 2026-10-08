# EasyPost

Show live EasyPost carrier rates at checkout, buy shipping labels from your EasyPost account, and keep each order's tracking status up to date in Swell.

## How it works

1. **Rates at checkout.** When a customer enters a shipping address, the app asks EasyPost for rates from your ship-from address for one parcel (your default box, weighed from the items). Each carrier service becomes a checkout option, with an optional markup and handling fee. Swell's own shipping services stay as they are.
2. **Labels.** With **Buy EasyPost label** on the order page, or automatically when an order is paid or submitted, the app buys the service the customer chose, or the cheapest rate if that service isn't offered. International labels get a customs declaration from the order items. A label is never bought twice for the same order.
3. **Fulfillment.** After buying, the order is fulfilled with a Swell shipment, and an EasyPost tab shows the carrier, tracking number, label link and postage. **Void EasyPost label** refunds the label and cancels the shipment.
4. **Tracking.** Every hour, or as it happens with the webhook, the app saves each parcel's tracking status, latest scan and estimated delivery on the order until it's delivered.

Setup: paste your EasyPost API key and ship-from address in the app settings, choose when to buy labels, then turn on EasyPost in Settings → Shipping.
