// Posts short reports to the events chat through tg-pigeon (github.com/gdainti/tg-pigeon).

export type Notify = (text: string) => Promise<void>;

/** Does nothing: notifications are off. */
export const silent: Notify = async () => {};

const WARN_EVERY_MS = 10 * 60_000;

/** Posts to the events chat through tg-pigeon; a no-op when url or token is empty. Never throws. */
export function createNotifier(options: { url: string; token: string }): Notify {
  const url = options.url.replace(/\/+$/, '');
  const { token } = options;
  if (!url || !token) return silent;
  let lastWarnAt = 0;

  return async (text) => {
    try {
      const res = await fetch(`${url}/api/v1/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, parseMode: 'none' }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) console.warn(`[notify] tg-pigeon rejected a message: ${res.status} ${await res.text()}`);
    } catch (e) {
      // One short line, at most once per WARN_EVERY_MS: a tg-pigeon that is down would otherwise
      // print a stack trace for every game started.
      if (Date.now() - lastWarnAt >= WARN_EVERY_MS) {
        lastWarnAt = Date.now();
        const cause = (e as { cause?: { code?: string } }).cause?.code ?? (e as Error)?.name;
        console.warn(`[notify] tg-pigeon is unreachable (${cause}); further failures are not logged for 10 min`);
      }
    }
  };
}

/**
 * The notifier for this process. Only production (NODE_ENV=production, as in the Docker image) posts:
 * `npm run server` restarts on every save, and each start would be announced to the real chat.
 */
export function notifierFromEnv(env: NodeJS.ProcessEnv): { notify: Notify; why: string } {
  const url = env.TG_PIGEON_URL ?? '';
  const token = env.TG_PIGEON_TOKEN ?? '';
  if (!url || !token) return { notify: silent, why: 'off (TG_PIGEON_URL or TG_PIGEON_TOKEN is empty)' };
  if (env.NODE_ENV !== 'production') return { notify: silent, why: 'off outside production (NODE_ENV is not production)' };
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    return { notify: silent, why: `off (TG_PIGEON_URL is not a URL)` };
  }
  return { notify: createNotifier({ url, token }), why: `on (${host})` };
}
