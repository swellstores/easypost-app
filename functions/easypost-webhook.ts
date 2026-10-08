import { EasyPostSettings, getEasyPostSettings, getTracker, hasKey, safeEqual } from './lib/easypost';
import { applyTracker } from './lib/labels';

export const config: SwellConfig = {
  description: 'Receive EasyPost tracker webhooks',
  route: {
    methods: ['post'],
    public: true,
  },
};

// The URL carries a secret token, and every tracker is loaded again from
// the EasyPost API with your key before it is used.
export async function post(req: SwellRequest) {
  const { swell } = req;
  const settings = await getEasyPostSettings(swell);

  const secret = settings.webhook_secret?.trim() || '';
  // query params can also arrive merged into req.data (e.g. through `swell api`)
  const token = String(req.query?.token || req.data?.token || '');

  if (!secret || !safeEqual(token, secret)) {
    console.warn('EasyPost: webhook rejected', { has_token: Boolean(token), has_secret: Boolean(secret) });
    throw new SwellError('Invalid webhook token', { status: 401 });
  }

  if (settings.enabled === false || !hasKey(settings)) {
    return { received: true, processed: false };
  }

  const event = (typeof req.body === 'string' ? safeParse(req.body) : req.body) as {
    description?: string;
    result?: any;
  };

  const description = event?.description;
  if (!description || !event.result) {
    return { received: true, processed: false };
  }

  // answer right away and do the work after responding
  req.context.waitUntil(
    handleEvent(req, settings, description, event.result).catch((err) => {
      console.error(`EasyPost: webhook ${description} failed - ${err?.message || err}`);
    }),
  );

  return { received: true, event: description };
}

export async function handleEvent(req: SwellRequest, settings: EasyPostSettings, description: string, result: any) {
  if (description !== 'tracker.created' && description !== 'tracker.updated') {
    return;
  }
  if (!result?.id || result.object !== 'Tracker') {
    return;
  }

  const tracker = await getTracker(settings, result.id);
  if (await applyTracker(req, tracker)) {
    console.log(`EasyPost: tracking ${tracker.tracking_code} is ${tracker.status}`);
  }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
