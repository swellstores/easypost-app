import { getEasyPostSettings, hasKey } from './lib/easypost';
import { voidLabel } from './lib/labels';

export const config: SwellConfig = {
  description: "Void this order's EasyPost label",
  action: true,
};

export default async function (req: SwellRequest) {
  const orderId = req.data.$action?.record_id;

  if (typeof orderId !== 'string' || !/^[0-9a-f]{24}$/i.test(orderId)) {
    return { message: 'Open an order to void its label.' };
  }

  const settings = await getEasyPostSettings(req.swell);

  if (settings.enabled === false) {
    return { message: 'The EasyPost app is turned off. Turn on Enabled in the app settings first.' };
  }

  if (!hasKey(settings)) {
    return { message: 'Add your EasyPost API key in the app settings first.' };
  }

  const result = await voidLabel(req, orderId, settings);
  if (result.voided) {
    return {
      message: `Label voided. Refund ${result.refund_status}; the Swell shipment was canceled and a new label can be bought.`,
    };
  }
  return { message: `Not voided: ${result.reason}.` };
}
