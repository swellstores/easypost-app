import { afterEach, describe, expect, it, vi } from "vitest";
import buyLabel, { config as buyLabelConfig } from "../../functions/buy-label";
import refreshNow, { config as refreshNowConfig } from "../../functions/refresh-tracking-now";
import testConnection, { config as testConnectionConfig } from "../../functions/test-connection";
import voidLabel, { config as voidLabelConfig } from "../../functions/void-label";
import { createMockRequest } from "../helpers/mock-request";
import { SETTINGS, jsonResponse, makeBoughtShipment, makeOrder, makeRate, mockEasyPost, routeGet } from "../helpers/fixtures";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const ORDER_ID = "64f0c0ffee0000000000aaaa";

function request(settings: Record<string, any>, swell: Record<string, any> = {}, data: Record<string, any> = {}) {
  return createMockRequest({
    appId: "easypost",
    data,
    swell: { settings: vi.fn().mockResolvedValue({ easypost: settings }), ...swell },
  });
}

function quiet() {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
}

describe("action configs", () => {
  it("are dashboard actions", () => {
    for (const config of [buyLabelConfig, voidLabelConfig, testConnectionConfig, refreshNowConfig]) {
      expect(config.action).toBe(true);
    }
  });
});

describe("test-connection", () => {
  it("lists carrier accounts for a production key", async () => {
    mockEasyPost({
      "GET /shipments": { shipments: [] },
      "GET /carrier_accounts": [{ readable: "USPS", type: "UspsAccount" }, { type: "UpsAccount" }, { readable: "USPS" }],
    });

    expect(await testConnection(request({ ...SETTINGS, api_key: "EZAKlive" }))).toEqual({
      message: "Connected to EasyPost (production key). Carrier accounts: USPS, UpsAccount.",
    });
  });

  it("skips carrier accounts for a test key and points out missing setup", async () => {
    const { calls } = mockEasyPost({ "GET /shipments": { shipments: [] } });
    const { message } = await testConnection(request({ api_key: "EZTK1", from_street1: "" }));

    expect(calls).toHaveLength(1);
    expect(message).toContain("Connected to EasyPost (test key).");
    expect(message).toContain("Fill in the ship-from address");
    expect(message).toContain("Set a webhook secret to accept only signed EasyPost events.");
  });

  it("flags no carrier accounts or a failed listing", async () => {
    mockEasyPost({ "GET /shipments": {}, "GET /carrier_accounts": [] });
    expect((await testConnection(request({ ...SETTINGS, api_key: "EZAK1" }))).message).toContain(
      "Carrier accounts: none. Add a carrier account in EasyPost",
    );

    mockEasyPost({ "GET /shipments": {}, "GET /carrier_accounts": jsonResponse({ error: { message: "Forbidden" } }, 403) });
    expect((await testConnection(request({ ...SETTINGS, api_key: "EZAK1" }))).message).toContain(
      "Could not list carrier accounts (EasyPost 403: Forbidden).",
    );
  });

  it("reports a rejected key and asks for a key first", async () => {
    mockEasyPost({ "GET /shipments": jsonResponse({ error: { message: "Unauthorized" } }, 401) });
    expect(await testConnection(request(SETTINGS))).toEqual({ message: "EasyPost rejected the request: EasyPost 401: Unauthorized" });
    expect((await testConnection(request({}))).message).toMatch(/Add your EasyPost API key/);
  });
});

