import { afterEach, describe, expect, it, vi } from "vitest";
import handler, { config } from "../../functions/shipping-rates";
import { createMockRequest } from "../helpers/mock-request";
import { SETTINGS, SHIPPING, jsonResponse, makeRate, mockEasyPost, routeGet } from "../helpers/fixtures";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const NATIVE = { id: "standard", name: "Standard Shipping", price: 5 };

function cart(overrides: Record<string, any> = {}) {
  return {
    id: "cart_1",
    currency: "USD",
    shipping: SHIPPING,
    items: [{ id: "i1", delivery: "shipment", quantity: 1, shipment_weight: 500 }],
    shipment_rating: {
      fingerprint: "fp",
      services: [NATIVE, { id: "easypost_old", name: "Old", price: 1 }],
    },
    $event: { type: "order.shipping", hook: "after" },
    ...overrides,
  };
}

function request(settings: Record<string, any>, data: Record<string, any> = cart()) {
  return createMockRequest({
    appId: "easypost",
    data,
    swell: {
      settings: vi.fn().mockResolvedValue({ easypost: settings }),
      get: routeGet({ "/settings/shipments": { weight_unit: "g" }, "/accounts/acc_1": { email: "jane@example.com" } }),
    },
  });
}

describe("shipping-rates", () => {
  it("is bound to the easypost extension's rating hook", () => {
    expect(config).toMatchObject({
      extension: "easypost",
      model: { events: ["after:order.shipping"], fields: ["shipment_rating"] },
    });
  });

  it("adds EasyPost services and keeps the other services", async () => {
    const { calls } = mockEasyPost({
      "POST /shipments": { rates: [makeRate(), makeRate({ id: "r2", rate: "4.10", carrier: "UPS", service: "Ground" })] },
    });

    const result: any = await handler(request(SETTINGS));

    expect(calls[0].body.shipment.parcel).toEqual({ length: 10, width: 8, height: 4, weight: 17.6 });
    expect(calls[0].body.shipment.to_address.zip).toBe("94103");
    expect(calls[0].body.shipment.customs_info).toBeUndefined();
    expect(result.shipment_rating.fingerprint).toBe("fp");
    expect(result.shipment_rating.services.map((s: any) => [s.id, s.price])).toEqual([
      ["standard", 5],
      ["easypost_ups_ground", 4.1],
      ["easypost_usps_priority", 7.5],
    ]);
  });

  it("reads items and account_id from $record when the hook data has only the changed fields", async () => {
    const { calls } = mockEasyPost({ "POST /shipments": { rates: [makeRate()] } });
    const { items, ...changed } = cart();

    const result: any = await handler(
      request(SETTINGS, { ...changed, account: {}, $record: { items, account_id: "acc_1", currency: "USD" } }),
    );

    expect(calls[0].body.shipment.parcel.weight).toBe(17.6);
    expect(calls[0].body.shipment.to_address.email).toBe("jane@example.com");
    expect(result.shipment_rating.services.map((s: any) => s.id)).toEqual(["standard", "easypost_usps_priority"]);
  });

  it("works when there were no services yet", async () => {
    mockEasyPost({ "POST /shipments": { rates: [makeRate()] } });
    const result: any = await handler(request(SETTINGS, cart({ shipment_rating: undefined })));
    expect(result.shipment_rating.services.map((s: any) => s.id)).toEqual(["easypost_usps_priority"]);
  });

  it("logs carrier messages when no rates come back", async () => {
    mockEasyPost({ "POST /shipments": { rates: [], messages: [{ carrier: "UPS", message: "Invalid zip" }] } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result: any = await handler(request(SETTINGS));

    expect(warn).toHaveBeenCalledWith("EasyPost: no rates", ["UPS: Invalid zip"]);
    expect(result.shipment_rating.services).toEqual([NATIVE]);
  });

  it("warns when no rate is in the cart currency", async () => {
    mockEasyPost({ "POST /shipments": { rates: [makeRate()] } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await handler(request(SETTINGS, cart({ currency: "EUR" })));

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("none in EUR"));
  });

  it("leaves rating untouched when EasyPost fails", async () => {
    mockEasyPost({ "POST /shipments": jsonResponse({ error: { message: "Invalid key" } }, 401) });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await handler(request(SETTINGS))).toBeUndefined();
    expect(error).toHaveBeenCalledWith("EasyPost: rate request failed - EasyPost 401: Invalid key");
  });

  it("does nothing when disabled, rates are off, or the key is missing", async () => {
    const { fetchMock } = mockEasyPost({});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await handler(request({ ...SETTINGS, enabled: false }))).toBeUndefined();
    expect(await handler(request({ ...SETTINGS, rates_enabled: false }))).toBeUndefined();
    expect(await handler(request({ ...SETTINGS, api_key: "" }))).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith("EasyPost: missing API key, no rates returned");
  });

  it("does nothing until there is an address and something to ship", async () => {
    const { fetchMock } = mockEasyPost({});

    expect(await handler(request(SETTINGS, cart({ shipping: {} })))).toBeUndefined();
    expect(await handler(request(SETTINGS, cart({ items: [] })))).toBeUndefined();
    expect(await handler(request({ ...SETTINGS, from_zip: "" }))).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
