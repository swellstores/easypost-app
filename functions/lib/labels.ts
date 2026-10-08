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
export const STATUS_VOIDED = 'voided';
export const STATUS_ERROR = 'error';

// tracker statuses after which a parcel is no longer refreshed
export const FINAL_TRACKING_STATUSES = ['delivered', 'return_to_sender', 'failure', 'cancelled', 'error'];
// labels on orders older than this are no longer refreshed
export const MAX_TRACKING_AGE_DAYS = 60;
// orders refreshed per pass; one EasyPost request each
export const DEFAULT_BATCH_SIZE = 20;
// stop starting new orders after this, to stay inside the 10s function limit
export const DEFAULT_BUDGET_MS = 6000;

export interface BuyResult {
  bought: boolean;
  reason?: string;
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

// Swell shipment for everything still to be shipped on the order
export async function createSwellShipment(swell: SwellAPI, order: any, label: LabelDetails): Promise<string | null> {
  const items = (order.items || [])
    .filter((item: any) => item.delivery === 'shipment' && item.quantity_shipment_deliverable > 0)
    .map((item: any) => ({
      order_item_id: item.id,
      product_id: item.product_id,
      variant_id: item.variant_id,
      quantity: item.quantity_shipment_deliverable,
    }));

  if (!items.length) {
    console.log(`EasyPost: order ${order.number} has nothing left to ship`);
    return null;
  }

  const shipping = order.shipping || {};
  const serviceLabel = humanizeService(label.service) || undefined;
  const shipment = await swell.post('/shipments', {
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
  });

  console.log(`EasyPost: created shipment ${shipment.id} for order ${order.number}`);
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
    console.warn(`EasyPost: could not load shipment ${appData.easypost_shipment_id} - ${err?.message || err}`);
    return null;
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

  if (appData.easypost_status === STATUS_LABEL_PURCHASED) {
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

    if (!bought) {
      const weightUnit = await getWeightUnit(swell);
      const body = buildShipment(order, settings, weightUnit, {
        reference: String(order.number || order.id),
        customs: true,
        labelFormat: settings.label_format || 'PDF',
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
      easypost_tracking_status: bought.tracker?.status || null,
      easypost_refund_status: null,
      easypost_error: null,
    };

    if (settings.create_fulfillment !== false) {
      const swellShipmentId = await createSwellShipment(swell, order, label);
      if (swellShipmentId) {
        values.easypost_swell_shipment_id = swellShipmentId;
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
  if (appData.easypost_status !== STATUS_LABEL_PURCHASED || !appData.easypost_shipment_id) {
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

  if (appData.easypost_swell_shipment_id) {
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
    }),
  );

  return { voided: true, refund_status: refundStatus };
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
      [`${prefix}.easypost_status`]: STATUS_LABEL_PURCHASED,
      [`${prefix}.easypost_tracker_id`]: { $ne: null },
      [`${prefix}.easypost_tracking_status`]: { $nin: FINAL_TRACKING_STATUSES },
      date_created: { $gte: cutoff },
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
