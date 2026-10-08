import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EasyPostError,
  allowedServices,
  applyMarkup,
  buildCustomsInfo,
  buildParcel,
  buildShipment,
  buyShipment,
  carrierId,
  cheapestRate,
  chooseLabelRate,
  createShipment,
  deliveryDescription,
  easypostRequest,
  formatEasyPostError,
  fromAddress,
  getAccountEmail,
  getAppData,
  getEasyPostSettings,
  getShipment,
  getTracker,
  getWeightUnit,
  hasKey,
  humanizeService,
  isAllowed,
  isTestKey,
  labelUrl,
  listCarrierAccounts,
  money,
  rateMessages,
  ratePrice,
  ratesToServices,
  refundShipment,
  safeEqual,
  serviceId,
  serviceName,
  shippableItems,
  splitList,
  toAddress,
  toInches,
  toOunces,
  totalWeight,
  verifyKey,
} from "../../functions/lib/easypost";
import { SETTINGS, SHIPPING, jsonResponse, makeOrder, makeRate, mockEasyPost } from "../helpers/fixtures";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("settings and keys", () => {
  it("reads the easypost settings", async () => {
    const swell = { settings: vi.fn().mockResolvedValue({ easypost: { api_key: "k" } }) } as any;
    expect(await getEasyPostSettings(swell)).toEqual({ api_key: "k" });
    expect(await getEasyPostSettings({ settings: vi.fn().mockResolvedValue(null) } as any)).toEqual({});
  });

  it("checks the key", () => {
    expect(hasKey({ api_key: " EZAK1 " })).toBe(true);
    expect(hasKey({ api_key: "  " })).toBe(false);
    expect(hasKey({})).toBe(false);
    expect(isTestKey("EZTK123")).toBe(true);
    expect(isTestKey("EZAK123")).toBe(false);
    expect(isTestKey(undefined)).toBe(false);
  });
});

describe("formatEasyPostError", () => {
  it("joins the message and field errors", () => {
    expect(
      formatEasyPostError(
        { error: { code: "ADDRESS.VERIFY.FAILURE", message: "Unable to verify address.", errors: [{ field: "zip", message: "invalid" }, "bad street", {}] } },
        "x",
      ),
    ).toBe("Unable to verify address. (zip: invalid; bad street)");
  });

  it("falls back to the code, the text or the fallback", () => {
    expect(formatEasyPostError({ error: { code: "RATE_LIMITED" } }, "x")).toBe("RATE_LIMITED");
    expect(formatEasyPostError({ error: {} }, "fallback")).toBe("fallback");
    expect(formatEasyPostError("plain text", "x")).toBe("plain text");
    expect(formatEasyPostError(null, "fallback")).toBe("fallback");
    expect(formatEasyPostError({ error: { message: "m", errors: [{ suggestion: "try this" }] } }, "x")).toBe("m (try this)");
  });
});

describe("easypostRequest", () => {
  it("sends basic auth with the key and JSON", async () => {
    const { calls } = mockEasyPost({ "POST /shipments": { id: "shp_1" } });
    expect(await easypostRequest(SETTINGS, "POST", "/shipments", { a: 1 })).toEqual({ id: "shp_1" });
    expect(calls[0].headers.get("authorization")).toBe(`Basic ${btoa("EZTKtest123:")}`);
    expect(calls[0].headers.get("content-type")).toBe("application/json");
    expect(calls[0].body).toEqual({ a: 1 });
  });

  it("throws EasyPostError with the status and message", async () => {
    mockEasyPost({ "GET /trackers/trk_x": jsonResponse({ error: { message: "Not found" } }, 404) });
    const err = await easypostRequest(SETTINGS, "GET", "/trackers/trk_x").catch((e) => e);
    expect(err).toBeInstanceOf(EasyPostError);
    expect(err).toMatchObject({ status: 404, message: "EasyPost 404: Not found" });
  });

  it("handles non-JSON errors and empty bodies", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("Bad gateway", { status: 502 })));
    await expect(easypostRequest(SETTINGS, "GET", "/x")).rejects.toMatchObject({ status: 502, message: "EasyPost 502: Bad gateway" });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("", { status: 200 })));
    expect(await easypostRequest(SETTINGS, "GET", "/x")).toBeNull();
  });

  it("turns a timeout into a 504", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
        }),
      ),
    );
    await expect(easypostRequest(SETTINGS, "GET", "/x", undefined, 10)).rejects.toMatchObject({ status: 504 });
  });

  it("rethrows network errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("network down")));
    await expect(easypostRequest(SETTINGS, "GET", "/x")).rejects.toThrow("network down");
  });
});

