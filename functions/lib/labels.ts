import {
  BUY_TIMEOUT_MS,
  CREATE_TIMEOUT_MS,
  EasyPostError,
  EasyPostSettings,
  buildShipment,
  buyShipment,
  carrierId,
  chooseLabelRate,
  createShipment,
  getAppData,
  getShipment,
  getTracker,
  getWeightUnit,
  humanizeService,
  labelUrl,
  rateMessages,
  refundShipment,
  shippableItems,
} from './easypost';

export const STATUS_LABEL_PURCHASED = 'label_purchased';
// a label was bought, but the order's items were already shipped by another shipment
export const STATUS_SHIPPED_ELSEWHERE = 'shipped_elsewhere';
export const STATUS_VOIDED = 'voided';
export const STATUS_ERROR = 'error';
// statuses with a bought label: voidable, tracked, no second label
export const LABEL_STATUSES = [STATUS_LABEL_PURCHASED, STATUS_SHIPPED_ELSEWHERE];

export const ALREADY_BUYING_REASON = 'A label is already being bought for this order';

export const NOTHING_LEFT_REASON =
  "Nothing left to ship: the order's items were already shipped by another shipment, or refunded or canceled";

// tracker statuses after which a parcel is no longer refreshed
export const FINAL_TRACKING_STATUSES = ['delivered', 'return_to_sender', 'failure', 'cancelled', 'error'];
// labels bought longer ago than this are no longer refreshed
export const MAX_TRACKING_AGE_DAYS = 60;
// orders refreshed per pass; one EasyPost request each
export const DEFAULT_BATCH_SIZE = 20;
// stop starting new orders after this, to stay inside the 10s function limit
export const DEFAULT_BUDGET_MS = 6000;

export interface BuyResult {
  bought: boolean;
  reason?: string;
  // a parallel run's label is kept on the order, so this one is extra
  extra_label?: boolean;
  carrier?: string;
  service?: string;
  tracking_code?: string;
}

export interface LabelDetails {
  shipment_id: string;
  tracking_code?: string;
  carrier?: string;
  service?: string;
  tracking_url?: string;
}

// the order's items left to ship
function deliverableItems(order: any) {
  return (order.items || [])
    .filter((item: any) => item.delivery === 'shipment' && item.quantity_shipment_deliverable > 0)
    .map((item: any) => ({
      order_item_id: item.id,
      product_id: item.product_id,
      variant_id: item.variant_id,
      quantity: item.quantity_shipment_deliverable,
    }));
}

// Active Swell shipments of the order with this tracking code, oldest first
async function findShipmentsByTracking(swell: SwellAPI, orderId: string, trackingCode?: string): Promise<any[]> {
  if (!trackingCode) return [];
  const result: any = await swell.get('/shipments', {
    where: { order_id: orderId, tracking_code: trackingCode, canceled: { $ne: true } },
    limit: 25,
  });
  return (result?.results || []).sort(
    (a: any, b: any) => String(a.date_created).localeCompare(String(b.date_created)) || String(a.id).localeCompare(String(b.id)),
  );
}

// the order's items were shipped elsewhere, refunded or canceled; the message is the reason
export class ItemsAlreadyShipped extends Error {}

// shipments locked or items reserved by another write; buying again reuses the label and retries the shipment
export class ShipmentPending extends Error {}

export function itemsShippedNote(reason: string): string {
  return `Label bought, but no Swell shipment was created: the order's items were already shipped by another shipment, or refunded or canceled (${reason}). Void the label if it isn't needed.`;
}

export function extraLabelNote(label: LabelDetails): string {
  return `A second label was bought at the same time by another run and isn't used (EasyPost shipment ${label.shipment_id}, tracking ${label.tracking_code || 'none'}). Void it in EasyPost.`;
}

// errors of a write Swell refused, from the SwellError's body
function validationErrors(err: any): Record<string, any> | undefined {
  if (!(err?.status >= 400 && err.status < 500)) return undefined;
  const errors = err.body?.errors ?? err.body;
  return errors && typeof errors === 'object' ? errors : undefined;
}

// Swell's "Cannot ship …" reason when $validate_items refused the items
function itemsRefusal(errors: Record<string, any>): string | undefined {
  const message = errors.items?.message;
  return typeof message === 'string' && /^Cannot ship /.test(message) ? message : undefined;
}

// Swell's { field: { message } } errors as one line
function errorText(errors: Record<string, any>): string {
  return Object.entries(errors)
    .map(([field, error]) => `${field}: ${error?.message || error}`)
    .join('; ');
}

