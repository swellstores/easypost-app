import { getEasyPostSettings, hasKey } from './lib/easypost';
import { refreshTracking } from './lib/labels';

export const config: SwellConfig = {
  description: 'Refresh tracking for EasyPost labels in transit',
  cron: {
    schedule: '0 * * * *',
  },
};

export default async function (req: SwellRequest) {
  const settings = await getEasyPostSettings(req.swell);

  if (settings.enabled === false || !hasKey(settings)) {
    return;
  }

  const summary = await refreshTracking(req, settings);

  if (summary.checked) {
    console.log('EasyPost: tracking refresh', summary);
  }
}
