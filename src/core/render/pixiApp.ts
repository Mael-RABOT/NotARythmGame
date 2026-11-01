import { Application } from 'pixi.js';

/**
 * One long-lived Pixi Application for the whole app (game and editor).
 * Creating and destroying renderers repeatedly is slow and, in Pixi v8,
 * destroying one while another initialises can corrupt shared state
 * (React StrictMode mounts screens twice). Screens attach/detach the canvas instead.
 */
let appPromise: Promise<Application> | null = null;

export const getPixiApp = (): Promise<Application> =>
  (appPromise ??= (async () => {
    const app = new Application();
    await app.init({
      backgroundAlpha: 0,
      antialias: true,
      autoDensity: true,
      resolution: Math.min(2, window.devicePixelRatio || 1),
      preference: 'webgl',
      powerPreference: 'high-performance',
      width: 800,
      height: 600,
    });
    app.canvas.style.display = 'block';
    return app;
  })());

/** Moves the shared canvas into `host` and sizes it to it */
export const attachPixi = async (host: HTMLElement): Promise<Application> => {
  const app = await getPixiApp();
  if (app.canvas.parentElement !== host) host.appendChild(app.canvas);
  app.resizeTo = host;
  app.resize();
  return app;
};

/** Removes a screen's content from the shared stage (the canvas stays alive) */
export const detachPixi = (app: Application, host: HTMLElement): void => {
  app.stage.removeChildren();
  if (app.canvas.parentElement === host) app.canvas.remove();
};