describe("API calls", () => {
  it("call the right endpoints", async () => {
    const { calls } = mockEasyPost({
      "POST /shipments": { id: "shp_1" },
      "GET /shipments/shp_1": { id: "shp_1" },
      "POST /shipments/shp_1/buy": { id: "shp_1", tracking_code: "T" },
      "POST /shipments/shp_1/refund": { refund_status: "submitted" },
      "GET /trackers/trk_1": { id: "trk_1" },
      "GET /carrier_accounts": [{ type: "UspsAccount" }],
      "GET /shipments": { shipments: [] },
    });

    await createShipment(SETTINGS, { shipment: {} });
    await getShipment(SETTINGS, "shp_1");
    await buyShipment(SETTINGS, "shp_1", "rate_1");
    await refundShipment(SETTINGS, "shp_1");
    await getTracker(SETTINGS, "trk_1");
    expect(await listCarrierAccounts(SETTINGS)).toEqual([{ type: "UspsAccount" }]);
    await verifyKey(SETTINGS);

    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /shipments",
      "GET /shipments/shp_1",
      "POST /shipments/shp_1/buy",
      "POST /shipments/shp_1/refund",
      "GET /trackers/trk_1",
      "GET /carrier_accounts",
      "GET /shipments?page_size=1",
    ]);
    expect(calls[2].body).toEqual({ rate: { id: "rate_1" } });
  });

  it("listCarrierAccounts accepts a wrapped list", async () => {
    mockEasyPost({ "GET /carrier_accounts": { carrier_accounts: [{ id: "ca_1" }] } });
    expect(await listCarrierAccounts(SETTINGS)).toEqual([{ id: "ca_1" }]);
    mockEasyPost({ "GET /carrier_accounts": {} });
    expect(await listCarrierAccounts(SETTINGS)).toEqual([]);
  });
});

describe("addresses", () => {
  it("splitList splits on commas and spaces", () => {
    expect(splitList(" a, b  c,,")).toEqual(["a", "b", "c"]);
    expect(splitList(undefined)).toEqual([]);
  });

  it("fromAddress needs street, city, zip and country", () => {
    expect(fromAddress(SETTINGS)).toEqual({
      name: "Alder & Co.",
      company: undefined,
      street1: "215 Clayton St",
      street2: undefined,
      city: "San Francisco",
      state: "CA",
      zip: "94117",
      country: "US",
      phone: undefined,
      email: undefined,
    });
    expect(fromAddress({ ...SETTINGS, from_zip: " " })).toBeNull();
    expect(fromAddress({ ...SETTINGS, from_name: "", from_company: "Alder" })?.name).toBe("Alder");
  });

  it("toAddress maps a Swell address", () => {
    expect(toAddress(SHIPPING, "jane@example.com")).toEqual({
      name: "Jane Doe",
      company: undefined,
      street1: "965 Mission St",
      street2: undefined,
      city: "San Francisco",
      state: "CA",
      zip: "94103",
      country: "US",
      phone: undefined,
      email: "jane@example.com",
    });
    expect(toAddress({ name: "J", country: "de" })?.country).toBe("DE");
    expect(toAddress({ country: "US" })?.name).toBeUndefined();
    expect(toAddress({ address1: "x" })).toBeNull();
    expect(toAddress(null)).toBeNull();
  });

  it("getAccountEmail uses the account or loads it", async () => {
    const get = vi.fn().mockResolvedValue({ email: "a@b.co" });
    expect(await getAccountEmail({ get } as any, { account: { email: "x@y.z" } })).toBe("x@y.z");
    expect(await getAccountEmail({ get } as any, { account_id: "acc_1" })).toBe("a@b.co");
    expect(get).toHaveBeenCalledWith("/accounts/acc_1", { fields: "email" });
    expect(await getAccountEmail({ get } as any, {})).toBeUndefined();

    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await getAccountEmail({ get: vi.fn().mockRejectedValue(new Error("x")) } as any, { account_id: "a" })).toBeUndefined();
    expect(await getAccountEmail({ get: vi.fn().mockResolvedValue(null) } as any, { account_id: "a" })).toBeUndefined();
  });
});

