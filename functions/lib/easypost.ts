const API_BASE = 'https://api.easypost.com/v2';

// EasyPost answers rate requests synchronously; leave room for the 10s function limit
export const DEFAULT_TIMEOUT_MS = 8000;

export const SERVICE_PREFIX = 'easypost_';

export interface EasyPostSettings {
  api_key?: string;
  enabled?: boolean;
  from_name?: string;
  from_company?: string;
  from_street1?: string;
  from_street2?: string;
  from_city?: string;
  from_state?: string;
  from_zip?: string;
  from_country?: string;
  from_phone?: string;
  from_email?: string;
  rates_enabled?: boolean;
  carrier_accounts?: string;
  services?: string;
  markup_percent?: number;
  handling_fee?: number;
  show_delivery_days?: boolean;
  parcel_length?: number;
  parcel_width?: number;
  parcel_height?: number;
  distance_unit?: string;
  default_weight?: number;
  mass_unit?: string;
  buy_on?: 'manual' | 'paid' | 'submitted';
  label_service?: 'chosen_or_cheapest' | 'chosen' | 'cheapest';
  label_format?: 'PDF' | 'PNG' | 'ZPL';
  create_fulfillment?: boolean;
  customs_signer?: string;
  webhook_secret?: string;
}

export interface EasyPostAddress {
  name?: string;
  company?: string;
  street1?: string;
  street2?: string;
  city?: string;
  state?: string;
  zip?: string;
  country: string;
  phone?: string;
  email?: string;
}

export interface EasyPostParcel {
  length: number;
  width: number;
  height: number;
  weight: number;
}

export interface EasyPostRate {
  id: string;
  carrier: string;
  service: string;
  rate: string;
  currency?: string;
  delivery_days?: number | null;
  est_delivery_days?: number | null;
  carrier_account_id?: string;
}

export interface SwellService {
  id: string;
  name: string;
  price: number;
  description?: string;
  carrier?: string;
  [key: string]: unknown;
}

export class EasyPostError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function getEasyPostSettings(swell: SwellAPI): Promise<EasyPostSettings> {
  const all = await swell.settings();
  return all?.easypost || {};
}

export function hasKey(settings: EasyPostSettings): boolean {
  return Boolean(settings.api_key?.trim());
}

// test keys start with EZTK, production keys with EZAK
export function isTestKey(key?: string): boolean {
  return Boolean(key?.trim().startsWith('EZTK'));
}

// EasyPost errors come as { error: { code, message, errors: [{ field, message }] } }
export function formatEasyPostError(json: any, fallback: string): string {
  const error = json?.error;
  if (!error) {
    return typeof json === 'string' && json ? json : fallback;
  }
  const details = (Array.isArray(error.errors) ? error.errors : [])
    .map((item: any) => {
      if (typeof item === 'string') return item;
      const message = item?.message || item?.suggestion;
      if (!message) return '';
      return item.field ? `${item.field}: ${message}` : message;
    })
    .filter(Boolean);
  const message = error.message || error.code || fallback;
  return details.length ? `${message} (${details.join('; ')})` : message;
}

