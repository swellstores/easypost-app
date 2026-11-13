import { fail, getEasyPostSettings, hasKey } from './lib/easypost';
import { refreshTracking } from './lib/labels';

export const config: SwellConfig = {
  description: 'Refresh tracking for EasyPost labels now',
  action: true,
};

export default async function (req: SwellRequest) {
  // every failure, a failed Swell read too, is a red error popup
  let summary;
  try {
    const settings = await getEasyPostSettings(req.swell);
    if (settings.enabled === false) {
      fail('The EasyPost app is turned off. Turn on Enabled in the app settings first.');
    }
    if (!hasKey(settings)) {
      fail('Add your EasyPost API key in the app settings first.');
    }
    summary = await refreshTracking(req, settings);
  } catch (err: any) {
    if (err instanceof SwellError) throw err;
    fail(`Refresh tracking failed: ${err?.message || err}`);
  }

  const { checked, updated, errors, remaining } = summary;
  if (!checked) {
    return { message: 'No EasyPost labels are waiting for delivery.' };
  }

  const parts = [`Checked ${checked} ${checked === 1 ? 'label' : 'labels'}, ${updated} updated`];
  if (errors) parts.push(`${errors} with errors (see the function logs)`);
  const message = `${parts.join(', ')}.${remaining ? ' More labels are waiting; run it again or wait for the next hourly refresh.' : ''}`;
  // any failed label makes the result an error
  if (errors) fail(message);
  return { message };
}