describe("weights and parcels", () => {
  it("getWeightUnit reads the store setting", async () => {
    expect(await getWeightUnit({ get: vi.fn().mockResolvedValue({ weight_unit: "kg" }) } as any)).toBe("kg");
    expect(await getWeightUnit({ get: vi.fn().mockResolvedValue({ weight_unit: "stone" }) } as any)).toBe("lb");
    expect(await getWeightUnit({ get: vi.fn().mockResolvedValue(null) } as any)).toBe("lb");
  });

  it("shippableItems and totalWeight", () => {
    const items = [
      { delivery: "shipment", shipment_weight: 2 },
      { delivery: "shipment", shipment_weight: "1.5" },
      { delivery: null, shipment_weight: 9 },
      { delivery: "shipment" },
    ];
    expect(shippableItems({ items })).toHaveLength(3);
    expect(shippableItems(null)).toEqual([]);
    expect(totalWeight(shippableItems({ items }))).toBe(3.5);
  });

  it("converts weights to ounces and lengths to inches", () => {
    expect(toOunces(2, "lb")).toBe(32);
    expect(toOunces(1, "kg")).toBe(35.3);
    expect(toOunces(500, "g")).toBe(17.6);
    expect(toOunces(3, "oz")).toBe(3);
    expect(toOunces(1, "stone")).toBe(16);
    expect(toOunces(0.001, "g")).toBe(0.1);
    expect(toInches(25.4, "cm")).toBe(10);
    expect(toInches(4.04, "in")).toBe(4);
    expect(toInches(4, undefined)).toBe(4);
  });

  it("money rounds to cents", () => {
    expect(money(19.956)).toBe("19.96");
    expect(money(null)).toBe("0.00");
  });

  it("buildParcel uses item weights or the default", () => {
    expect(buildParcel([{ shipment_weight: 3 }], SETTINGS, "lb")).toEqual({ length: 10, width: 8, height: 4, weight: 48 });
    expect(buildParcel([], { ...SETTINGS, default_weight: 2, mass_unit: "kg" }, "lb").weight).toBe(70.5);
    expect(buildParcel([], { distance_unit: "cm", parcel_length: 30, parcel_width: 20, parcel_height: 10 }, "lb")).toEqual({
      length: 11.8,
      width: 7.9,
      height: 3.9,
      weight: 16,
    });
    expect(buildParcel([], {}, "lb")).toEqual({ length: 10, width: 8, height: 4, weight: 16 });
  });
});

describe("customs", () => {
  it("declares each item with value, weight and origin", () => {
    const order = makeOrder({
      items: [
        { delivery: "shipment", quantity: 2, shipment_weight: 1, price_total: 30, product: { name: "Mug", sku: "MUG", hs_code: "6912.00", origin_country: "pt" } },
        { delivery: "shipment", quantity: 2, price_total: 10, product_name: "Card", variant: { sku: "CARD-1" } },
      ],
    });
    const customs = buildCustomsInfo(order, { ...SETTINGS, customs_signer: "Sam" }, "lb", 40);
    expect(customs).toMatchObject({
      contents_type: "merchandise",
      customs_certify: true,
      customs_signer: "Sam",
      eel_pfc: "NOEEI 30.37(a)",
      non_delivery_option: "return",
      restriction_type: "none",
    });
    expect(customs.customs_items).toEqual([
      { description: "Mug", quantity: 2, value: "30.00", weight: 16, code: "MUG", hs_tariff_number: "6912.00", origin_country: "PT" },
      { description: "Card", quantity: 2, value: "10.00", weight: 20, code: "CARD-1", hs_tariff_number: undefined, origin_country: "US" },
    ]);
  });

  it("falls back for the signer and origin", () => {
    const order = makeOrder({ items: [{ delivery: "shipment", price_total: 5 }] });
    const customs = buildCustomsInfo(order, { from_company: "Alder" }, "lb", 0);
    expect(customs.customs_signer).toBe("Alder");
    expect(customs.customs_items[0]).toMatchObject({ description: "Merchandise", quantity: 1, weight: 0.1, origin_country: "US" });
  });
});