describe("buy-label", () => {
  function buyRequest(settings: Record<string, any>, order: unknown, recordId: unknown = ORDER_ID) {
    return request(
      settings,
      {
        get: routeGet({ [`/orders/${ORDER_ID}`]: order, "/settings/shipments": { weight_unit: "lb" } }),
        put: vi.fn().mockResolvedValue({}),
        post: vi.fn().mockResolvedValue({ id: "sw_ship_1" }),
      },
      { $action: { id: "buy_label", source: "record", collection: "orders", record_id: recordId } },
    );
  }

  it("buys the label", async () => {
    quiet();
    mockEasyPost({ "POST /shipments": { id: "shp_1", rates: [makeRate({ service: "GroundAdvantage" })] }, "POST /shipments/shp_1/buy": makeBoughtShipment({ selected_rate: makeRate({ service: "GroundAdvantage" }) }) });
    expect(await buyLabel(buyRequest({ ...SETTINGS, label_service: "cheapest" }, makeOrder()))).toEqual({
      message: "Bought a USPS Ground Advantage label. Tracking number 9400100000000000000000.",
    });
  });

  it("says pending when there is no tracking number yet", async () => {
    quiet();
    mockEasyPost({ "POST /shipments": { id: "shp_1", rates: [makeRate()] }, "POST /shipments/shp_1/buy": makeBoughtShipment({ tracking_code: null }) });
    expect((await buyLabel(buyRequest(SETTINGS, makeOrder()))).message).toBe("Bought a USPS Priority label. Tracking number pending.");
  });

  it("explains why no label was bought", async () => {
    mockEasyPost({});
    expect(await buyLabel(buyRequest(SETTINGS, makeOrder({ canceled: true })))).toEqual({ message: "No label bought: Order is canceled." });
  });

  it("reports EasyPost outages", async () => {
    quiet();
    mockEasyPost({ "POST /shipments": jsonResponse({ error: { message: "down" } }, 503) });
    expect(await buyLabel(buyRequest(SETTINGS, makeOrder()))).toEqual({ message: "No label bought: EasyPost 503: down" });

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue("offline"));
    expect(await buyLabel(buyRequest(SETTINGS, makeOrder()))).toEqual({ message: "No label bought: offline" });
  });

  it("validates the record id and the key", async () => {
    expect((await buyLabel(buyRequest(SETTINGS, null, "../settings"))).message).toBe("Open an order to buy its label.");
    expect((await buyLabel(buyRequest(SETTINGS, null, null))).message).toBe("Open an order to buy its label.");
    expect((await buyLabel(buyRequest({}, null))).message).toMatch(/Add your EasyPost API key/);
  });
});

describe("void-label", () => {
  function voidRequest(settings: Record<string, any>, order: unknown, recordId: unknown = ORDER_ID) {
    return request(
      settings,
      { get: vi.fn().mockResolvedValue(order), put: vi.fn().mockResolvedValue({}) },
      { $action: { id: "void_label", source: "record", collection: "orders", record_id: recordId } },
    );
  }

  it("voids the label", async () => {
    quiet();
    mockEasyPost({ "POST /shipments/shp_1/refund": { refund_status: "submitted" } });
    const order = makeOrder({ $app: { easypost: { easypost_status: "label_purchased", easypost_shipment_id: "shp_1" } } });
    expect(await voidLabel(voidRequest(SETTINGS, order))).toEqual({
      message: "Label voided. Refund submitted; the Swell shipment was canceled and a new label can be bought.",
    });
  });

  it("explains why it wasn't voided", async () => {
    expect(await voidLabel(voidRequest(SETTINGS, makeOrder()))).toEqual({
      message: "Not voided: The order has no EasyPost label to void.",
    });
  });

  it("validates the record id and the key", async () => {
    expect((await voidLabel(voidRequest(SETTINGS, null, "x"))).message).toBe("Open an order to void its label.");
    expect((await voidLabel(voidRequest({}, null))).message).toMatch(/Add your EasyPost API key/);
  });
});

describe("refresh-tracking-now", () => {
  it("summarizes the refresh", async () => {
    quiet();
    mockEasyPost({
      "GET /trackers/trk_1": { id: "trk_1", status: "in_transit" },
      "GET /trackers/trk_2": jsonResponse({ error: { message: "gone" } }, 404),
    });
    const orders = ["trk_1", "trk_2"].map((id, i) => makeOrder({ id: `o${i}`, $app: { easypost: { easypost_tracker_id: id } } }));
    const req = request(SETTINGS, { get: vi.fn().mockResolvedValue({ results: orders, count: 30 }), put: vi.fn().mockResolvedValue({}) });

    expect(await refreshNow(req)).toEqual({
      message:
        "Checked 2 labels, 1 updated, 1 with errors (see the function logs). More labels are waiting; run it again or wait for the next hourly refresh.",
    });
  });

  it("uses the singular for one label", async () => {
    mockEasyPost({ "GET /trackers/trk_1": { id: "trk_1", status: "in_transit" } });
    const order = makeOrder({ $app: { easypost: { easypost_tracker_id: "trk_1" } } });
    const req = request(SETTINGS, { get: vi.fn().mockResolvedValue({ results: [order], count: 1 }), put: vi.fn().mockResolvedValue({}) });
    expect(await refreshNow(req)).toEqual({ message: "Checked 1 label, 1 updated." });
  });

  it("says when nothing is in transit and asks for a key first", async () => {
    const req = request(SETTINGS, { get: vi.fn().mockResolvedValue({ results: [], count: 0 }) });
    expect(await refreshNow(req)).toEqual({ message: "No EasyPost labels are waiting for delivery." });
    expect((await refreshNow(request({}))).message).toMatch(/Add your EasyPost API key/);
  });
});