// whether the order's saved shipments (not reservations) still leave every requested item to ship
async function stillDeliverable(swell: SwellAPI, orderId: string, requested: { order_item_id: string; quantity: number }[]) {
  const order: any = await swell.get(`/orders/${orderId}`);
  const left = new Map<string, number>((order?.items || []).map((item: any) => [String(item.id), Number(item.quantity_shipment_deliverable) || 0]));
  return requested.every((item) => (left.get(String(item.order_item_id)) || 0) >= item.quantity);
}

const pending = (order: any, reason: string) =>
  new ShipmentPending(
    `The label was bought, but Swell couldn't create the shipment for order ${order.number} yet (${reason}). Buy the label again to finish; the bought label is reused.`,
  );

// Swell shipment for everything left to ship; reuses one with the label's tracking code
export async function createSwellShipment(swell: SwellAPI, order: any, label: LabelDetails): Promise<string> {
  const [existing] = await findShipmentsByTracking(swell, order.id, label.tracking_code);
  if (existing) {
    console.log(`EasyPost: order ${order.number} already has shipment ${existing.id} for ${label.tracking_code}`);
    return existing.id;
  }

  const items = deliverableItems(order);
  // same as Swell refusing the items below
  if (!items.length) {
    console.log(`EasyPost: order ${order.number} has nothing left to ship`);
    throw new ItemsAlreadyShipped('nothing left to ship');
  }

  const shipping = order.shipping || {};
  const serviceLabel = humanizeService(label.service) || undefined;
  let shipment: any;
  try {
    shipment = await swell.post('/shipments', {
      order_id: order.id,
      items,
      destination: {
        name: shipping.name,
        first_name: shipping.first_name,
        last_name: shipping.last_name,
        address1: shipping.address1,
        address2: shipping.address2,
        city: shipping.city,
        state: shipping.state,
        zip: shipping.zip,
        country: shipping.country,
        phone: shipping.phone,
      },
      carrier: carrierId(label.carrier),
      carrier_name: label.carrier,
      // the dashboard shows `service` in the shipment dialog, so use the readable name
      service: serviceLabel,
      service_name: serviceLabel,
      tracking_code: label.tracking_code,
      notes: `EasyPost label ${label.shipment_id}${label.tracking_url ? `: ${label.tracking_url}` : ''}`,
      // Swell refuses items the order has no longer left to ship, so they can't be shipped twice
      $validate_items: true,
    });
  } catch (err) {
    // a refused write throws a SwellError with the errors in `body`
    const errors = validationErrors(err);
    // shipments locked by another write
    if (errors?.order_id) throw pending(order, errorText(errors));
    const refused = errors && itemsRefusal(errors);
    if (!refused) throw err;
    // a parallel run for this label shipped the items: use its shipment
    const [copy] = await findShipmentsByTracking(swell, order.id, label.tracking_code);
    if (copy) {
      console.log(`EasyPost: order ${order.number} was shipped meanwhile; keeps shipment ${copy.id}`);
      return copy.id;
    }
    // saved shipments still leave every item: Swell counted a reservation of a write in progress
    if (await stillDeliverable(swell, order.id, items)) throw pending(order, refused);
    // shipped elsewhere or refunded: the label is kept without a shipment
    console.warn(`EasyPost: Swell refused the shipment for order ${order.number}: ${refused}`);
    throw new ItemsAlreadyShipped(refused);
  }

  console.log(`EasyPost: created shipment ${shipment.id} for order ${order.number}`);

  const copies = await findShipmentsByTracking(swell, order.id, label.tracking_code);
  const oldest = copies[0];
  if (oldest && oldest.id !== shipment.id) {
    await swell.put(`/shipments/${shipment.id}`, { canceled: true });
    console.log(`EasyPost: canceled duplicate shipment ${shipment.id}; order ${order.number} keeps ${oldest.id}`);
    return oldest.id;
  }
  return shipment.id;
}

// The order's last EasyPost shipment, when it was bought and not refunded since
// (a voided label's shipment has a refund_status, so it is never reused)
export async function findBoughtShipment(settings: EasyPostSettings, appData: Record<string, any>): Promise<any | null> {
  if (!appData.easypost_shipment_id) {
    return null;
  }
  try {
    const shipment = await getShipment(settings, appData.easypost_shipment_id);
    const refunded = shipment?.refund_status && shipment.refund_status !== 'rejected';
    return shipment?.postage_label && !refunded ? shipment : null;
  } catch (err: any) {
    // only a 404 means no label; other errors are rethrown so a bought label isn't bought again
    if (err instanceof EasyPostError && err.status === 404) return null;
    throw err;
  }
}

