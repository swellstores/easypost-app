import { fail, getEasyPostSettings, hasKey } from './lib/easypost';
import { voidLabel } from './lib/labels';

export const config: SwellConfig = {
  description: "Void this order's EasyPost label",
  action: true,
};

export default async function (req: SwellRequest) {
  const orderId = req.data.$action?.record_id;

  if (typeof orderId !== 'string' || !/^[0-9a-f]{24}$/i.test(orderId)) {
    fail('Open an order to void its label.');
  }

  // every failure, a failed Swell read too, is a red error popup
  let result;
  try {
    const settings = await getEasyPostSettings(req.swell);
    if (settings.enabled === false) {
      fail('The EasyPost app is turned off. Turn on Enabled in the app settings first.');
    }
    if (!hasKey(settings)) {
      fail('Add your EasyPost API key in the app settings first.');
    }
    result = await voidLabel(req, orderId, settings);
  } catch (err: any) {
    if (err instanceof SwellError) throw err;
    fail(`Not voided: ${err?.message || err}`);
  }

  if (!result.voided) fail(`Not voided: ${result.reason}.`);

  const canceled = result.shipment_canceled ? 'the Swell shipment was canceled and ' : '';
  return { message: `Label voided. Refund ${result.refund_status}; ${canceled}a new label can be bought.` };
}
