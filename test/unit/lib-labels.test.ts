import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FINAL_TRACKING_STATUSES,
  applyTracker,
  buyLabel,
  createSwellShipment,
  findBoughtShipment,
  getTrackingOrders,
  refreshTracking,
  trackerValues,
  voidLabel,
} from "../../functions/lib/labels";
import { createMockRequest } from "../helpers/mock-request";
import { SETTINGS, SHIPPING, jsonResponse, makeBoughtShipment, makeOrder, makeRate, mockEasyPost, routeGet } from "../helpers/fixtures";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const ORDER_ID = "64f0c0ffee0000000000aaaa";

function request(swell: Record<string, any>) {
  return createMockRequest({ appId: "easypost", swell });
}

function quiet() {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
}

// the values saved in the last swell.put to the order
function savedValues(put: ReturnType<typeof vi.fn>) {
  const calls = put.mock.calls.filter(([url]) => url === `/orders/${ORDER_ID}`);
  return calls[calls.length - 1]?.[1]?.$app?.easypost;
}

describe("createSwellShipment", () => {
  it("ships the deliverable items with carrier and tracking", async () => {
    quiet();
    const post = vi.fn().mockResolvedValue({ id: "sw_ship_1" });
    const order = makeOrder({ items: [...makeOrder().items, { id: "item_2", delivery: "shipment", quantity_shipment_deliverable: 0 }] });

    const id = await createSwellShipment({ post } as any, order, {
      shipment_id: "shp_1",
      tracking_code: "9400",
      carrier: "USPS",
      service: "GroundAdvantage",
      tracking_url: "https://track.easypost.com/trk_1",
    });

    expect(id).toBe("sw_ship_1");
    expect(post).toHaveBeenCalledWith("/shipments", {
      order_id: ORDER_ID,
      items: [{ order_item_id: "item_1", product_id: "prod_1", variant_id: "var_1", quantity: 2 }],
      destination: expect.objectContaining({ address1: "965 Mission St", country: "US" }),
      carrier: "usps",
      carrier_name: "USPS",
      service: "Ground Advantage",
      service_name: "Ground Advantage",
      tracking_code: "9400",
      notes: "EasyPost label shp_1: https://track.easypost.com/trk_1",
    });
  });

  it("skips orders with nothing left to ship", async () => {
    quiet();
    const post = vi.fn();
    const order = makeOrder({ items: [{ id: "i", delivery: "shipment", quantity_shipment_deliverable: 0 }], shipping: undefined });
    expect(await createSwellShipment({ post } as any, order, { shipment_id: "shp_1" })).toBeNull();
    expect(post).not.toHaveBeenCalled();
  });

  it("writes notes without a tracking page", async () => {
    quiet();
    const post = vi.fn().mockResolvedValue({ id: "s" });
    await createSwellShipment({ post } as any, makeOrder(), { shipment_id: "shp_1" });
    expect(post.mock.calls[0][1]).toMatchObject({ notes: "EasyPost label shp_1", carrier: undefined, service: undefined });
  });
});

describe("findBoughtShipment", () => {
  it("returns a bought, unrefunded shipment", async () => {
    mockEasyPost({ "GET /shipments/shp_1": makeBoughtShipment() });
    expect((await findBoughtShipment(SETTINGS, { easypost_shipment_id: "shp_1" }))?.id).toBe("shp_1");
  });

  it("ignores unbought, refunded or missing shipments", async () => {
    quiet();
    expect(await findBoughtShipment(SETTINGS, {})).toBeNull();

    mockEasyPost({ "GET /shipments/shp_1": { id: "shp_1", postage_label: null } });
    expect(await findBoughtShipment(SETTINGS, { easypost_shipment_id: "shp_1" })).toBeNull();

    mockEasyPost({ "GET /shipments/shp_1": makeBoughtShipment({ refund_status: "submitted" }) });
    expect(await findBoughtShipment(SETTINGS, { easypost_shipment_id: "shp_1" })).toBeNull();

    mockEasyPost({ "GET /shipments/shp_1": makeBoughtShipment({ refund_status: "rejected" }) });
    expect(await findBoughtShipment(SETTINGS, { easypost_shipment_id: "shp_1" })).not.toBeNull();

    mockEasyPost({});
    expect(await findBoughtShipment(SETTINGS, { easypost_shipment_id: "shp_1" })).toBeNull();
  });
});