// how long an unbought shipment on the order counts as another run still buying
export const BUYING_WINDOW_MS = 2 * 60 * 1000;

// another run saved its shipment and is still buying (a crashed run stops counting after BUYING_WINDOW_MS)
async function buyingElsewhere(settings: EasyPostSettings, appData: Record<string, any>): Promise<boolean> {
  if (!appData.easypost_shipment_id || appData.easypost_status) return false;
  try {
    const shipment = await getShipment(settings, appData.easypost_shipment_id);
    const created = Date.parse(shipment?.created_at);
    return !shipment?.postage_label && Number.isFinite(created) && Date.now() - created < BUYING_WINDOW_MS;
  } catch (err: any) {
    if (err instanceof EasyPostError && err.status === 404) return false;
    throw err;
  }
}

// Buys an EasyPost label for one Swell order and fulfills it. Errors are saved on the order;
// EasyPost 5xx and network errors are rethrown so model events retry them.
export async function buyLabel(req: SwellRequest, orderId: string, settings: EasyPostSettings): Promise<BuyResult> {
  const { swell, appId } = req;

  const order = await swell.get(`/orders/${orderId}`, {
    expand: ['account', 'items.product', 'items.variant'],
  });

  if (!order) {
    return { bought: false, reason: 'Order not found' };
  }

  const appData = getAppData(order, appId);

  if (LABEL_STATUSES.includes(appData.easypost_status)) {
    return { bought: false, tracking_code: appData.easypost_tracking_code, reason: 'A label was already bought' };
  }

  if (order.canceled) {
    return { bought: false, reason: 'Order is canceled' };
  }

  if (!shippableItems(order).length) {
    return { bought: false, reason: 'Order has no items to ship' };
  }

  const fail = async (reason: string): Promise<BuyResult> => {
    await swell.put(`/orders/${orderId}`, req.appValues({ easypost_status: STATUS_ERROR, easypost_error: reason }));
    return { bought: false, reason };
  };

  if (!order.shipping?.country) {
    return fail('Missing shipping address');
  }

  try {
    // a previous run may have bought the label but timed out before saving it
    let bought = await findBoughtShipment(settings, appData);
    let selected: any = bought?.selected_rate;

    if (!bought && (await buyingElsewhere(settings, appData))) {
      return { bought: false, reason: ALREADY_BUYING_REASON };
    }

    // With fulfillment on, don't buy a label for an order with nothing left to ship (with it off, the merchant may
    // have shipped it in Swell first)
    if (!bought && settings.create_fulfillment !== false && !deliverableItems(order).length) {
      return { bought: false, reason: NOTHING_LEFT_REASON };
    }

    if (!bought) {
      const weightUnit = await getWeightUnit(swell);
      const body = buildShipment(order, settings, weightUnit, {
        reference: String(order.number || order.id),
        customs: true,
        labelFormat: settings.label_format || 'PDF',
        appId,
      });

      if (!body) {
        return fail('Fill in the ship-from address in the app settings');
      }

      const shipment = await createShipment(settings, body, CREATE_TIMEOUT_MS);
      const choice = chooseLabelRate(shipment?.rates || [], order, settings);

      if (!choice.rate) {
        const messages = rateMessages(shipment);
        return fail([choice.reason, ...messages].filter(Boolean).join('. '));
      }

      // another run may have started buying since the order was loaded: don't pay for a second label
      const current = getAppData(await swell.get(`/orders/${orderId}`), appId);
      if (
        LABEL_STATUSES.includes(current.easypost_status) ||
        (current.easypost_shipment_id || null) !== (appData.easypost_shipment_id || null)
      ) {
        return { bought: false, reason: ALREADY_BUYING_REASON };
      }

      // remember the shipment before buying, so a retry can find a label bought by this run
      await swell.put(`/orders/${orderId}`, req.appValues({ easypost_shipment_id: shipment.id }));

      bought = await buyShipment(settings, shipment.id, choice.rate.id, BUY_TIMEOUT_MS);
      selected = bought?.selected_rate || choice.rate;
    }

    const label: LabelDetails = {
      shipment_id: bought.id,
      tracking_code: bought.tracking_code || undefined,
      carrier: selected?.carrier,
      service: selected?.service,
      tracking_url: bought.tracker?.public_url || undefined,
    };

    const values: Record<string, any> = {
      easypost_status: STATUS_LABEL_PURCHASED,
      easypost_shipment_id: label.shipment_id,
      easypost_tracker_id: bought.tracker?.id || null,
      easypost_tracking_code: label.tracking_code || null,
      easypost_tracking_url: label.tracking_url || null,
      easypost_label_url: labelUrl(bought.postage_label, settings.label_format || 'PDF') || null,
      easypost_carrier: label.carrier || null,
      easypost_service: label.service || null,
      easypost_label_cost: Number(selected?.rate) || null,
      easypost_label_currency: selected?.currency || null,
      easypost_label_date: bought.postage_label?.label_date || new Date().toISOString(),
      easypost_tracking_status: bought.tracker?.status || null,
      easypost_refund_status: null,
      easypost_error: null,
      easypost_note: null,
    };

    if (settings.create_fulfillment !== false) {
      try {
        values.easypost_swell_shipment_id = await createSwellShipment(swell, order, label);
      } catch (err) {
        if (!(err instanceof ItemsAlreadyShipped)) throw err;
        // a parallel run shipped the order with its own label: keep it, note this one as extra
        const current = getAppData(await swell.get(`/orders/${orderId}`), appId);
        if (current.easypost_swell_shipment_id && current.easypost_shipment_id !== label.shipment_id) {
          const reason = extraLabelNote(label);
          console.warn(`EasyPost: order ${order.number} - ${reason}`);
          await swell.put(`/orders/${orderId}`, req.appValues({ easypost_note: reason }));
          return { bought: false, extra_label: true, reason };
        }
        values.easypost_status = STATUS_SHIPPED_ELSEWHERE;
        values.easypost_note = itemsShippedNote(err.message);
      }
    }

    await swell.put(`/orders/${orderId}`, req.appValues(values));
    console.log(`EasyPost: bought ${label.carrier} ${label.service} label ${label.tracking_code} for order ${order.number}`);

    return { bought: true, carrier: label.carrier, service: label.service, tracking_code: label.tracking_code };
  } catch (err: any) {
    const message = err?.message || String(err);
    console.error(`EasyPost: failed to buy a label for order ${order.number} - ${message}`);
    await swell.put(`/orders/${orderId}`, req.appValues({ easypost_status: STATUS_ERROR, easypost_error: message }));

    // 4xx means the order data or the key is wrong; retrying won't help
    if (err instanceof EasyPostError && err.status < 500) {
      return { bought: false, reason: message };
    }
    throw err;
  }
}

