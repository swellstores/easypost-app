import {
  EasyPostRate,
  SERVICE_PREFIX,
  buildShipment,
  createShipment,
  getAccountEmail,
  getEasyPostSettings,
  getWeightUnit,
  hasKey,
  rateMessages,
  ratesToServices,
} from './lib/easypost';

export const config: SwellConfig = {
  extension: 'easypost',
  description: 'Live EasyPost rates at checkout',
  timeout: 10000,
  model: {
    events: ['after:order.shipping'],
    fields: ['shipment_rating'],
  },
};

export default async function (req: SwellRequest) {
  const { swell, data } = req;
  const settings = await getEasyPostSettings(swell);

  if (settings.enabled === false || settings.rates_enabled === false) {
    return;
  }

  if (!hasKey(settings)) {
    console.error('EasyPost: missing API key, no rates returned');
    return;
  }

  // other services (native or from other carriers) stay; earlier EasyPost services are replaced
  const existing = (data.shipment_rating?.services || []).filter(
    (service: any) => !String(service?.id || '').startsWith(SERVICE_PREFIX),
  );

  // hook data holds only the changed fields; items and account_id come from the stored cart in $record
  const cart = { ...data.$record, ...data };

  const [weightUnit, email] = await Promise.all([getWeightUnit(swell), getAccountEmail(swell, cart)]);
  const body = buildShipment({ ...cart, account: { ...cart.account, email } }, settings, weightUnit);

  if (!body) {
    // no ship-from address, no shipping country or nothing to ship yet
    return;
  }

  let rates: EasyPostRate[] = [];
  try {
    const shipment = await createShipment(settings, body);
    rates = shipment?.rates || [];

    if (!rates.length) {
      console.warn('EasyPost: no rates', rateMessages(shipment));
    }
  } catch (err: any) {
    // never break checkout: fall back to the other services
    console.error(`EasyPost: rate request failed - ${err?.message || err}`);
    return;
  }

  const services = ratesToServices(rates, settings, cart.currency);

  if (rates.length && !services.length) {
    console.warn(`EasyPost: ${rates.length} rates returned, none in ${cart.currency} or matching the service filter`);
  }

  return {
    shipment_rating: {
      ...data.shipment_rating,
      services: [...existing, ...services],
    },
  };
}
