import { afterEach, describe, expect, it, vi } from "vitest";
import handler, { config } from "../../functions/refresh-tracking";
import { createMockRequest } from "../helpers/mock-request";
import { SETTINGS, makeOrder, mockEasyPost } from "../helpers/fixtures";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function request(settings: Record<string, any>, orders: any[] = []) {
  const get = vi.fn().mockResolvedValue({ results: orders, count: orders.length });
  const put = vi.fn().mockResolvedValue({});
  const req = createMockRequest({
    appId: "easypost",
    swell: { settings: vi.fn().mockResolvedValue({ easypost: settings }), get, put },
  });
  return { req, get, put };
}

describe("refresh-tracking", () => {
  it("runs every hour", () => {
    expect(config.cron?.schedule).toBe("0 * * * *");
  });

  it("refreshes labels in transit and logs the summary", async () => {
    mockEasyPost({ "GET /trackers/trk_1": { id: "trk_1", status: "delivered", updated_at: "2026-10-09T10:00:00Z" } });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const order = makeOrder({ $app: { easypost: { easypost_status: "label_purchased", easypost_tracker_id: "trk_1" } } });
    const { req, put } = request(SETTINGS, [order]);

    await handler(req);

    expect(put.mock.calls[0][1].$app.easypost.easypost_tracking_status).toBe("delivered");
    expect(log).toHaveBeenCalledWith("EasyPost: tracking refresh", { checked: 1, updated: 1, errors: 0, remaining: false });
  });

  it("stays quiet when nothing is in transit", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { req, get } = request(SETTINGS, []);

    await handler(req);

    expect(get).toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it("does nothing when disabled or the key is missing", async () => {
    for (const settings of [{ ...SETTINGS, enabled: false }, { ...SETTINGS, api_key: "" }]) {
      const { req, get } = request(settings);
      await handler(req);
      expect(get).not.toHaveBeenCalled();
    }
  });
});
