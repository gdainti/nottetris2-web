// A clock for background tabs, run as a Web Worker. Browsers slow a page's own timers to about once
// a second in a background tab, but not a worker's, and its messages still reach the page on time.
// main.ts turns it on while the tab is hidden, so an online game keeps stepping and sending its state
// 20 times a second there instead of once.

let timer: ReturnType<typeof setInterval> | null = null;

addEventListener('message', (e: MessageEvent<boolean>) => {
  if (timer !== null) clearInterval(timer);
  timer = e.data ? setInterval(() => (self as unknown as Worker).postMessage(0), 50) : null;
});
