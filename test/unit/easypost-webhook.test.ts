import { afterEach, describe, expect, it, vi } from "vitest";
import { config, handleEvent, post } from "../../functions/easypost-webhook";
import { createMockRequest } from "../helpers/mock-request";
import { computeSignature } from "../../functions/lib/easypost";
import { SETTINGS, makeOrder, mockEasyPost } from "../helpers/fixtures";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const ORDER_ID = "64f0c0ffee0000000000aaaa";

// a webhook request as EasyPost sends it: raw JSON body plus X-Hmac-Signature
async function request(
  body: unknown,
  {
    secret = SETTINGS.webhook_secret as string,
    signature = undefined as string | null | undefined,
    settings = SETTINGS as Record<string, any>,
    swell = {},
  } = {},
) {
  const rawBody = typeof body === "string" ? body : JSON.stringify(body);
  const header = signature === undefined ? await computeSignature(secret, rawBody) : signature;
  const pending: Promise<unknown>[] = [];
  const req = createMockRequest({
    appId: "easypost",
    data: (typeof body === "object" ? body : {}) as any,
    headers: header === null ? {} : { "X-Hmac-Signature": header },
    swell: { settings: vi.fn().mockResolvedValue({ easypost: settings }), ...swell },
  });
  (req as any).rawBody = rawBody;
  if (typeof body === "string") (req as any).body = body;
  (req as any).context = { waitUntil: (promise: Promise<unknown>) => pending.push(promise) };
  return { req, pending };
}

const EVENT = { object: "Event", description: "tracker.updated", result: { object: "Tracker", id: "trk_1", status: "in_transit" } };

describe("easypost-webhook", () => {
  it("is a public POST route", () => {
    expect(config.route).toEqual({ methods: ["post"], public: true });
  });

  it("rejects a missing, wrong or differently-keyed signature", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(post((await request(EVENT, { signature: null })).req)).rejects.toMatchObject({ status: 401 });
    await expect(post((await request(EVENT, { signature: "hmac-sha256-hex=00" })).req)).rejects.toMatchObject({ status: 401 });
    await expect(post((await request(EVENT, { secret: "other-secret" })).req)).rejects.toMatchObject({ status: 401 });
    expect(warn).toHaveBeenCalledWith("EasyPost: webhook rejected", expect.objectContaining({ has_secret: true }));
  });

  it("rejects a body changed after signing", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { req } = await request(EVENT);
    (req as any).rawBody = JSON.stringify({ ...EVENT, description: "tracker.created" });
    await expect(post(req)).rejects.toMatchObject({ status: 401 });
  });

  it("accepts unsigned events when no secret is configured", async () => {
    mockEasyPost({ "GET /trackers/trk_1": { id: "trk_1", status: null } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    for (const webhook_secret of ["", "  ", undefined]) {
      const { req, pending } = await request(EVENT, { signature: null, settings: { ...SETTINGS, webhook_secret } });
      expect(await post(req)).toEqual({ received: true, event: "tracker.updated" });
      await Promise.all(pending);
    }

    // a signature sent anyway is ignored
    const signed = await request(EVENT, { signature: "hmac-sha256-hex=00", settings: { ...SETTINGS, webhook_secret: "" } });
    expect(await post(signed.req)).toEqual({ received: true, event: "tracker.updated" });
    expect(warn).not.toHaveBeenCalled();
  });

  it("no longer accepts the old URL token", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { req } = await request(EVENT, { signature: null });
    (req as any).query = { token: SETTINGS.webhook_secret };
    await expect(post(req)).rejects.toMatchObject({ status: 401 });
  });

  it("acknowledges without work when disabled or the payload is empty", async () => {
    const off = await request(EVENT, { settings: { ...SETTINGS, enabled: false } });
    expect(await post(off.req)).toEqual({ received: true, processed: false });
    expect(off.pending).toHaveLength(0);

    expect(await post((await request({})).req)).toEqual({ received: true, processed: false });
    expect(await post((await request("not json")).req)).toEqual({ received: true, processed: false });
    expect(await post((await request({ description: "batch.created" })).req)).toEqual({ received: true, processed: false });
  });

  it("parses the raw body when req.body isn't an object", async () => {
    mockEasyPost({ "GET /trackers/trk_1": { id: "trk_1", status: null } });
    const { req } = await request(EVENT);
    (req as any).body = JSON.stringify(EVENT);
    expect(await post(req)).toEqual({ received: true, event: "tracker.updated" });
  });

  it("falls back to a string req.body when rawBody is missing", async () => {
    const { req } = await request("not json");
    (req as any).rawBody = undefined;
    expect(await post(req)).toEqual({ received: true, processed: false });
  });

  it("answers right away and processes in the background", async () => {
    mockEasyPost({ "GET /trackers/trk_1": { id: "trk_1", status: null } });
    const { req, pending } = await request(EVENT);

    expect(await post(req)).toEqual({ received: true, event: "tracker.updated" });
    expect(pending).toHaveLength(1);
    await Promise.all(pending);
  });

  it("logs background failures instead of throwing", async () => {
    mockEasyPost({});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { req, pending } = await request(EVENT);

    await post(req);
    await Promise.all(pending);

    expect(error).toHaveBeenCalledWith(expect.stringContaining("EasyPost: webhook tracker.updated failed"));
  });
});

describe("handleEvent", () => {
  it("reloads the tracker from EasyPost and saves it", async () => {
    const { calls } = mockEasyPost({
      "GET /trackers/trk_1": { id: "trk_1", tracking_code: "9400", status: "delivered", updated_at: "2026-10-09T10:00:00Z" },
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const order = makeOrder({ $app: { easypost: { easypost_tracker_id: "trk_1" } } });
    const put = vi.fn().mockResolvedValue({});
    const { req } = await request({}, { swell: { get: vi.fn().mockResolvedValue({ results: [order] }), put } });

    // payload status is ignored: the reloaded tracker is used
    await handleEvent(req, SETTINGS, "tracker.updated", EVENT.result);

    expect(calls[0].path).toBe("/trackers/trk_1");
    expect(put).toHaveBeenCalledWith(`/orders/${ORDER_ID}`, {
      $app: { easypost: expect.objectContaining({ easypost_tracking_status: "delivered" }) },
    });
    expect(log).toHaveBeenCalledWith("EasyPost: tracking 9400 is delivered");
  });

  it("handles tracker.created and stays quiet when no order matches", async () => {
    mockEasyPost({ "GET /trackers/trk_1": { id: "trk_1", status: "pre_transit" } });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { req } = await request({}, { swell: { get: vi.fn().mockResolvedValue({ results: [] }) } });

    await handleEvent(req, SETTINGS, "tracker.created", EVENT.result);

    expect(log).not.toHaveBeenCalled();
  });

  it("ignores other events and non-tracker results", async () => {
    const { fetchMock } = mockEasyPost({});
    const { req } = await request({});
    await handleEvent(req, SETTINGS, "batch.created", { id: "batch_1" });
    await handleEvent(req, SETTINGS, "tracker.updated", { object: "Shipment", id: "shp_1" });
    await handleEvent(req, SETTINGS, "tracker.updated", { object: "Tracker" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
