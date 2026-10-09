import { afterEach, describe, expect, it, vi } from "vitest";
import handler, { config } from "../../functions/easypost-order-events";
import { createMockRequest } from "../helpers/mock-request";
import { SETTINGS, makeBoughtShipment, makeOrder, makeRate, mockEasyPost, routeGet } from "../helpers/fixtures";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const ORDER_ID = "64f0c0ffee0000000000aaaa";

function request(settings: Record<string, any>, eventType: string, order: unknown = makeOrder()) {
  const put = vi.fn().mockResolvedValue({});
  const req = createMockRequest({
    appId: "easypost",
    data: { id: ORDER_ID, number: "100123", $event: { type: eventType } },
    swell: {
      settings: vi.fn().mockResolvedValue({ easypost: settings }),
      get: routeGet({ [`/orders/${ORDER_ID}`]: order, "/settings/shipments": { weight_unit: "lb" } }),
      put,
      post: vi.fn().mockResolvedValue({ id: "sw_ship_1" }),
    },
  });
  return { req, put };
}

function mockBuy() {
  return mockEasyPost({
    "POST /shipments": { id: "shp_1", rates: [makeRate()] },
    "POST /shipments/shp_1/buy": makeBoughtShipment(),
  });
}

describe("easypost-order-events", () => {
  it("listens to submitted and paid orders", () => {
    expect(config.model?.events).toEqual(["order.submitted", "order.paid"]);
  });

  it("buys the label for paid orders", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { calls } = mockBuy();
    const { req, put } = request(SETTINGS, "order.paid");

    await handler(req);

    expect(calls.map((c) => c.path)).toEqual(["/shipments", "/shipments/shp_1/buy"]);
    expect(put.mock.calls.at(-1)[1].$app.easypost.easypost_status).toBe("label_purchased");
  });

  it("buys on submit when configured", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { calls } = mockBuy();

    await handler(request({ ...SETTINGS, buy_on: "submitted" }, "order.paid").req);
    expect(calls).toHaveLength(0);

    await handler(request({ ...SETTINGS, buy_on: "submitted" }, "order.submitted").req);
    expect(calls).toHaveLength(2);
  });

  it("ignores the other event", async () => {
    const { fetchMock } = mockEasyPost({});
    await handler(request(SETTINGS, "order.submitted").req);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does nothing when disabled, manual, unset, or the key is missing", async () => {
    const { fetchMock } = mockEasyPost({});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await handler(request({ ...SETTINGS, enabled: false }, "order.paid").req);
    await handler(request({ ...SETTINGS, buy_on: "manual" }, "order.paid").req);
    await handler(request({ ...SETTINGS, buy_on: undefined }, "order.paid").req);
    await handler(request({ ...SETTINGS, api_key: "" }, "order.paid").req);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith("EasyPost: missing API key, no label bought");
  });

  it("logs why no label was bought", async () => {
    mockEasyPost({});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { req, put } = request(SETTINGS, "order.paid", makeOrder({ canceled: true }));

    await handler(req);

    expect(log).toHaveBeenCalledWith("EasyPost: no label for order 100123 - Order is canceled");
    expect(put).not.toHaveBeenCalled();
  });
});