describe("buildShipment", () => {
  it("builds the rating shipment", () => {
    expect(buildShipment(makeOrder(), { ...SETTINGS, carrier_accounts: "ca_1, ca_2" }, "lb")).toEqual({
      shipment: {
        from_address: fromAddress(SETTINGS),
        to_address: toAddress(SHIPPING, "jane@example.com"),
        parcel: { length: 10, width: 8, height: 4, weight: 48 },
        carrier_accounts: ["ca_1", "ca_2"],
      },
    });
  });

  it("adds reference, label format and customs for international labels", () => {
    const order = makeOrder({ shipping: { ...SHIPPING, country: "CA", state: "ON" } });
    const body: any = buildShipment(order, SETTINGS, "lb", { reference: "100123", customs: true, labelFormat: "PDF" });
    expect(body.shipment.reference).toBe("100123");
    expect(body.shipment.options).toEqual({ label_format: "PDF" });
    expect(body.shipment.customs_info.customs_items).toHaveLength(1);
  });

  it("skips customs for domestic labels", () => {
    const body: any = buildShipment(makeOrder(), SETTINGS, "lb", { customs: true });
    expect(body.shipment.customs_info).toBeUndefined();
  });

  it("returns null without a ship-from address, destination or items", () => {
    expect(buildShipment(makeOrder(), { ...SETTINGS, from_street1: "" }, "lb")).toBeNull();
    expect(buildShipment(makeOrder({ shipping: {} }), SETTINGS, "lb")).toBeNull();
    expect(buildShipment(makeOrder({ items: [] }), SETTINGS, "lb")).toBeNull();
  });
});

describe("services", () => {
  it("serviceId and serviceName", () => {
    expect(serviceId({ carrier: "USPS", service: "GroundAdvantage" })).toBe("easypost_usps_groundadvantage");
    expect(serviceId({ carrier: "FedEx", service: "FEDEX_GROUND" })).toBe("easypost_fedex_fedex_ground");
    expect(serviceName({ carrier: "UPS", service: "2ndDayAirAM" })).toBe("UPS 2nd Day Air AM");
    expect(serviceName({ carrier: "USPS", service: "" })).toBe("USPS");
    expect(humanizeService("FEDEX_GROUND")).toBe("FEDEX GROUND");
    expect(humanizeService(undefined)).toBe("");
  });

  it("allowedServices and isAllowed", () => {
    const allowed = allowedServices({ services: "USPS:Priority, ups:Ground" });
    expect(allowed).toEqual(["usps:priority", "ups:ground"]);
    expect(isAllowed(makeRate(), allowed)).toBe(true);
    expect(isAllowed(makeRate({ carrier: "UPS", service: "NextDayAir" }), allowed)).toBe(false);
    expect(isAllowed(makeRate(), [])).toBe(true);
  });

  it("ratePrice matches the currency", () => {
    expect(ratePrice(makeRate(), "usd")).toBe(7.5);
    expect(ratePrice(makeRate(), undefined)).toBe(7.5);
    expect(ratePrice(makeRate({ currency: undefined }), "USD")).toBe(7.5);
    expect(ratePrice(makeRate(), "EUR")).toBeNull();
    expect(ratePrice(makeRate({ rate: "n/a" }), "USD")).toBeNull();
  });

  it("applyMarkup adds percent and fee", () => {
    expect(applyMarkup(10, { markup_percent: 10, handling_fee: 1.5 })).toBe(12.5);
    expect(applyMarkup(10, {})).toBe(10);
    expect(applyMarkup(1, { handling_fee: -5 })).toBe(0);
  });

  it("deliveryDescription", () => {
    expect(deliveryDescription(makeRate({ delivery_days: 1 }))).toBe("Estimated delivery in 1 day");
    expect(deliveryDescription(makeRate({ delivery_days: null, est_delivery_days: 3 }))).toBe("Estimated delivery in 3 days");
    expect(deliveryDescription(makeRate({ delivery_days: null }))).toBeUndefined();
  });

  it("ratesToServices filters, dedupes and sorts", () => {
    const rates = [
      makeRate(),
      makeRate({ id: "rate_2", rate: "6.90", carrier_account_id: "ca_2" }),
      makeRate({ id: "rate_3", carrier: "UPS", service: "Ground", rate: "5.10", delivery_days: null }),
      makeRate({ id: "rate_4", carrier: "DHLExpress", service: "Express", currency: "EUR" }),
    ];
    expect(ratesToServices(rates as any, { markup_percent: 10 }, "USD")).toEqual([
      { id: "easypost_ups_ground", name: "UPS Ground", price: 5.61, carrier: "easypost", easypost_carrier: "UPS", easypost_service: "Ground" },
      {
        id: "easypost_usps_priority",
        name: "USPS Priority",
        price: 7.59,
        carrier: "easypost",
        easypost_carrier: "USPS",
        easypost_service: "Priority",
        description: "Estimated delivery in 2 days",
      },
    ]);
    expect(ratesToServices(rates as any, { services: "UPS:Ground" }, "USD").map((s) => s.id)).toEqual(["easypost_ups_ground"]);
    expect(ratesToServices(rates as any, { show_delivery_days: false }, "USD")[1].description).toBeUndefined();
    expect(ratesToServices(undefined as any, {}, "USD")).toEqual([]);
  });
});

