import './style.css';
import { sdk } from '@smoud/playable-sdk';
import { createScannerPlayable } from './main.js';

let playable = null;
let appElement = null;

const ensureAppElement = () => {
  if (appElement?.isConnected) {
    return appElement;
  }

  appElement = document.querySelector('#app');

  if (appElement) {
    return appElement;
  }

  if (!document.body) {
    return null;
  }

  appElement = document.createElement('div');
  appElement.id = 'app';
  document.body.append(appElement);

  return appElement;
};

const renderLoading = () => {
  const element = ensureAppElement();

  if (!element) {
    return;
  }

  element.innerHTML = '<div class="loading">Loading playable...</div>';
};

const renderError = (error) => {
  const element = ensureAppElement();

  if (!element) {
    return;
  }

  const message = error instanceof Error ? error.message : String(error);
  element.innerHTML = `<div class="error">Failed to start playable.<br />${message}</div>`;
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', renderLoading, { once: true });
} else {
  renderLoading();
}

sdk.on('resize', (nextWidth, nextHeight) => playable?.resize(nextWidth, nextHeight));
sdk.on('pause', () => playable?.pause());
sdk.on('resume', () => playable?.resume());
sdk.on('finish', () => playable?.finish?.());
sdk.on('volume', (level) => playable?.volume?.(level));
sdk.on('retry', () => playable?.reset());

sdk.init(async (width, height) => {
  try {
    const element = ensureAppElement();

    if (!element) {
      throw new Error('Missing playable root element.');
    }

    playable?.destroy();
    playable = null;
    playable = await createScannerPlayable({
      appElement: element,
      width,
      height,
    });

    sdk.start();
  } catch (error) {
    console.error(error);
    renderError(error);
  }
});