describe("buyLabel", () => {
  function swellFor(order: unknown) {
    return {
      get: routeGet({ [`/orders/${ORDER_ID}`]: order, "/settings/shipments": { weight_unit: "lb" } }),
      put: vi.fn().mockResolvedValue({}),
      post: vi.fn().mockResolvedValue({ id: "sw_ship_1" }),
    };
  }

  it("buys the chosen service, saves the label and fulfills the order", async () => {
    quiet();
    const { calls } = mockEasyPost({
      "POST /shipments": { id: "shp_1", rates: [makeRate(), makeRate({ id: "rate_2", carrier: "UPS", service: "Ground", rate: "5.10" })] },
      "POST /shipments/shp_1/buy": makeBoughtShipment(),
    });
    const swell = swellFor(makeOrder());

    const result = await buyLabel(request(swell), ORDER_ID, SETTINGS);

    expect(result).toEqual({ bought: true, carrier: "USPS", service: "Priority", tracking_code: "9400100000000000000000" });
    expect(calls[0].body.shipment).toMatchObject({ reference: "100123", options: { label_format: "PDF" } });
    expect(calls[1].body).toEqual({ rate: { id: "rate_1" } });
    expect(swell.put).toHaveBeenCalledWith(`/orders/${ORDER_ID}`, { $app: { easypost: { easypost_shipment_id: "shp_1" } } });
    expect(savedValues(swell.put)).toEqual({
      easypost_status: "label_purchased",
      easypost_shipment_id: "shp_1",
      easypost_tracker_id: "trk_1",
      easypost_tracking_code: "9400100000000000000000",
      easypost_tracking_url: "https://track.easypost.com/trk_1",
      easypost_label_url: "https://easypost-files.s3.amazonaws.com/label.pdf",
      easypost_carrier: "USPS",
      easypost_service: "Priority",
      easypost_label_cost: 7.5,
      easypost_label_currency: "USD",
      easypost_label_date: "2026-10-02T09:00:00Z",
      easypost_tracking_status: "pre_transit",
      easypost_refund_status: null,
      easypost_error: null,
      easypost_swell_shipment_id: "sw_ship_1",
    });
  });

  it("reuses a label a timed-out run already bought", async () => {
    quiet();
    const { calls } = mockEasyPost({ "GET /shipments/shp_0": makeBoughtShipment({ id: "shp_0" }) });
    const swell = swellFor(makeOrder({ $app: { easypost: { easypost_status: "error", easypost_shipment_id: "shp_0" } } }));

    const result = await buyLabel(request(swell), ORDER_ID, { ...SETTINGS, create_fulfillment: false });

    expect(result.bought).toBe(true);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /shipments/shp_0"]);
    expect(swell.post).not.toHaveBeenCalled();
    expect(savedValues(swell.put)).toMatchObject({ easypost_status: "label_purchased", easypost_shipment_id: "shp_0" });
  });

  it("falls back to the chosen rate and nulls for a sparse buy response", async () => {
    quiet();
    mockEasyPost({
      "POST /shipments": { id: "shp_1", rates: [makeRate()] },
      "POST /shipments/shp_1/buy": { id: "shp_1" },
    });
    const swell = swellFor(makeOrder());
    swell.post.mockResolvedValue({ id: "sw_ship_1" });

    await buyLabel(request(swell), ORDER_ID, { ...SETTINGS, label_format: undefined });

    expect(savedValues(swell.put)).toMatchObject({
      easypost_carrier: "USPS",
      easypost_tracker_id: null,
      easypost_tracking_code: null,
      easypost_label_url: null,
      easypost_tracking_status: null,
    });
  });

  it("does not create a Swell shipment when nothing is left to ship", async () => {
    quiet();
    mockEasyPost({ "POST /shipments": { id: "shp_1", rates: [makeRate()] }, "POST /shipments/shp_1/buy": makeBoughtShipment() });
    const order = makeOrder({ items: [{ ...makeOrder().items[0], quantity_shipment_deliverable: 0 }] });
    const swell = swellFor(order);

    await buyLabel(request(swell), ORDER_ID, SETTINGS);

    expect(savedValues(swell.put).easypost_swell_shipment_id).toBeUndefined();
  });

  it("skips orders that already have a label, are canceled or have nothing to ship", async () => {
    const { fetchMock } = mockEasyPost({});
    const bought = makeOrder({ $app: { easypost: { easypost_status: "label_purchased", easypost_tracking_code: "T1" } } });
    expect(await buyLabel(request(swellFor(bought)), ORDER_ID, SETTINGS)).toEqual({
      bought: false,
      tracking_code: "T1",
      reason: "A label was already bought",
    });
    expect(await buyLabel(request(swellFor(makeOrder({ canceled: true }))), ORDER_ID, SETTINGS)).toEqual({
      bought: false,
      reason: "Order is canceled",
    });
    expect(await buyLabel(request(swellFor(makeOrder({ items: [] }))), ORDER_ID, SETTINGS)).toEqual({
      bought: false,
      reason: "Order has no items to ship",
    });
    expect(await buyLabel(request(swellFor(null)), ORDER_ID, SETTINGS)).toEqual({ bought: false, reason: "Order not found" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("saves an error for a missing address or ship-from address", async () => {
    mockEasyPost({});
    const noAddress = swellFor(makeOrder({ shipping: {} }));
    expect(await buyLabel(request(noAddress), ORDER_ID, SETTINGS)).toEqual({ bought: false, reason: "Missing shipping address" });
    expect(savedValues(noAddress.put)).toEqual({ easypost_status: "error", easypost_error: "Missing shipping address" });

    const noFrom = swellFor(makeOrder());
    expect((await buyLabel(request(noFrom), ORDER_ID, { ...SETTINGS, from_street1: "" })).reason).toBe(
      "Fill in the ship-from address in the app settings",
    );
  });

  it("saves the reason and carrier messages when no rate fits", async () => {
    mockEasyPost({ "POST /shipments": { id: "shp_1", rates: [], messages: [{ carrier: "UPS", message: "Invalid zip" }] } });
    const swell = swellFor(makeOrder());

    const result = await buyLabel(request(swell), ORDER_ID, SETTINGS);

    expect(result).toEqual({ bought: false, reason: "EasyPost returned no rates for this order. UPS: Invalid zip" });
    expect(savedValues(swell.put)).toMatchObject({ easypost_status: "error" });
  });

  it("returns EasyPost 4xx errors and rethrows 5xx", async () => {
    quiet();
    mockEasyPost({
      "POST /shipments": { id: "shp_1", rates: [makeRate()] },
      "POST /shipments/shp_1/buy": jsonResponse({ error: { message: "Insufficient funds" } }, 422),
    });
    const swell = swellFor(makeOrder());
    expect(await buyLabel(request(swell), ORDER_ID, SETTINGS)).toEqual({ bought: false, reason: "EasyPost 422: Insufficient funds" });
    expect(savedValues(swell.put)).toEqual({ easypost_status: "error", easypost_error: "EasyPost 422: Insufficient funds" });

    mockEasyPost({ "POST /shipments": jsonResponse({ error: { message: "down" } }, 503) });
    await expect(buyLabel(request(swellFor(makeOrder())), ORDER_ID, SETTINGS)).rejects.toMatchObject({ status: 503 });
  });

  it("rethrows non-EasyPost errors after saving them", async () => {
    quiet();
    mockEasyPost({ "POST /shipments": { id: "shp_1", rates: [makeRate()] }, "POST /shipments/shp_1/buy": makeBoughtShipment() });
    const swell = swellFor(makeOrder());
    swell.post.mockRejectedValue("swell down");
    await expect(buyLabel(request(swell), ORDER_ID, SETTINGS)).rejects.toBe("swell down");
    expect(savedValues(swell.put)).toEqual({ easypost_status: "error", easypost_error: "swell down" });
  });
});

describe("voidLabel", () => {
  const labeled = () =>
    makeOrder({
      $app: { easypost: { easypost_status: "label_purchased", easypost_shipment_id: "shp_1", easypost_swell_shipment_id: "sw_1" } },
    });

  it("refunds the label, cancels the Swell shipment and clears tracking", async () => {
    quiet();
    mockEasyPost({ "POST /shipments/shp_1/refund": { id: "shp_1", refund_status: "submitted" } });
    const put = vi.fn().mockResolvedValue({});
    const req = request({ get: vi.fn().mockResolvedValue(labeled()), put });

    expect(await voidLabel(req, ORDER_ID, SETTINGS)).toEqual({ voided: true, refund_status: "submitted", shipment_canceled: true });
    expect(put).toHaveBeenCalledWith("/shipments/sw_1", { canceled: true });
    expect(savedValues(put)).toEqual({
      easypost_status: "voided",
      easypost_refund_status: "submitted",
      easypost_swell_shipment_id: null,
      easypost_tracking_status: null,
      easypost_tracking_details: null,
      easypost_tracking_date: null,
      easypost_eta: null,
      easypost_error: null,
    });
  });

  it("works without a Swell shipment and a refund status", async () => {
    mockEasyPost({ "POST /shipments/shp_1/refund": { id: "shp_1" } });
    const order = makeOrder({ $app: { easypost: { easypost_status: "label_purchased", easypost_shipment_id: "shp_1" } } });
    const put = vi.fn().mockResolvedValue({});
    expect(await voidLabel(request({ get: vi.fn().mockResolvedValue(order), put }), ORDER_ID, SETTINGS)).toEqual({
      voided: true,
      refund_status: "submitted",
      shipment_canceled: false,
    });
    expect(put).toHaveBeenCalledTimes(1);
  });

  it("keeps the label when the carrier rejects the refund", async () => {
    mockEasyPost({ "POST /shipments/shp_1/refund": { refund_status: "rejected" } });
    const put = vi.fn().mockResolvedValue({});
    const result = await voidLabel(request({ get: vi.fn().mockResolvedValue(labeled()), put }), ORDER_ID, SETTINGS);
    expect(result).toEqual({ voided: false, refund_status: "rejected", reason: "The carrier rejected the refund" });
    expect(savedValues(put)).toEqual({ easypost_refund_status: "rejected" });
  });

  it("reports EasyPost errors and orders without a label", async () => {
    mockEasyPost({ "POST /shipments/shp_1/refund": jsonResponse({ error: { message: "Too late" } }, 422) });
    const get = vi.fn().mockResolvedValue(labeled());
    expect(await voidLabel(request({ get }), ORDER_ID, SETTINGS)).toEqual({ voided: false, reason: "EasyPost 422: Too late" });

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue("offline"));
    expect(await voidLabel(request({ get }), ORDER_ID, SETTINGS)).toEqual({ voided: false, reason: "offline" });

    expect(await voidLabel(request({ get: vi.fn().mockResolvedValue(makeOrder()) }), ORDER_ID, SETTINGS)).toEqual({
      voided: false,
      reason: "The order has no EasyPost label to void",
    });
    expect(await voidLabel(request({ get: vi.fn().mockResolvedValue(null) }), ORDER_ID, SETTINGS)).toEqual({
      voided: false,
      reason: "Order not found",
    });
  });
});

describe("tracking", () => {
  const tracker = {
    id: "trk_1",
    tracking_code: "9400",
    shipment_id: "shp_1",
    status: "in_transit",
    status_detail: "arrived_at_facility",
    updated_at: "2026-10-09T10:00:00Z",
    est_delivery_date: "2026-10-11T00:00:00Z",
    public_url: "https://track.easypost.com/trk_1",
    tracking_details: [
      { message: "Pre-shipment info sent", datetime: "2026-10-08T10:00:00Z" },
      { message: "Arrived at USPS facility", datetime: "2026-10-09T09:00:00Z", tracking_location: { city: "Oakland", state: "CA" } },
    ],
  };

  it("trackerValues takes the latest detail", () => {
    expect(trackerValues(tracker, "now")).toEqual({
      easypost_tracking_status: "in_transit",
      easypost_tracking_details: "Arrived at USPS facility – Oakland, CA",
      easypost_tracking_date: "2026-10-09T10:00:00Z",
      easypost_eta: "2026-10-11T00:00:00Z",
      easypost_tracking_url: "https://track.easypost.com/trk_1",
      easypost_checked_at: "now",
    });
    expect(trackerValues({ status: "unknown" }, "now")).toEqual({
      easypost_tracking_status: "unknown",
      easypost_tracking_details: null,
      easypost_tracking_date: null,
      easypost_eta: null,
      easypost_checked_at: "now",
    });
    expect(trackerValues({ status: "x", status_detail: "d", tracking_details: [{ datetime: "t" }] }, "now")).toMatchObject({
      easypost_tracking_details: "d",
      easypost_tracking_date: "t",
    });
    expect(trackerValues({}).easypost_tracking_status).toBeNull();
  });

  it("applyTracker finds the order by tracker id and saves the status", async () => {
    const order = makeOrder({ $app: { easypost: { easypost_tracker_id: "trk_1", easypost_shipment_id: "shp_1" } } });
    const get = vi.fn().mockResolvedValue({ results: [order] });
    const put = vi.fn().mockResolvedValue({});

    expect(await applyTracker(request({ get, put }), tracker)).toBe(true);
    expect(get).toHaveBeenCalledWith("/orders", { where: { "$app.easypost.easypost_tracker_id": "trk_1" }, limit: 1 });
    expect(savedValues(put)).toMatchObject({ easypost_tracking_status: "in_transit" });
  });

  it("applyTracker falls back to the tracking code", async () => {
    const order = makeOrder({ $app: { easypost: {} } });
    const get = vi.fn().mockResolvedValueOnce({ results: [] }).mockResolvedValueOnce({ results: [order] });
    const put = vi.fn().mockResolvedValue({});

    expect(await applyTracker(request({ get, put }), tracker)).toBe(true);
    expect(get.mock.calls[1][1]).toEqual({ where: { "$app.easypost.easypost_tracking_code": "9400" }, limit: 1 });
  });

  it("applyTracker skips other shipments, older updates and unknown orders", async () => {
    const put = vi.fn();
    const other = makeOrder({ $app: { easypost: { easypost_shipment_id: "shp_other" } } });
    expect(await applyTracker(request({ put }), tracker, other)).toBe(false);

    const newer = makeOrder({ $app: { easypost: { easypost_shipment_id: "shp_1", easypost_tracking_date: "2026-10-10T00:00:00Z" } } });
    expect(await applyTracker(request({ put }), tracker, newer)).toBe(false);

    const get = vi.fn().mockResolvedValue({ results: [] });
    expect(await applyTracker(request({ get, put }), tracker)).toBe(false);
    expect(await applyTracker(request({ get, put }), { ...tracker, id: undefined, tracking_code: undefined })).toBe(false);
    expect(await applyTracker(request({ put }), { ...tracker, status: undefined })).toBe(false);
    expect(await applyTracker(request({ put }), null)).toBe(false);
    expect(put).not.toHaveBeenCalled();
  });

  it("getTrackingOrders queries undelivered labels", async () => {
    const get = vi.fn().mockResolvedValue({ results: [{ id: "o1" }], count: 3 });
    expect(await getTrackingOrders(request({ get }), 5)).toEqual({ results: [{ id: "o1" }], count: 3 });
    expect(get).toHaveBeenCalledWith("/orders", {
      where: {
        "$app.easypost.easypost_status": "label_purchased",
        "$app.easypost.easypost_tracker_id": { $ne: null },
        "$app.easypost.easypost_tracking_status": { $nin: FINAL_TRACKING_STATUSES },
        $or: [
          { "$app.easypost.easypost_label_date": { $gte: expect.any(String) } },
          { "$app.easypost.easypost_label_date": null, date_created: { $gte: expect.any(String) } },
        ],
      },
      sort: "$app.easypost.easypost_checked_at asc",
      limit: 5,
    });
    expect(await getTrackingOrders(request({ get: vi.fn().mockResolvedValue(null) }), 5)).toEqual({ results: [], count: 0 });
  });

  it("refreshTracking updates, marks unchanged orders and counts errors", async () => {
    quiet();
    mockEasyPost({
      "GET /trackers/trk_1": tracker,
      "GET /trackers/trk_2": { ...tracker, id: "trk_2", shipment_id: "shp_other" },
      "GET /trackers/trk_3": jsonResponse({ error: { message: "gone" } }, 404),
    });
    const orders = ["trk_1", "trk_2", "trk_3"].map((id, i) =>
      makeOrder({ id: `o${i}`, number: `${i}`, $app: { easypost: { easypost_tracker_id: id, easypost_shipment_id: "shp_1" } } }),
    );
    const put = vi.fn().mockResolvedValue({});
    const req = request({ get: vi.fn().mockResolvedValue({ results: orders, count: 3 }), put });

    expect(await refreshTracking(req, SETTINGS)).toEqual({ checked: 3, updated: 1, errors: 1, remaining: false });
    expect(put.mock.calls.map(([url, body]) => [url, Object.keys(body.$app.easypost)])).toEqual([
      ["/orders/o0", expect.arrayContaining(["easypost_tracking_status", "easypost_checked_at"])],
      ["/orders/o1", ["easypost_checked_at"]],
      ["/orders/o2", ["easypost_checked_at"]],
    ]);
  });

  it("refreshTracking stops when the time budget is used", async () => {
    const orders = [makeOrder({ id: "o1" }), makeOrder({ id: "o2" })];
    const req = request({ get: vi.fn().mockResolvedValue({ results: orders, count: 2 }) });
    expect(await refreshTracking(req, SETTINGS, { budgetMs: -1 })).toEqual({ checked: 0, updated: 0, errors: 0, remaining: true });
  });
});