describe("label rate choice", () => {
  const rates = [makeRate(), makeRate({ id: "rate_2", carrier: "UPS", service: "Ground", rate: "5.10" })] as any;

  it("cheapestRate", () => {
    expect(cheapestRate(rates)?.id).toBe("rate_2");
    expect(cheapestRate([makeRate({ rate: "x" })] as any)).toBeNull();
    expect(cheapestRate([])).toBeNull();
  });

  it("uses the service the customer chose", () => {
    expect(chooseLabelRate(rates, makeOrder(), SETTINGS)).toEqual({ rate: rates[0] });
  });

  it("falls back to the cheapest when the chosen service is gone or not EasyPost", () => {
    const gone = makeOrder({ shipping: { ...SHIPPING, service: "easypost_fedex_2day" } });
    expect(chooseLabelRate(rates, gone, SETTINGS).rate?.id).toBe("rate_2");
    const native = makeOrder({ shipping: { ...SHIPPING, service: "standard" } });
    expect(chooseLabelRate(rates, native, {}).rate?.id).toBe("rate_2");
  });

  it("'chosen' never substitutes", () => {
    const gone = makeOrder({ shipping: { ...SHIPPING, service: "easypost_fedex_2day", service_name: "FedEx 2 Day" } });
    expect(chooseLabelRate(rates, gone, { label_service: "chosen" })).toEqual({
      rate: null,
      reason: "The service the customer chose (FedEx 2 Day) is no longer offered by EasyPost",
    });
    const native = makeOrder({ shipping: { ...SHIPPING, service: "standard" } });
    expect(chooseLabelRate(rates, native, { label_service: "chosen" })).toEqual({
      rate: null,
      reason: "The order is not shipped with an EasyPost service",
    });
  });

  it("'cheapest' ignores the choice but keeps the service filter", () => {
    expect(chooseLabelRate(rates, makeOrder(), { label_service: "cheapest" }).rate?.id).toBe("rate_2");
    expect(chooseLabelRate(rates, makeOrder(), { label_service: "cheapest", services: "USPS:Priority" }).rate?.id).toBe("rate_1");
  });

  it("explains when there are no rates", () => {
    expect(chooseLabelRate([], makeOrder(), {})).toEqual({ rate: null, reason: "EasyPost returned no rates for this order" });
  });
});

describe("misc", () => {
  it("rateMessages", () => {
    expect(rateMessages({ messages: [{ carrier: "UPS", message: "No rates" }, { message: "x" }, {}] })).toEqual(["UPS: No rates", "x"]);
    expect(rateMessages(null)).toEqual([]);
  });

  it("labelUrl picks the configured format", () => {
    const label = { label_url: "png", label_pdf_url: "pdf", label_zpl_url: "zpl" };
    expect(labelUrl(label, "PDF")).toBe("pdf");
    expect(labelUrl(label, "ZPL")).toBe("zpl");
    expect(labelUrl(label, "PNG")).toBe("png");
    expect(labelUrl({ label_pdf_url: "pdf" }, "PNG")).toBe("pdf");
    expect(labelUrl({ label_zpl_url: "zpl" }, "PDF")).toBe("zpl");
    expect(labelUrl({}, "PDF")).toBeUndefined();
    expect(labelUrl(null, "PDF")).toBeUndefined();
  });

  it("getAppData reads the app namespace", () => {
    expect(getAppData({ $app: { easypost: { a: 1 } } }, "easypost")).toEqual({ a: 1 });
    expect(getAppData({ $app: { easypost: { a: 1 } } }, "other-id")).toEqual({ a: 1 });
    expect(getAppData({}, "easypost")).toEqual({});
  });

  it("carrierId", () => {
    expect(carrierId("USPS")).toBe("usps");
    expect(carrierId("DHL Express")).toBe("dhl_express");
    expect(carrierId(undefined)).toBeUndefined();
  });

  it("safeEqual", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "ab")).toBe(false);
    expect(safeEqual("", "")).toBe(false);
  });
});
