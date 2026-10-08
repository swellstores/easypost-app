import { getEasyPostSettings, hasKey } from './lib/easypost';
import { refreshTracking } from './lib/labels';

export const config: SwellConfig = {
  description: 'Refresh tracking for EasyPost labels now',
  action: true,
};

export default async function (req: SwellRequest) {
  const settings = await getEasyPostSettings(req.swell);

  if (!hasKey(settings)) {
    return { message: 'Add your EasyPost API key in the app settings first.' };
  }

  const { checked, updated, errors, remaining } = await refreshTracking(req, settings);

  if (!checked) {
    return { message: 'No EasyPost labels are waiting for delivery.' };
  }

  const parts = [`Checked ${checked} ${checked === 1 ? 'label' : 'labels'}, ${updated} updated`];
  if (errors) parts.push(`${errors} with errors (see the function logs)`);
  return {
    message: `${parts.join(', ')}.${remaining ? ' More labels are waiting; run it again or wait for the next hourly refresh.' : ''}`,
  };
}