export async function easypostRequest(
  settings: EasyPostSettings,
  method: string,
  path: string,
  body?: object,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Basic ${btoa(`${settings.api_key?.trim()}:`)}`,
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      throw new EasyPostError(`EasyPost did not respond within ${timeoutMs / 1000}s`, 504);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // not JSON
  }

  if (!res.ok) {
    throw new EasyPostError(`EasyPost ${res.status}: ${formatEasyPostError(json, text || res.statusText)}`, res.status);
  }

  return json;
}

// --- addresses, weights, parcels ---

export function splitList(value?: string): string[] {
  return (value || '')
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

// ship-from address from settings; null until the required fields are filled in
export function fromAddress(settings: EasyPostSettings): EasyPostAddress | null {
  const required = [settings.from_street1, settings.from_city, settings.from_zip, settings.from_country];
  if (required.some((value) => !value?.trim())) {
    return null;
  }

  return {
    name: settings.from_name?.trim() || settings.from_company?.trim() || undefined,
    company: settings.from_company?.trim() || undefined,
    street1: settings.from_street1!.trim(),
    street2: settings.from_street2?.trim() || undefined,
    city: settings.from_city!.trim(),
    state: settings.from_state?.trim() || undefined,
    zip: settings.from_zip!.trim(),
    country: settings.from_country!.trim().toUpperCase(),
    phone: settings.from_phone?.trim() || undefined,
    email: settings.from_email?.trim() || undefined,
  };
}

// Swell address (order/cart `shipping`) to an EasyPost address
export function toAddress(address: any, email?: string): EasyPostAddress | null {
  if (!address?.country) {
    return null;
  }

  return {
    name: address.name || `${address.first_name || ''} ${address.last_name || ''}`.trim() || undefined,
    company: address.company || undefined,
    street1: address.address1 || undefined,
    street2: address.address2 || undefined,
    city: address.city || undefined,
    state: address.state || undefined,
    zip: address.zip || undefined,
    country: String(address.country).toUpperCase(),
    phone: address.phone || undefined,
    email: email || undefined,
  };
}

// hook data carries account_id but usually not the expanded account
export async function getAccountEmail(swell: SwellAPI, record: any): Promise<string | undefined> {
  if (record?.account?.email) {
    return record.account.email;
  }
  if (!record?.account_id) {
    return undefined;
  }
  try {
    const account = await swell.get(`/accounts/${record.account_id}`, { fields: 'email' });
    return account?.email || undefined;
  } catch (err: any) {
    console.warn(`EasyPost: could not load account ${record.account_id} - ${err?.message || err}`);
    return undefined;
  }
}

const WEIGHT_UNITS = ['g', 'kg', 'lb', 'oz'];
const OUNCES_PER: Record<string, number> = { oz: 1, lb: 16, kg: 35.27396, g: 0.03527396 };

export async function getWeightUnit(swell: SwellAPI): Promise<string> {
  const shipments = await swell.get('/settings/shipments');
  const unit = shipments?.weight_unit;
  return WEIGHT_UNITS.includes(unit) ? unit : 'lb';
}

export function shippableItems(record: any): any[] {
  return (record?.items || []).filter((item: any) => item.delivery === 'shipment');
}

// Swell item weights are line totals in the store's weight unit
export function totalWeight(items: any[]): number {
  return items.reduce((sum, item) => sum + (Number(item.shipment_weight) || 0), 0);
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

// EasyPost weights are ounces with one decimal
export function toOunces(weight: number, unit: string): number {
  return Math.max(round1(weight * (OUNCES_PER[unit] ?? OUNCES_PER.lb)), 0.1);
}

// EasyPost dimensions are inches with one decimal
export function toInches(value: number, unit?: string): number {
  return round1(unit === 'cm' ? value / 2.54 : value);
}

export function money(value: number | undefined | null): string {
  return (Math.round((Number(value) || 0) * 100) / 100).toFixed(2);
}

// one parcel per order: default box dimensions and the items' total weight
export function buildParcel(items: any[], settings: EasyPostSettings, weightUnit: string): EasyPostParcel {
  const weight = totalWeight(items);
  const useDefault = weight <= 0;
  const unit = useDefault ? settings.mass_unit || 'lb' : weightUnit;

  return {
    length: toInches(Number(settings.parcel_length) || 10, settings.distance_unit),
    width: toInches(Number(settings.parcel_width) || 8, settings.distance_unit),
    height: toInches(Number(settings.parcel_height) || 4, settings.distance_unit),
    weight: toOunces(useDefault ? Number(settings.default_weight) || 1 : weight, unit),
  };
}

// customs declaration for labels that leave the ship-from country
export function buildCustomsInfo(record: any, settings: EasyPostSettings, weightUnit: string, parcelWeight: number) {
  const items = shippableItems(record);
  const totalQuantity = items.reduce((sum: number, item: any) => sum + (Number(item.quantity) || 1), 0) || 1;

  return {
    contents_type: 'merchandise',
    customs_certify: true,
    customs_signer: settings.customs_signer?.trim() || settings.from_name?.trim() || settings.from_company?.trim(),
    eel_pfc: 'NOEEI 30.37(a)',
    non_delivery_option: 'return',
    restriction_type: 'none',
    customs_items: items.map((item: any) => {
      const quantity = Number(item.quantity) || 1;
      const weight = Number(item.shipment_weight) > 0
        ? toOunces(Number(item.shipment_weight), weightUnit)
        : Math.max(round1((parcelWeight * quantity) / totalQuantity), 0.1);
      return {
        description: (item.product?.name || item.product_name || 'Merchandise').slice(0, 255),
        quantity,
        value: money(item.price_total),
        weight,
        code: item.variant?.sku || item.product?.sku || undefined,
        hs_tariff_number: item.product?.hs_code || undefined,
        origin_country: (item.product?.origin_country || settings.from_country || 'US').toUpperCase(),
      };
    }),
  };
}

// --- shipments and rates ---

export interface ShipmentOptions {
  reference?: string;
  customs?: boolean;
  labelFormat?: string;
}

// POST /shipments body for a cart or order; null until there is something to rate
export function buildShipment(
  record: any,
  settings: EasyPostSettings,
  weightUnit: string,
  { reference, customs = false, labelFormat }: ShipmentOptions = {},
) {
  const from = fromAddress(settings);
  const to = toAddress(record?.shipping, record?.account?.email);
  const items = shippableItems(record);

  if (!from || !to || !items.length) {
    return null;
  }

  const parcel = buildParcel(items, settings, weightUnit);
  const carrierAccounts = splitList(settings.carrier_accounts);
  const international = to.country !== from.country;

  return {
    shipment: {
      from_address: from,
      to_address: to,
      parcel,
      ...(reference && { reference }),
      ...(carrierAccounts.length && { carrier_accounts: carrierAccounts }),
      ...(labelFormat && { options: { label_format: labelFormat } }),
      ...(customs && international && { customs_info: buildCustomsInfo(record, settings, weightUnit, parcel.weight) }),
    },
  };
}

// creating and buying must both fit in one 10s function run
export const CREATE_TIMEOUT_MS = 5000;
export const BUY_TIMEOUT_MS = 4000;

export async function createShipment(settings: EasyPostSettings, body: object, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<any> {
  return easypostRequest(settings, 'POST', '/shipments', body, timeoutMs);
}

export async function getShipment(settings: EasyPostSettings, shipmentId: string): Promise<any> {
  return easypostRequest(settings, 'GET', `/shipments/${encodeURIComponent(shipmentId)}`);
}

export async function buyShipment(
  settings: EasyPostSettings,
  shipmentId: string,
  rateId: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<any> {
  return easypostRequest(
    settings,
    'POST',
    `/shipments/${encodeURIComponent(shipmentId)}/buy`,
    { rate: { id: rateId } },
    timeoutMs,
  );
}

export async function refundShipment(settings: EasyPostSettings, shipmentId: string): Promise<any> {
  return easypostRequest(settings, 'POST', `/shipments/${encodeURIComponent(shipmentId)}/refund`);
}

export async function getTracker(settings: EasyPostSettings, trackerId: string): Promise<any> {
  return easypostRequest(settings, 'GET', `/trackers/${encodeURIComponent(trackerId)}`);
}

// carrier accounts can only be listed with a production key
export async function listCarrierAccounts(settings: EasyPostSettings): Promise<any[]> {
  const result = await easypostRequest(settings, 'GET', '/carrier_accounts');
  return Array.isArray(result) ? result : result?.carrier_accounts || [];
}

// cheap authenticated call that works with test and production keys
export async function verifyKey(settings: EasyPostSettings): Promise<void> {
  await easypostRequest(settings, 'GET', '/shipments?page_size=1');
}

function slug(value?: string): string {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

// stable Swell service id: easypost_<carrier>_<service>, e.g. easypost_usps_priority
export function serviceId(rate: Pick<EasyPostRate, 'carrier' | 'service'>): string {
  return `${SERVICE_PREFIX}${slug(rate.carrier)}_${slug(rate.service)}`;
}

// "GroundAdvantage" -> "Ground Advantage", "FEDEX_GROUND" -> "FEDEX GROUND"
export function humanizeService(service?: string): string {
  return String(service || '')
    .replace(/_/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
}

export function serviceName(rate: Pick<EasyPostRate, 'carrier' | 'service'>): string {
  return [rate.carrier, humanizeService(rate.service)].filter(Boolean).join(' ');
}

// "USPS:Priority, UPS:Ground" -> ['usps:priority', 'ups:ground']
export function allowedServices(settings: EasyPostSettings): string[] {
  return splitList(settings.services).map((pair) => pair.toLowerCase());
}

export function isAllowed(rate: EasyPostRate, allowed: string[]): boolean {
  return !allowed.length || allowed.includes(`${rate.carrier}:${rate.service}`.toLowerCase());
}

// rate price in the cart currency, or null when EasyPost quoted another currency
export function ratePrice(rate: EasyPostRate, currency?: string): number | null {
  const wanted = currency?.toUpperCase();
  const quoted = (rate.currency || 'USD').toUpperCase();
  if (wanted && quoted !== wanted) {
    return null;
  }
  const price = Number(rate.rate);
  return Number.isFinite(price) ? price : null;
}

export function applyMarkup(price: number, settings: EasyPostSettings): number {
  const markup = Number(settings.markup_percent) || 0;
  const fee = Number(settings.handling_fee) || 0;
  return Math.max(Math.round((price * (1 + markup / 100) + fee) * 100) / 100, 0);
}

export function deliveryDescription(rate: EasyPostRate): string | undefined {
  const days = rate.delivery_days ?? rate.est_delivery_days;
  if (typeof days === 'number' && days > 0) {
    return days === 1 ? 'Estimated delivery in 1 day' : `Estimated delivery in ${days} days`;
  }
  return undefined;
}

// EasyPost rates to Swell shipment services, cheapest first, one per carrier service
export function ratesToServices(rates: EasyPostRate[], settings: EasyPostSettings, currency?: string): SwellService[] {
  const allowed = allowedServices(settings);
  const byId = new Map<string, SwellService>();

  for (const rate of rates || []) {
    if (!isAllowed(rate, allowed)) {
      continue;
    }

    const price = ratePrice(rate, currency);
    if (price === null) {
      continue;
    }

    const service: SwellService = {
      id: serviceId(rate),
      name: serviceName(rate),
      price: applyMarkup(price, settings),
      carrier: 'easypost',
      easypost_carrier: rate.carrier,
      easypost_service: rate.service,
    };

    const description = settings.show_delivery_days === false ? undefined : deliveryDescription(rate);
    if (description) {
      service.description = description;
    }

    const existing = byId.get(service.id);
    if (!existing || service.price < existing.price) {
      byId.set(service.id, service);
    }
  }

  return [...byId.values()].sort((a, b) => a.price - b.price);
}

export function cheapestRate(rates: EasyPostRate[]): EasyPostRate | null {
  let best: EasyPostRate | null = null;
  for (const rate of rates || []) {
    const price = Number(rate.rate);
    if (!Number.isFinite(price)) continue;
    if (!best || price < Number(best.rate)) best = rate;
  }
  return best;
}

export interface RateChoice {
  rate: EasyPostRate | null;
  reason?: string;
}

// Picks the rate to buy: the service the customer chose at checkout, or the cheapest
export function chooseLabelRate(rates: EasyPostRate[], order: any, settings: EasyPostSettings): RateChoice {
  const mode = settings.label_service || 'chosen_or_cheapest';
  const allowed = allowedServices(settings);
  const candidates = (rates || []).filter((rate) => isAllowed(rate, allowed));
  const chosen = String(order?.shipping?.service || '');
  const isEasyPost = chosen.startsWith(SERVICE_PREFIX);

  if (mode !== 'cheapest' && isEasyPost) {
    const match = (rates || []).find((rate) => serviceId(rate) === chosen);
    if (match) {
      return { rate: match };
    }
    if (mode === 'chosen') {
      return { rate: null, reason: `The service the customer chose (${order.shipping.service_name || chosen}) is no longer offered by EasyPost` };
    }
  } else if (mode === 'chosen') {
    return { rate: null, reason: 'The order is not shipped with an EasyPost service' };
  }

  const cheapest = cheapestRate(candidates);
  return cheapest ? { rate: cheapest } : { rate: null, reason: 'EasyPost returned no rates for this order' };
}

// rate messages EasyPost returns when a carrier can't quote
export function rateMessages(shipment: any): string[] {
  return (shipment?.messages || [])
    .slice(0, 5)
    .map((m: any) => [m.carrier, m.message].filter(Boolean).join(': '))
    .filter(Boolean);
}

// label file URL in the configured format
export function labelUrl(postageLabel: any, format?: string): string | undefined {
  if (!postageLabel) return undefined;
  if (format === 'PDF' && postageLabel.label_pdf_url) return postageLabel.label_pdf_url;
  if (format === 'ZPL' && postageLabel.label_zpl_url) return postageLabel.label_zpl_url;
  return postageLabel.label_url || postageLabel.label_pdf_url || postageLabel.label_zpl_url || undefined;
}

// app values on a standard record are keyed by app slug in responses
export function getAppData(record: any, appId: string): Record<string, any> {
  return record?.$app?.[appId] || record?.$app?.easypost || {};
}

// Swell carrier ids are lowercase: "USPS" -> usps, "FedEx" -> fedex, "DHLExpress" -> dhlexpress
export function carrierId(carrier?: string): string | undefined {
  return carrier ? slug(carrier) : undefined;
}

// EasyPost signs each webhook event: X-Hmac-Signature = "hmac-sha256-hex=" + HMAC-SHA256(raw body),
// keyed with the webhook secret normalized to NFKD (as EasyPost's client libraries do)
export const SIGNATURE_PREFIX = 'hmac-sha256-hex=';

export async function computeSignature(secret: string, body: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret.normalize('NFKD')),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
  const hex = [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${SIGNATURE_PREFIX}${hex}`;
}

export async function verifySignature(secret: string, body: string, header?: string | null): Promise<boolean> {
  if (!secret || !header) {
    return false;
  }
  const expected = await computeSignature(secret, body);
  return safeEqual(header.trim().toLowerCase(), expected);
}

// constant-time string comparison
export function safeEqual(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
