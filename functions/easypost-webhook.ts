import { EasyPostSettings, getEasyPostSettings, getTracker, hasKey, verifySignature } from './lib/easypost';
import { applyTracker } from './lib/labels';

export const config: SwellConfig = {
  description: 'Receive EasyPost tracker webhooks',
  route: {
    methods: ['post'],
    public: true,
  },
};

// With a webhook secret in the settings, EasyPost signs every event with it (X-Hmac-Signature
// over the raw body) and unsigned or mis-signed requests are rejected. Without a secret, events
// are accepted unsigned. Either way, every tracker is loaded again from the EasyPost API with
// your key before it is used, so the payload itself is never trusted.
export async function post(req: SwellRequest) {
  const { swell } = req;
  const settings = await getEasyPostSettings(swell);

  const secret = settings.webhook_secret?.trim() || '';
  // the exact text EasyPost sent; re-stringifying req.body would not match the signature
  const rawBody = typeof req.rawBody === 'string' ? req.rawBody : typeof req.body === 'string' ? req.body : '';
  const signature = req.headers?.get('x-hmac-signature');

  if (secret && !(await verifySignature(secret, rawBody, signature))) {
    console.warn('EasyPost: webhook rejected', {
      has_signature: Boolean(signature),
      has_secret: Boolean(secret),
      body_length: rawBody.length,
    });
    throw new SwellError('Invalid webhook signature', { status: 401 });
  }

  if (settings.enabled === false || !hasKey(settings)) {
    return { received: true, processed: false };
  }

  const event = (typeof req.body === 'object' && req.body ? req.body : safeParse(rawBody)) as {
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