export interface VoidResult {
  voided: boolean;
  refund_status?: string;
  shipment_canceled?: boolean;
  reason?: string;
}

// Asks EasyPost to refund the label, cancels its Swell shipment and lets a new label be bought
export async function voidLabel(req: SwellRequest, orderId: string, settings: EasyPostSettings): Promise<VoidResult> {
  const { swell, appId } = req;
  const order = await swell.get(`/orders/${orderId}`);

  if (!order) {
    return { voided: false, reason: 'Order not found' };
  }

  const appData = getAppData(order, appId);
  if (!LABEL_STATUSES.includes(appData.easypost_status) || !appData.easypost_shipment_id) {
    return { voided: false, reason: 'The order has no EasyPost label to void' };
  }

  let refunded: any;
  try {
    refunded = await refundShipment(settings, appData.easypost_shipment_id);
  } catch (err: any) {
    return { voided: false, reason: err?.message || String(err) };
  }

  const refundStatus = refunded?.refund_status || 'submitted';
  if (refundStatus === 'rejected') {
    await swell.put(`/orders/${orderId}`, req.appValues({ easypost_refund_status: refundStatus }));
    return { voided: false, refund_status: refundStatus, reason: 'The carrier rejected the refund' };
  }

  const shipmentCanceled = Boolean(appData.easypost_swell_shipment_id);
  if (shipmentCanceled) {
    await swell.put(`/shipments/${appData.easypost_swell_shipment_id}`, { canceled: true });
    console.log(`EasyPost: canceled shipment ${appData.easypost_swell_shipment_id} for order ${order.number}`);
  }

  await swell.put(
    `/orders/${orderId}`,
    req.appValues({
      easypost_status: STATUS_VOIDED,
      easypost_refund_status: refundStatus,
      easypost_swell_shipment_id: null,
      easypost_tracking_status: null,
      easypost_tracking_details: null,
      easypost_tracking_date: null,
      easypost_eta: null,
      easypost_error: null,
      easypost_note: null,
    }),
  );

  return { voided: true, refund_status: refundStatus, shipment_canceled: shipmentCanceled };
}

async function findOrderByAppField(req: SwellRequest, field: string, value: string): Promise<any | null> {
  const result = await req.swell.get('/orders', {
    where: { [`$app.${req.appId}.${field}`]: value },
    limit: 1,
  });
  return result?.results?.[0] || null;
}

