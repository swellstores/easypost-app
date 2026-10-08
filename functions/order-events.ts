import { getEasyPostSettings, hasKey } from './lib/easypost';
import { buyLabel } from './lib/labels';

export const config: SwellConfig = {
  description: 'Buy the EasyPost label when an order is paid or submitted',
  model: {
    events: ['order.submitted', 'order.paid'],
  },
};

export default async function (req: SwellRequest) {
  const { swell, data } = req;
  const eventType = data.$event?.type;

  const settings = await getEasyPostSettings(swell);

  if (settings.enabled === false || !settings.buy_on || settings.buy_on === 'manual') {
    return;
  }

  const buyEvent = settings.buy_on === 'submitted' ? 'order.submitted' : 'order.paid';
  if (eventType !== buyEvent) {
    return;
  }

  if (!hasKey(settings)) {
    console.error('EasyPost: missing API key, no label bought');
    return;
  }

  const result = await buyLabel(req, data.id, settings);
  if (!result.bought) {
    console.log(`EasyPost: no label for order ${data.number || data.id} - ${result.reason}`);
  }
}
