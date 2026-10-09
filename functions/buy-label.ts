import { getEasyPostSettings, hasKey, humanizeService } from './lib/easypost';
import { buyLabel } from './lib/labels';

export const config: SwellConfig = {
  description: 'Buy an EasyPost label for this order',
  action: true,
};

export default async function (req: SwellRequest) {
  const orderId = req.data.$action?.record_id;

  if (typeof orderId !== 'string' || !/^[0-9a-f]{24}$/i.test(orderId)) {
    return { message: 'Open an order to buy its label.' };
  }

  const settings = await getEasyPostSettings(req.swell);

  if (settings.enabled === false) {
    return { message: 'The EasyPost app is turned off. Turn on Enabled in the app settings first.' };
  }

  if (!hasKey(settings)) {
    return { message: 'Add your EasyPost API key in the app settings first.' };
  }

  try {
    const result = await buyLabel(req, orderId, settings);
    if (result.bought) {
      const service = [result.carrier, humanizeService(result.service)].filter(Boolean).join(' ');
      return { message: `Bought a ${service} label. Tracking number ${result.tracking_code || 'pending'}.` };
    }
    return { message: `No label bought: ${result.reason}.` };
  } catch (err: any) {
    return { message: `No label bought: ${err?.message || err}` };
  }
}