function latestDetail(tracker: any): any {
  const details = Array.isArray(tracker?.tracking_details) ? tracker.tracking_details : [];
  return details[details.length - 1];
}

// tracker values to save on the order
export function trackerValues(tracker: any, now = new Date().toISOString()): Record<string, any> {
  const detail = latestDetail(tracker);
  const location = detail?.tracking_location;
  const where = [location?.city, location?.state, location?.country].filter(Boolean).join(', ');

  return {
    easypost_tracking_status: tracker.status || null,
    easypost_tracking_details:
      [detail?.message || tracker.status_detail, where].filter(Boolean).join(' – ') || null,
    easypost_tracking_date: tracker.updated_at || detail?.datetime || null,
    easypost_eta: tracker.est_delivery_date || null,
    ...(tracker.public_url && { easypost_tracking_url: tracker.public_url }),
    easypost_checked_at: now,
  };
}

// Saves the tracker's status on the order with this tracker (or tracking code)
export async function applyTracker(req: SwellRequest, tracker: any, order?: any): Promise<boolean> {
  if (!tracker?.status) {
    return false;
  }

  const target =
    order ||
    (tracker.id && (await findOrderByAppField(req, 'easypost_tracker_id', tracker.id))) ||
    (tracker.tracking_code && (await findOrderByAppField(req, 'easypost_tracking_code', tracker.tracking_code)));
  if (!target) {
    return false;
  }

  const appData = getAppData(target, req.appId);

  // a reused tracking code on another shipment is not this order's parcel
  if (tracker.shipment_id && appData.easypost_shipment_id && tracker.shipment_id !== appData.easypost_shipment_id) {
    return false;
  }

  // updates can arrive out of order; keep the newest
  const updatedAt = tracker.updated_at;
  if (updatedAt && appData.easypost_tracking_date && Date.parse(updatedAt) < Date.parse(appData.easypost_tracking_date)) {
    return false;
  }

  await req.swell.put(`/orders/${target.id}`, req.appValues(trackerValues(tracker)));
  return true;
}

// Orders with a label still in transit, least recently refreshed first
export async function getTrackingOrders(req: SwellRequest, limit: number): Promise<{ results: any[]; count: number }> {
  const prefix = `$app.${req.appId}`;
  const cutoff = new Date(Date.now() - MAX_TRACKING_AGE_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const result = await req.swell.get('/orders', {
    where: {
      [`${prefix}.easypost_status`]: { $in: LABEL_STATUSES },
      [`${prefix}.easypost_tracker_id`]: { $ne: null },
      [`${prefix}.easypost_tracking_status`]: { $nin: FINAL_TRACKING_STATUSES },
      // labels bought before easypost_label_date was saved fall back to the order date
      $or: [
        { [`${prefix}.easypost_label_date`]: { $gte: cutoff } },
        { [`${prefix}.easypost_label_date`]: null, date_created: { $gte: cutoff } },
      ],
    },
    sort: `${prefix}.easypost_checked_at asc`,
    limit,
  });

  return { results: result?.results || [], count: result?.count || 0 };
}

export interface RefreshSummary {
  checked: number;
  updated: number;
  errors: number;
  remaining: boolean;
}

export async function refreshTracking(
  req: SwellRequest,
  settings: EasyPostSettings,
  { limit = DEFAULT_BATCH_SIZE, budgetMs = DEFAULT_BUDGET_MS } = {},
): Promise<RefreshSummary> {
  const started = Date.now();
  const { results, count } = await getTrackingOrders(req, limit);
  const summary: RefreshSummary = { checked: 0, updated: 0, errors: 0, remaining: count > results.length };

  for (const order of results) {
    if (Date.now() - started > budgetMs) {
      summary.remaining = true;
      break;
    }

    const appData = getAppData(order, req.appId);
    summary.checked++;
    try {
      const tracker = await getTracker(settings, appData.easypost_tracker_id);
      if (await applyTracker(req, tracker, order)) {
        summary.updated++;
      } else {
        await req.swell.put(`/orders/${order.id}`, req.appValues({ easypost_checked_at: new Date().toISOString() }));
      }
    } catch (err: any) {
      summary.errors++;
      console.error(`EasyPost: failed to refresh tracking for order ${order.number} - ${err?.message || err}`);
      await req.swell.put(`/orders/${order.id}`, req.appValues({ easypost_checked_at: new Date().toISOString() }));
    }
  }

  return summary;
}
