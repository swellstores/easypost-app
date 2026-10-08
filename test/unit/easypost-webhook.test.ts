import { afterEach, describe, expect, it, vi } from "vitest";
import { config, handleEvent, post } from "../../functions/easypost-webhook";
import { createMockRequest } from "../helpers/mock-request";
import { SETTINGS, makeOrder, mockEasyPost } from "../helpers/fixtures";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const ORDER_ID = "64f0c0ffee0000000000aaaa";

function request(
  body: unknown,
  { token = SETTINGS.webhook_secret as string | null, settings = SETTINGS as Record<string, any>, swell = {} } = {},
) {
  const pending: Promise<unknown>[] = [];
  const req = createMockRequest({
    appId: "easypost",
    data: body as any,
    query: token === null ? {} : { token },
    swell: { settings: vi.fn().mockResolvedValue({ easypost: settings }), ...swell },
  });
  (req as any).context = { waitUntil: (promise: Promise<unknown>) => pending.push(promise) };
  return { req, pending };
}

const EVENT = { object: "Event", description: "tracker.updated", result: { object: "Tracker", id: "trk_1", status: "in_transit" } };

describe("easypost-webhook", () => {
  it("is a public POST route", () => {
    expect(config.route).toEqual({ methods: ["post"], public: true });
  });

  it("rejects a wrong or missing token", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(post(request(EVENT, { token: "nope" }).req)).rejects.toMatchObject({ status: 401 });
    await expect(post(request(EVENT, { token: null }).req)).rejects.toMatchObject({ status: 401 });
  });

  it("accepts the token from req.data when the query is empty", async () => {
    const { req } = request({ token: SETTINGS.webhook_secret }, { token: null });
    expect(await post(req)).toEqual({ received: true, processed: false });
  });

  it("rejects everything until a secret is configured", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { req } = request(EVENT, { token: "", settings: { ...SETTINGS, webhook_secret: "" } });
    await expect(post(req)).rejects.toMatchObject({ status: 401 });
  });

  it("acknowledges without work when disabled or the payload is empty", async () => {
    const off = request(EVENT, { settings: { ...SETTINGS, enabled: false } });
    expect(await post(off.req)).toEqual({ received: true, processed: false });
    expect(off.pending).toHaveLength(0);

    expect(await post(request({}).req)).toEqual({ received: true, processed: false });

    const text = request("not json");
    (text.req as any).body = "not json";
    expect(await post(text.req)).toEqual({ received: true, processed: false });

    const json = request({});
    (json.req as any).body = JSON.stringify({ description: "batch.created" });
    expect(await post(json.req)).toEqual({ received: true, processed: false });
  });

  it("answers right away and processes in the background", async () => {
    mockEasyPost({ "GET /trackers/trk_1": { id: "trk_1", status: null } });
    const { req, pending } = request(EVENT);

    expect(await post(req)).toEqual({ received: true, event: "tracker.updated" });
    expect(pending).toHaveLength(1);
    await Promise.all(pending);
  });

  it("logs background failures instead of throwing", async () => {
    mockEasyPost({});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { req, pending } = request(EVENT);

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
    const { req } = request({}, { swell: { get: vi.fn().mockResolvedValue({ results: [order] }), put } });

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
    const { req } = request({}, { swell: { get: vi.fn().mockResolvedValue({ results: [] }) } });

    await handleEvent(req, SETTINGS, "tracker.created", EVENT.result);

    expect(log).not.toHaveBeenCalled();
  });

  it("ignores other events and non-tracker results", async () => {
    const { fetchMock } = mockEasyPost({});
    const { req } = request({});
    await handleEvent(req, SETTINGS, "batch.created", { id: "batch_1" });
    await handleEvent(req, SETTINGS, "tracker.updated", { object: "Shipment", id: "shp_1" });
    await handleEvent(req, SETTINGS, "tracker.updated", { object: "Tracker" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
