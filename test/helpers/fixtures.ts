import { vi } from "vitest";
import type { EasyPostSettings } from "../../functions/lib/easypost";

export const SETTINGS: EasyPostSettings = {
  api_key: "EZTKtest123",
  enabled: true,
  from_name: "Alder & Co.",
  from_street1: "215 Clayton St",
  from_city: "San Francisco",
  from_state: "CA",
  from_zip: "94117",
  from_country: "us",
  rates_enabled: true,
  markup_percent: 0,
  handling_fee: 0,
  show_delivery_days: true,
  parcel_length: 10,
  parcel_width: 8,
  parcel_height: 4,
  distance_unit: "in",
  default_weight: 1,
  mass_unit: "lb",
  buy_on: "paid",
  label_service: "chosen_or_cheapest",
  label_format: "PDF",
  create_fulfillment: true,
  webhook_secret: "s3cret-token",
};

export const SHIPPING = {
  first_name: "Jane",
  last_name: "Doe",
  address1: "965 Mission St",
  city: "San Francisco",
  state: "CA",
  zip: "94103",
  country: "US",
  service: "easypost_usps_priority",
  service_name: "USPS Priority",
};

export function makeOrder(overrides: Record<string, any> = {}) {
  return {
    id: "64f0c0ffee0000000000aaaa",
    number: "100123",
    paid: true,
    currency: "USD",
    grand_total: 44.9,
    sub_total: 39.9,
    shipment_total: 5,
    date_created: "2026-10-01T10:00:00.000Z",
    account: { email: "jane@example.com" },
    shipping: { ...SHIPPING },
    items: [
      {
        id: "item_1",
        delivery: "shipment",
        quantity: 2,
        quantity_shipment_deliverable: 2,
        shipment_weight: 3,
        price: 19.95,
        price_total: 39.9,
        product_id: "prod_1",
        variant_id: "var_1",
        product: { name: "Mug", sku: "MUG" },
      },
    ],
    ...overrides,
  };
}

export function makeRate(overrides: Record<string, any> = {}) {
  return {
    id: "rate_1",
    carrier: "USPS",
    service: "Priority",
    rate: "7.50",
    currency: "USD",
    delivery_days: 2,
    carrier_account_id: "ca_1",
    ...overrides,
  };
}

export function makeBoughtShipment(overrides: Record<string, any> = {}) {
  return {
    id: "shp_1",
    tracking_code: "9400100000000000000000",
    selected_rate: makeRate(),
    postage_label: {
      label_url: "https://easypost-files.s3.amazonaws.com/label.png",
      label_pdf_url: "https://easypost-files.s3.amazonaws.com/label.pdf",
      label_date: "2026-10-02T09:00:00Z",
    },
    tracker: { id: "trk_1", status: "pre_transit", public_url: "https://track.easypost.com/trk_1" },
    ...overrides,
  };
}

// swell.get mock that answers by path
export function routeGet(routes: Record<string, unknown>) {
  return vi.fn(async (url: string, ...args: unknown[]) => {
    for (const [prefix, value] of Object.entries(routes)) {
      if (url === prefix || url.startsWith(`${prefix}?`)) {
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown)(...args) : value;
      }
    }
    return null;
  });
}

export function jsonResponse(body: unknown, status = 200) {
  return new Response(body === undefined ? "" : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// fetch mock that answers EasyPost requests by "METHOD /path" prefix (path without /v2)
export function mockEasyPost(routes: Record<string, unknown | ((body: any) => unknown)>) {
  const calls: { method: string; path: string; body: any; headers: Headers }[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = (init.method || "GET").toUpperCase();
    const path = url.pathname.replace(/^\/v2/, "") + url.search;
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body, headers: new Headers(init.headers) });

    for (const [key, value] of Object.entries(routes)) {
      const [routeMethod, routePath] = key.split(" ");
      if (routeMethod === method && (path === routePath || path.startsWith(`${routePath}?`))) {
        const result = typeof value === "function" ? (value as (b: any) => unknown)(body) : value;
        return result instanceof Response ? result : jsonResponse(result);
      }
    }
    return jsonResponse({ error: { code: "NOT_FOUND", message: `Not mocked: ${method} ${path}` } }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, calls };
}
