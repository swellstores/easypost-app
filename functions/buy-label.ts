import { fail, getEasyPostSettings, hasKey, humanizeService } from './lib/easypost';
import { ShipmentPending, buyLabel } from './lib/labels';

export const config: SwellConfig = {
  description: 'Buy an EasyPost label for this order',
  action: true,
};

export default async function (req: SwellRequest) {
  const orderId = req.data.$action?.record_id;

  if (typeof orderId !== 'string' || !/^[0-9a-f]{24}$/i.test(orderId)) {
    fail('Open an order to buy its label.');
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
    result = await buyLabel(req, orderId, settings);
  } catch (err: any) {
    if (err instanceof SwellError) throw err;
    // the label was bought; only the Swell shipment is pending
    if (err instanceof ShipmentPending) fail(err.message);
    fail(`No label bought: ${err?.message || err}`);
  }

  if (result.extra_label) fail(result.reason!);
  if (!result.bought) fail(`No label bought: ${result.reason}.`);

  const service = [result.carrier, humanizeService(result.service)].filter(Boolean).join(' ');
  return { message: `Bought a ${service} label. Tracking number ${result.tracking_code || 'pending'}.` };
}
