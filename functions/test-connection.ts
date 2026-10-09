import { fromAddress, getEasyPostSettings, hasKey, isTestKey, listCarrierAccounts, verifyKey } from './lib/easypost';

export const config: SwellConfig = {
  description: 'Check the EasyPost API key',
  action: true,
};

export default async function (req: SwellRequest) {
  const settings = await getEasyPostSettings(req.swell);

  if (!hasKey(settings)) {
    return { message: 'Add your EasyPost API key and save the settings first.' };
  }

  try {
    await verifyKey(settings);
  } catch (err: any) {
    return { message: `EasyPost rejected the request: ${err?.message || err}` };
  }

  const test = isTestKey(settings.api_key);
  const notes: string[] = [];

  // EasyPost lists carrier accounts only for production keys
  if (!test) {
    try {
      const accounts = await listCarrierAccounts(settings);
      const carriers = [...new Set(accounts.map((account) => account.readable || account.type).filter(Boolean))];
      notes.push(`Carrier accounts: ${carriers.join(', ') || 'none'}.`);
      if (!carriers.length) {
        notes.push('Add a carrier account in EasyPost, or checkout will show no EasyPost rates.');
      }
    } catch (err: any) {
      notes.push(`Could not list carrier accounts (${err?.message || err}).`);
    }
  }

  if (!fromAddress(settings)) {
    notes.push('Fill in the ship-from address (street, city, postal code and country) to get rates and labels.');
  }
  if (!settings.webhook_secret?.trim()) {
    notes.push('Set a webhook secret to accept only signed EasyPost events.');
  }

  return { message: [`Connected to EasyPost (${test ? 'test' : 'production'} key).`, ...notes].join(' ') };
}
