import { Application, Assets, Container, Graphics, Rectangle, Texture } from 'pixi.js';
import { TextureAtlas } from '@pixi-spine/base';
import { AtlasAttachmentLoader, SkeletonJson, Spine } from '@pixi-spine/runtime-3.8';
import { sdk } from '@smoud/playable-sdk';
import rawSkeletonSource from '../skeleton.json';
import clothTextureUrl from '../images/jpg/cloth.jpg';
import nakedTextureUrl from '../images/jpg/naked.jpg';
import scannerIconUrl from '../images/jpg/scanner_converted.jpg';
import clothAlphaMaskUrl from '../images/alpha_masks/cloth_alpha_mask.jpg';
import nakedAlphaMaskUrl from '../images/alpha_masks/naked_alpha_mask.jpg';
import scannerAlphaMaskUrl from '../images/alpha_masks/scanner_converted_alpha_mask.jpg';
import tempScannerIconUrl from '../images/jpg/temp_scanner.jpg';
import tempScannerAlphaMaskUrl from '../images/alpha_masks/temp_scanner_alpha_mask.jpg';

const skeletonSource = typeof rawSkeletonSource === 'string'
  ? JSON.parse(rawSkeletonSource)
  : rawSkeletonSource;
  
// Playable builds use explicit asset imports here instead of import.meta.glob.
const textureEntries = [
  { assetUrl: clothTextureUrl, alphaMaskUrl: clothAlphaMaskUrl, fileName: 'cloth.jpg' },
  { assetUrl: nakedTextureUrl, alphaMaskUrl: nakedAlphaMaskUrl, fileName: 'naked.jpg' },
];

// Edit this list to choose which bones define the infected scan zone.
const DETECTION_BONE_NAMES = ['cloth7'];
const DETECTION_SLOT_NAME = 'cloth';
const DETECTION_WEIGHT_THRESHOLD = 0.18;
const VITALS_HEAD_BONE_NAME = 'cloth23';
const RELEASE_MASK_FADE_SPEED = 5.6;
const ENDGAME_REVEAL_DELAY_MS = 900;
const TOUCH_SCAN_LIFT_FACTOR = 1.35;
const TOUCH_SCAN_LIFT_MIN = 170;
const PEN_SCAN_LIFT_FACTOR = 0.8;
const PEN_SCAN_LIFT_MIN = 42;
const TOOL_XRAY = 'xray';
const TOOL_VITALS = 'vitals';
const BASE_BODY_TEMP = 36.6;
const ALERT_BODY_TEMP = 39.1;
const BASE_HEART_RATE = 74;
const ALERT_HEART_RATE = 171;
const GREEN = 2;
const YELLOW = 0.84;
const RED = 0.6;
const HEARTBEAT_SOUND_VOLUME = 0.42;
const HEARTBEAT_SOUND_DOUBLE_PULSE_DELAY = 0.12;

const collectAttachmentNames = (skeletonData) => {
  const attachmentNames = new Set();

  for (const skin of skeletonData.skins ?? []) {
    for (const slotAttachments of Object.values(skin.attachments ?? {})) {
      for (const attachmentName of Object.keys(slotAttachments ?? {})) {
        attachmentNames.add(attachmentName);
      }
    }
  }

  return [...attachmentNames];
};

const loadTextureSets = async (attachmentNames) => {
  const clothed = {};
  const naked = {};
  const primaryAttachment = attachmentNames[0];

  await Promise.all(
    textureEntries.map(async (textureEntry) => {
      const texture = await loadTextureAsset(textureEntry);
      const baseName = textureEntry.fileName.replace(/\.(png|jpe?g)$/i, '');

      if (baseName === 'naked' && primaryAttachment) {
        naked[primaryAttachment] = texture;
        return;
      }

      if (baseName === 'cloth' && primaryAttachment) {
        clothed[primaryAttachment] = texture;
        return;
      }

      if (baseName.endsWith('_naked')) {
        naked[baseName.replace(/_naked$/i, '')] = texture;
        return;
      }

      clothed[baseName] = texture;
    }),
  );

  return { clothed, naked };
};

const buildSpineData = (textures) => {
  const atlas = new TextureAtlas();

  atlas.addTextureHash(textures, false);

  const attachmentLoader = new AtlasAttachmentLoader(atlas);
  const skeletonJson = new SkeletonJson(attachmentLoader);

  return skeletonJson.readSkeletonData(skeletonSource);
};

const mergeBounds = (...boundsList) => {
  const left = Math.min(...boundsList.map((bounds) => bounds.x));
  const top = Math.min(...boundsList.map((bounds) => bounds.y));
  const right = Math.max(...boundsList.map((bounds) => bounds.x + bounds.width));
  const bottom = Math.max(...boundsList.map((bounds) => bounds.y + bounds.height));

  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  };
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const lerp = (start, end, amount) => start + (end - start) * amount;

const formatTemperature = (value) => `${value.toFixed(1)}°C`;

const removeWhiteMatte = (color, alpha) => {
  if (alpha <= 0) {
    return 0;
  }

  if (alpha >= 255) {
    return color;
  }

  const normalizedAlpha = alpha / 255;
  const demultiplied = (color - 255 * (1 - normalizedAlpha)) / normalizedAlpha;

  return clamp(Math.round(demultiplied), 0, 255);
};

const loadImageElement = (src) => new Promise((resolve, reject) => {
  const image = new Image();

  image.decoding = 'async';
  image.onload = () => resolve(image);
  image.onerror = () => reject(new Error(`Failed to load image asset.`));
  image.src = src;
});

const composeAlphaMaskedCanvas = async (assetUrl, alphaMaskUrl) => {
  const [assetImage, alphaMaskImage] = await Promise.all([
    loadImageElement(assetUrl),
    loadImageElement(alphaMaskUrl),
  ]);
  const width = assetImage.naturalWidth || assetImage.width;
  const height = assetImage.naturalHeight || assetImage.height;
  const alphaWidth = alphaMaskImage.naturalWidth || alphaMaskImage.width;
  const alphaHeight = alphaMaskImage.naturalHeight || alphaMaskImage.height;

  if (width !== alphaWidth || height !== alphaHeight) {
    throw new Error('Alpha mask dimensions do not match the source image.');
  }

  const colorCanvas = document.createElement('canvas');
  colorCanvas.width = width;
  colorCanvas.height = height;

  const maskCanvas = document.createElement('canvas');
  maskCanvas.width = width;
  maskCanvas.height = height;

  const colorContext = colorCanvas.getContext('2d', { willReadFrequently: true });
  const maskContext = maskCanvas.getContext('2d', { willReadFrequently: true });

  if (!colorContext || !maskContext) {
    throw new Error('Failed to create canvas context for alpha-masked asset.');
  }

  colorContext.drawImage(assetImage, 0, 0, width, height);
  maskContext.drawImage(alphaMaskImage, 0, 0, width, height);

  const colorImageData = colorContext.getImageData(0, 0, width, height);
  const alphaImageData = maskContext.getImageData(0, 0, width, height);
  const colorPixels = colorImageData.data;
  const alphaPixels = alphaImageData.data;

  for (let pixelIndex = 0; pixelIndex < colorPixels.length; pixelIndex += 4) {
    const alpha = Math.round(
      (alphaPixels[pixelIndex] + alphaPixels[pixelIndex + 1] + alphaPixels[pixelIndex + 2]) / 3,
    );
    colorPixels[pixelIndex + 3] = alpha;

    // Compensate for light JPG matte on semi-transparent edges to avoid white fringing.
    colorPixels[pixelIndex] = removeWhiteMatte(colorPixels[pixelIndex], alpha);
    colorPixels[pixelIndex + 1] = removeWhiteMatte(colorPixels[pixelIndex + 1], alpha);
    colorPixels[pixelIndex + 2] = removeWhiteMatte(colorPixels[pixelIndex + 2], alpha);
  }

  colorContext.putImageData(colorImageData, 0, 0);

  return colorCanvas;
};

const loadTextureAsset = async ({ assetUrl, alphaMaskUrl }) => {
  if (!alphaMaskUrl) {
    return Assets.load(assetUrl);
  }

  const maskedCanvas = await composeAlphaMaskedCanvas(assetUrl, alphaMaskUrl);

  return Texture.from(maskedCanvas);
};

const loadUiAssetUrl = async (assetUrl, alphaMaskUrl) => {
  if (!alphaMaskUrl) {
    return assetUrl;
  }

  const maskedCanvas = await composeAlphaMaskedCanvas(assetUrl, alphaMaskUrl);

  return maskedCanvas.toDataURL('image/png');
};

const createScannerButton = (iconUrl, {
  tool,
  label,
  hint,
  ariaLabel,
  themeClass = '',
} = {}) => {
  const scannerButton = document.createElement('button');

  scannerButton.className = `scanner-button ${themeClass}`.trim();
  scannerButton.type = 'button';
  scannerButton.dataset.tool = tool;
  scannerButton.setAttribute('aria-label', ariaLabel || 'Hold scanner to scan');
  scannerButton.innerHTML = `
    <span class="scanner-button__shine"></span>
    <img class="scanner-button__img" src="${iconUrl}" alt="" draggable="false" />
    <span class="scanner-button__label">${label || 'Scanner'}</span>
    <span class="scanner-button__hint">${hint || 'Hold and drag'}</span>
  `;

  return scannerButton;
};

const createToolDock = (...buttons) => {
  const toolDock = document.createElement('div');

  toolDock.className = 'tool-dock';
  toolDock.append(...buttons);

  return toolDock;
};

const createIntroOverlay = () => {
  const introOverlay = document.createElement('div');

  introOverlay.className = 'intro-overlay';
  introOverlay.innerHTML = `
    <div class="intro-overlay__backdrop"></div>
    <button class="intro-overlay__button" type="button">Start Inspection</button>
  `;

  const startButton = introOverlay.querySelector('.intro-overlay__button');

  if (!(startButton instanceof HTMLButtonElement)) {
    throw new Error('Failed to create intro overlay button.');
  }

  return {
    introOverlay,
    startButton,
  };
};

const createScanAlert = () => {
  const scanAlert = document.createElement('div');

  scanAlert.className = 'scan-alert';
  scanAlert.textContent = 'INFECTED';

  return scanAlert;
};

const createChecklist = () => {
  const checklist = document.createElement('div');

  checklist.className = 'checklist';
  checklist.innerHTML = `
    <div class="checklist__title">Check List</div>
    <div class="checklist__item" data-task="vitals">
      <span class="checklist__icon" aria-hidden="true"></span>
      <div class="checklist__copy">
        <div class="checklist__label">Vitals</div>
        <div class="checklist__detail">Pending</div>
      </div>
    </div>
    <div class="checklist__item" data-task="injury">
      <span class="checklist__icon" aria-hidden="true"></span>
      <div class="checklist__copy">
        <div class="checklist__label">Injury</div>
        <div class="checklist__detail">Pending</div>
      </div>
    </div>
  `;

  const vitalsItem = checklist.querySelector('[data-task="vitals"]');
  const injuryItem = checklist.querySelector('[data-task="injury"]');

  if (!(vitalsItem instanceof HTMLElement) || !(injuryItem instanceof HTMLElement)) {
    throw new Error('Failed to create checklist.');
  }

  return {
    checklist,
    vitalsItem,
    injuryItem,
  };
};

const createVitalsReadout = () => {
  const vitalsReadout = document.createElement('div');

  vitalsReadout.className = 'vitals-readout';
  vitalsReadout.innerHTML = `
    <div class="vitals-readout__row">
      <span class="vitals-readout__metric" data-role="temp">TEMP ${formatTemperature(BASE_BODY_TEMP)}</span>
      <span class="vitals-readout__metric" data-role="bpm">BPM ${BASE_HEART_RATE}</span>
    </div>
    <div class="vitals-readout__wave"></div>
  `;

  const tempValue = vitalsReadout.querySelector('[data-role="temp"]');
  const bpmValue = vitalsReadout.querySelector('[data-role="bpm"]');

  if (!(tempValue instanceof HTMLElement) || !(bpmValue instanceof HTMLElement)) {
    throw new Error('Failed to create vitals readout.');
  }

  return {
    vitalsReadout,
    tempValue,
    bpmValue,
  };
};

const createEndgameOverlay = () => {
  const endgameOverlay = document.createElement('div');

  endgameOverlay.className = 'endgame';
  endgameOverlay.innerHTML = `
    <div class="endgame__backdrop"></div>
    <div class="endgame__panel">
      <div class="endgame__summary">
        <div class="endgame__fact"><span class="endgame__fact-label">Temperature</span><span class="endgame__fact-value" data-role="temperature">Not recorded</span></div>
        <div class="endgame__fact"><span class="endgame__fact-label">Wound</span><span class="endgame__fact-value" data-role="wound">Unknown</span></div>
        <div class="endgame__fact"><span class="endgame__fact-label">Findings</span><span class="endgame__fact-value" data-role="findings">Pending</span></div>
      </div>
      <div class="endgame__actions">
        <button class="endgame__action endgame__action--pass" type="button">Pass</button>
        <button class="endgame__action endgame__action--destroy" type="button">Destroy</button>
      </div>
    </div>
  `;

  const passButton = endgameOverlay.querySelector('.endgame__action--pass');
  const destroyButton = endgameOverlay.querySelector('.endgame__action--destroy');
  const temperatureValue = endgameOverlay.querySelector('[data-role="temperature"]');
  const woundValue = endgameOverlay.querySelector('[data-role="wound"]');
  const findingsValue = endgameOverlay.querySelector('[data-role="findings"]');

  if (
    !(passButton instanceof HTMLButtonElement)
    || !(destroyButton instanceof HTMLButtonElement)
    || !(temperatureValue instanceof HTMLElement)
    || !(woundValue instanceof HTMLElement)
    || !(findingsValue instanceof HTMLElement)
  ) {
    throw new Error('Failed to create endgame buttons.');
  }

  return {
    endgameOverlay,
    passButton,
    destroyButton,
    temperatureValue,
    woundValue,
    findingsValue,
  };
};

const getRendererPointFromClient = (app, clientX, clientY) => {
  const rect = app.view.getBoundingClientRect();
  const scaleX = rect.width > 0 ? app.screen.width / rect.width : 1;
  const scaleY = rect.height > 0 ? app.screen.height / rect.height : 1;

  return {
    x: clamp((clientX - rect.left) * scaleX, 0, app.screen.width),
    y: clamp((clientY - rect.top) * scaleY, 0, app.screen.height),
  };
};

const getInitialDimension = (value, fallback) => Math.max(1, Math.round(value || fallback || 1));

export const createScannerPlayable = async ({
  appElement,
  width,
  height,
} = {}) => {
  if (!appElement) {
    throw new Error('Missing #app container.');
  }

  const initialWidth = getInitialDimension(width, appElement.clientWidth || window.innerWidth);
  const initialHeight = getInitialDimension(height, appElement.clientHeight || window.innerHeight);
  const app = new Application({
    antialias: true,
    autoDensity: true,
    backgroundAlpha: 0,
    width: initialWidth,
    height: initialHeight,
  });
  const [scannerButtonIconUrl, tempScannerButtonIconUrl] = await Promise.all([
    loadUiAssetUrl(scannerIconUrl, scannerAlphaMaskUrl),
    loadUiAssetUrl(tempScannerIconUrl, tempScannerAlphaMaskUrl),
  ]);
  const xrayButton = createScannerButton(scannerButtonIconUrl, {
    tool: TOOL_XRAY,
    label: 'X-Ray',
    hint: 'Reveal infection',
    ariaLabel: 'Hold x-ray scanner to scan',
    themeClass: 'scanner-button--xray',
  });
  const vitalsButton = createScannerButton(tempScannerButtonIconUrl, {
    tool: TOOL_VITALS,
    label: 'Vitals',
    hint: 'Temp + BPM',
    ariaLabel: 'Hold thermal scanner to read vitals',
    themeClass: 'scanner-button--vitals',
  });
  const toolDock = createToolDock(xrayButton, vitalsButton);
  const { introOverlay, startButton } = createIntroOverlay();
  const { checklist, vitalsItem, injuryItem } = createChecklist();
  const { vitalsReadout, tempValue, bpmValue } = createVitalsReadout();
  const scanAlert = createScanAlert();
  const {
    endgameOverlay,
    passButton,
    destroyButton,
    temperatureValue,
    woundValue,
    findingsValue,
  } = createEndgameOverlay();
  const cleanupTasks = [];

  const listen = (target, eventName, handler, options) => {
    target.addEventListener(eventName, handler, options);
    cleanupTasks.push(() => target.removeEventListener(eventName, handler, options));
  };

  appElement.innerHTML = '';
  appElement.append(app.view, toolDock, checklist, vitalsReadout, endgameOverlay, introOverlay);

  const attachmentNames = collectAttachmentNames(skeletonSource);
  const textureSets = await loadTextureSets(attachmentNames);

  if (Object.keys(textureSets.naked).length === 0) {
    throw new Error('No *_naked textures were found in the images folder.');
  }

  const clothedSpineData = buildSpineData(textureSets.clothed);
  const nakedSpineData = buildSpineData({
    ...textureSets.clothed,
    ...textureSets.naked,
  });

  const clothedSpine = new Spine(clothedSpineData);
  const nakedSpine = new Spine(nakedSpineData);
  const animationName = clothedSpineData.animations[0]?.name;

  for (const spine of [clothedSpine, nakedSpine]) {
    spine.autoUpdate = false;
    spine.state.timeScale = 1;
  }

  if (animationName) {
    clothedSpine.state.setAnimation(0, animationName, true);
    nakedSpine.state.setAnimation(0, animationName, true);
  }

  clothedSpine.update(0);
  nakedSpine.update(0);

  const infectedSlot = clothedSpine.skeleton.findSlot(DETECTION_SLOT_NAME);
  const infectedAttachment = infectedSlot?.getAttachment();
  const vitalsHeadBone = clothedSpine.skeleton.findBone(VITALS_HEAD_BONE_NAME);
  const infectedBoneIndices = new Set(
    DETECTION_BONE_NAMES
      .map((boneName) => clothedSpine.skeleton.findBone(boneName)?.data?.index)
      .filter((boneIndex) => Number.isInteger(boneIndex)),
  );

  const characterContainer = new Container();
  const nakedLayer = new Container();
  const clothedLayer = new Container();
  const clothingMask = new Graphics();
  const revealMask = new Graphics();
  const scanFx = new Graphics();
  const spotlightRing = new Graphics();
  const pointer = {
    x: initialWidth / 2,
    y: initialHeight / 2,
    active: false,
    pointerType: 'mouse',
  };
  const releaseMask = {
    x: pointer.x,
    y: pointer.y,
    strength: 0,
    tool: TOOL_XRAY,
  };
  const toolButtons = {
    [TOOL_XRAY]: xrayButton,
    [TOOL_VITALS]: vitalsButton,
  };
  let revealRadius = 64;
  let activePointerId = null;
  let activeTool = TOOL_XRAY;
  let scanningTool = null;
  let scanClock = 0;
  let scanHitArmed = false;
  let infectionHideTimeoutId = null;
  let winRevealTimeoutId = null;
  let layoutFrameId = null;
  let resizeObserver = null;
  let destroyed = false;
  let gameWon = false;
  let endgameVisible = false;
  let inspectionStarted = false;
  let appVolumeLevel = sdk.volume ?? 1;
  const taskState = {
    vitals: {
      done: false,
      detail: 'Pending',
      temperature: null,
    },
    injury: {
      done: false,
      detail: 'Pending',
      found: null,
    },
  };
  let characterScreenBounds = {
    x: 0,
    y: 0,
    width: initialWidth,
    height: initialHeight,
  };
  const vitalsDisplayState = {
    temperature: 0,
    bpm: 0,
    signal: 0,
    pace: GREEN,
    heartbeatOffset: 0,
    heartbeatVelocity: 180 / GREEN,
    readoutLeft: initialWidth / 2 - 95,
    readoutTop: initialHeight / 2 + 34,
    state: 'idle',
  };
  const heartbeatAudioState = {
    context: null,
    masterGain: null,
    nextBeatAt: 0,
    enabled: false,
    bpm: BASE_HEART_RATE,
    unlockRequested: false,
  };
  const buildInfectedZone = (
    attachment,
    targetBoneIndexSet,
    minWeight = DETECTION_WEIGHT_THRESHOLD,
  ) => {
    if (!attachment?.bones?.length || !attachment?.triangles?.length) {
      return { vertexIndices: [], edges: [] };
    }

    const selectedVertices = new Set();
    let boneCursor = 0;
    let weightCursor = 0;
    const vertexCount = attachment.worldVerticesLength / 2;

    for (let vertexIndex = 0; vertexIndex < vertexCount; vertexIndex += 1) {
      const influenceCount = attachment.bones[boneCursor++];
      let maxTargetWeight = 0;

      for (let influenceIndex = 0; influenceIndex < influenceCount; influenceIndex += 1) {
        const boneIndex = attachment.bones[boneCursor++];
        const weight = attachment.vertices[weightCursor + 2];

        if (targetBoneIndexSet.has(boneIndex)) {
          maxTargetWeight = Math.max(maxTargetWeight, weight);
        }

        weightCursor += 3;
      }

      if (maxTargetWeight >= minWeight) {
        selectedVertices.add(vertexIndex);
      }
    }

    const infectedEdges = new Set();

    for (let triangleIndex = 0; triangleIndex < attachment.triangles.length; triangleIndex += 3) {
      const a = attachment.triangles[triangleIndex];
      const b = attachment.triangles[triangleIndex + 1];
      const c = attachment.triangles[triangleIndex + 2];

      if (selectedVertices.has(a) && selectedVertices.has(b) && selectedVertices.has(c)) {
        infectedEdges.add([Math.min(a, b), Math.max(a, b)].join(':'));
        infectedEdges.add([Math.min(b, c), Math.max(b, c)].join(':'));
        infectedEdges.add([Math.min(c, a), Math.max(c, a)].join(':'));
      }
    }

    return {
      vertexIndices: [...selectedVertices],
      edges: [...infectedEdges].map((edgeKey) => edgeKey.split(':').map(Number)),
    };
  };

  const infectedZone = buildInfectedZone(infectedAttachment, infectedBoneIndices);
  const infectedVertexIndexSet = new Set(infectedZone.vertexIndices);
  const infectedWorldVertices = infectedAttachment
    ? new Float32Array(infectedAttachment.worldVerticesLength)
    : null;

  nakedLayer.addChild(nakedSpine);
  nakedLayer.mask = revealMask;
  clothedLayer.addChild(clothedSpine);
  clothedLayer.mask = clothingMask;

  characterContainer.addChild(nakedLayer);
  characterContainer.addChild(clothedLayer);

  app.stage.addChild(characterContainer);
  app.stage.addChild(revealMask);
  app.stage.addChild(clothingMask);
  app.stage.addChild(scanFx);
  app.stage.addChild(spotlightRing);

  const updateToolState = () => {
    for (const [toolName, button] of Object.entries(toolButtons)) {
      button.classList.toggle('is-selected', toolName === activeTool);
      button.classList.toggle('is-active', pointer.active && scanningTool === toolName);
    }

    toolDock.classList.toggle('is-hidden', gameWon || !inspectionStarted);
    checklist.classList.toggle('is-hidden', gameWon || !inspectionStarted);
    appElement.dataset.tool = activeTool;
  };

  const renderChecklist = () => {
    for (const [taskName, state] of Object.entries(taskState)) {
      const item = taskName === 'vitals' ? vitalsItem : injuryItem;
      const detail = item.querySelector('.checklist__detail');

      item.dataset.complete = state.done ? 'true' : 'false';

      if (detail) {
        detail.textContent = state.detail;
      }
    }
  };

  const maybeFinishChecklist = () => {
    if (gameWon || !taskState.vitals.done || !taskState.injury.done) {
      return;
    }

    finishGameplay();
  };

  const renderEndgameSummary = () => {
    const recordedTemperature = taskState.vitals.temperature;
    const woundFound = taskState.injury.found;

    temperatureValue.textContent = Number.isFinite(recordedTemperature) && recordedTemperature > 0
      ? formatTemperature(recordedTemperature)
      : 'Not recorded';
    woundValue.textContent = woundFound === null
      ? 'Unknown'
      : woundFound
        ? 'Found'
        : 'Not found';
    findingsValue.textContent = woundFound === null
      ? 'Pending'
      : woundFound
        ? 'Anomaly found'
        : 'Nothing found';
  };

  const completeVitalsTask = (temperature) => {
    if (!Number.isFinite(temperature) || temperature <= 0 || taskState.vitals.done) {
      return;
    }

    taskState.vitals.done = true;
    taskState.vitals.temperature = temperature;
    taskState.vitals.detail = `${formatTemperature(temperature)} recorded`;
    renderChecklist();
    maybeFinishChecklist();
  };

  const completeInjuryTask = (foundInjury) => {
    if (taskState.injury.done) {
      return;
    }

    taskState.injury.done = true;
    taskState.injury.found = foundInjury;
    taskState.injury.detail = foundInjury ? 'Anomaly found' : 'Nothing found';
    renderChecklist();
    maybeFinishChecklist();
  };

  const setInspectionStarted = (started) => {
    inspectionStarted = started;
    introOverlay.classList.toggle('is-hidden', started);
    appElement.classList.toggle('is-ready', started);
    checklist.classList.toggle('is-hidden', !started || gameWon);
    updateToolState();
  };

  const setScanningState = (isActive, toolName = activeTool) => {
    pointer.active = isActive;

    if (isActive) {
      activeTool = toolName;
      scanningTool = toolName;
    } else {
      scanningTool = null;
    }

    updateToolState();
    appElement.classList.toggle('is-scanning', isActive);
  };

  const setFinishedState = (isFinished) => {
    gameWon = isFinished;
    toolDock.classList.toggle('is-hidden', isFinished || !inspectionStarted);
    checklist.classList.toggle('is-hidden', isFinished || !inspectionStarted);

    for (const button of Object.values(toolButtons)) {
      button.disabled = isFinished;
    }

    appElement.classList.toggle('is-finished', isFinished);
  };

  const setEndgameVisible = (isVisible) => {
    endgameVisible = isVisible;
    endgameOverlay.classList.toggle('is-visible', isVisible);
    appElement.classList.toggle('has-endgame', isVisible);
  };

  const setVitalsVisible = (isVisible) => {
    vitalsReadout.classList.toggle('is-visible', isVisible);
  };

  const ensureHeartbeatAudio = async () => {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;

    if (!AudioContextClass) {
      return null;
    }

    if (!heartbeatAudioState.context) {
      const context = new AudioContextClass();
      const masterGain = context.createGain();

      masterGain.gain.value = 0;
      masterGain.connect(context.destination);

      heartbeatAudioState.context = context;
      heartbeatAudioState.masterGain = masterGain;
    }

    if (heartbeatAudioState.context.state === 'suspended') {
      try {
        await heartbeatAudioState.context.resume();
      } catch {
        return heartbeatAudioState.context;
      }
    }

    return heartbeatAudioState.context;
  };

  const unlockHeartbeatAudio = () => {
    if (heartbeatAudioState.unlockRequested) {
      return;
    }

    heartbeatAudioState.unlockRequested = true;
    void ensureHeartbeatAudio().then(() => {
      heartbeatAudioState.unlockRequested = false;

      if (heartbeatAudioState.enabled && heartbeatAudioState.nextBeatAt <= 0) {
        primeHeartbeatAudio(heartbeatAudioState.bpm);
      }

      updateHeartbeatAudioGain();
    });
  };

  const updateHeartbeatAudioGain = () => {
    if (!heartbeatAudioState.context || !heartbeatAudioState.masterGain) {
      return;
    }

    const now = heartbeatAudioState.context.currentTime;
    const gainTarget = heartbeatAudioState.enabled
      ? HEARTBEAT_SOUND_VOLUME * clamp(appVolumeLevel, 0, 1)
      : 0;

    heartbeatAudioState.masterGain.gain.cancelScheduledValues(now);
    heartbeatAudioState.masterGain.gain.linearRampToValueAtTime(gainTarget, now + 0.06);
  };

  const getHeartbeatIntensity = (bpm) => clamp(
    (bpm - BASE_HEART_RATE) / Math.max(ALERT_HEART_RATE - BASE_HEART_RATE, 1),
    0,
    1,
  );

  const setHeartbeatAudioEnabled = (enabled, bpm = BASE_HEART_RATE) => {
    const nextEnabled = enabled;
    const nextBpm = Number.isFinite(bpm) ? Math.max(0, bpm) : BASE_HEART_RATE;
    const enabledChanged = heartbeatAudioState.enabled !== nextEnabled;
    const bpmChanged = Math.abs(heartbeatAudioState.bpm - nextBpm) >= 1;

    heartbeatAudioState.enabled = nextEnabled;
    heartbeatAudioState.bpm = nextBpm;

    if (!nextEnabled) {
      heartbeatAudioState.nextBeatAt = 0;
    } else {
      unlockHeartbeatAudio();

      if (enabledChanged) {
        primeHeartbeatAudio(nextBpm);
      }
    }

    if (enabledChanged || bpmChanged) {
      updateHeartbeatAudioGain();
    }
  };

  const triggerHeartbeatPulse = (startTime, frequency, duration, peakGain) => {
    if (!heartbeatAudioState.context || !heartbeatAudioState.masterGain || appVolumeLevel <= 0) {
      return;
    }

    const oscillator = heartbeatAudioState.context.createOscillator();
    const gainNode = heartbeatAudioState.context.createGain();
    const filter = heartbeatAudioState.context.createBiquadFilter();

    oscillator.type = 'triangle';
    oscillator.frequency.setValueAtTime(frequency, startTime);
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(28, frequency * 0.68), startTime + duration);

    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(320, startTime);
    filter.Q.value = 1.1;

    gainNode.gain.setValueAtTime(0.0001, startTime);
    gainNode.gain.exponentialRampToValueAtTime(Math.max(0.0002, peakGain), startTime + 0.012);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);

    oscillator.connect(filter);
    filter.connect(gainNode);
    gainNode.connect(heartbeatAudioState.masterGain);

    oscillator.start(startTime);
    oscillator.stop(startTime + duration + 0.02);
  };

  const primeHeartbeatAudio = (bpm = BASE_HEART_RATE) => {
    if (
      !heartbeatAudioState.context
      || !heartbeatAudioState.masterGain
      || heartbeatAudioState.context.state !== 'running'
      || appVolumeLevel <= 0
    ) {
      heartbeatAudioState.nextBeatAt = 0;
      return;
    }

    const safeBpm = Math.max(24, bpm || BASE_HEART_RATE);
    const beatInterval = 60 / safeBpm;
    const now = heartbeatAudioState.context.currentTime;
    const intensity = getHeartbeatIntensity(safeBpm);
    const firstBeatAt = now + 0.01;
    const secondBeatAt = firstBeatAt + HEARTBEAT_SOUND_DOUBLE_PULSE_DELAY;

    triggerHeartbeatPulse(firstBeatAt, 82 + intensity * 10, 0.11, 1.15 + intensity * 0.22);
    triggerHeartbeatPulse(secondBeatAt, 62 + intensity * 8, 0.085, 0.68 + intensity * 0.16);
    heartbeatAudioState.nextBeatAt = now + Math.min(beatInterval * 0.58, 0.42);
  };

  const updateHeartbeatAudio = () => {
    if (
      !heartbeatAudioState.enabled
      || !heartbeatAudioState.context
      || !heartbeatAudioState.masterGain
      || heartbeatAudioState.context.state !== 'running'
      || appVolumeLevel <= 0
    ) {
      return;
    }

    const bpm = Math.max(24, heartbeatAudioState.bpm || BASE_HEART_RATE);
    const beatInterval = 60 / bpm;
    const now = heartbeatAudioState.context.currentTime;

    if (heartbeatAudioState.nextBeatAt <= now) {
      heartbeatAudioState.nextBeatAt = now + 0.01;
    }

    while (heartbeatAudioState.nextBeatAt < now + 0.18) {
      const firstBeatAt = heartbeatAudioState.nextBeatAt;
      const secondBeatAt = firstBeatAt + HEARTBEAT_SOUND_DOUBLE_PULSE_DELAY;
      const intensity = getHeartbeatIntensity(bpm);

      triggerHeartbeatPulse(firstBeatAt, 82 + intensity * 10, 0.11, 1.15 + intensity * 0.22);
      triggerHeartbeatPulse(secondBeatAt, 62 + intensity * 8, 0.085, 0.68 + intensity * 0.16);
      heartbeatAudioState.nextBeatAt += beatInterval;
    }
  };

  const smoothVitalsReading = ({
    temperature = 0,
    bpm = 0,
    signal = 0,
    pace = GREEN,
    state = 'idle',
  } = {}) => {
    const safeTemperature = Number.isFinite(temperature) ? temperature : 0;
    const safeBpm = Number.isFinite(bpm) ? bpm : 0;
    const safeSignal = Number.isFinite(signal) ? clamp(signal, 0, 1) : 0;
    const safePace = Number.isFinite(pace) ? Math.max(pace, 0.05) : GREEN;
    const isIdle = state === 'idle' || (safeTemperature <= 0 && safeBpm <= 0);
    const blend = isIdle ? 0.24 : 0.15;

    vitalsDisplayState.temperature = lerp(vitalsDisplayState.temperature, safeTemperature, blend);
    vitalsDisplayState.bpm = lerp(vitalsDisplayState.bpm, safeBpm, blend);
    vitalsDisplayState.signal = lerp(vitalsDisplayState.signal, safeSignal, blend * 0.92);
    vitalsDisplayState.pace = lerp(vitalsDisplayState.pace, safePace, blend * 0.65);

    if (vitalsDisplayState.temperature < 0.04) {
      vitalsDisplayState.temperature = 0;
    }

    if (vitalsDisplayState.bpm < 0.4) {
      vitalsDisplayState.bpm = 0;
    }

    if (vitalsDisplayState.signal < 0.015) {
      vitalsDisplayState.signal = 0;
    }

    if (vitalsDisplayState.temperature === 0 && vitalsDisplayState.bpm === 0) {
      vitalsDisplayState.state = 'idle';
    } else if (vitalsDisplayState.signal > 0.62) {
      vitalsDisplayState.state = 'alert';
    } else if (vitalsDisplayState.signal > 0.26) {
      vitalsDisplayState.state = 'elevated';
    } else {
      vitalsDisplayState.state = 'stable';
    }

    return {
      temperature: vitalsDisplayState.temperature,
      bpm: vitalsDisplayState.bpm,
      signal: vitalsDisplayState.signal,
      pace: vitalsDisplayState.pace,
      state: vitalsDisplayState.state,
    };
  };

  const updateVitalsReadout = ({
    temperature = BASE_BODY_TEMP,
    bpm = BASE_HEART_RATE,
    state = 'idle',
    signal = 0,
    pace = GREEN,
  } = {}) => {
    const safeTemperature = Number.isFinite(temperature) ? temperature : 0;
    const safeBpm = Number.isFinite(bpm) ? Math.max(0, Math.round(bpm)) : 0;
    const safeSignal = Number.isFinite(signal) ? clamp(signal, 0, 1) : 0;
    const safeState = ['idle', 'stable', 'elevated', 'alert'].includes(state) ? state : 'idle';

    tempValue.textContent = `TEMP ${formatTemperature(safeTemperature)}`;
    bpmValue.textContent = `BPM ${safeBpm}`;
    vitalsReadout.dataset.state = safeState;
    vitalsReadout.style.setProperty('--signal-strength', safeSignal.toFixed(3));
    vitalsReadout.style.setProperty('--pulse-scale', '1');
    vitalsReadout.style.setProperty('--heartbeat-offset', `${vitalsDisplayState.heartbeatOffset.toFixed(2)}px`);
  };

  const updateHeartbeatWave = (deltaSeconds) => {
    const safeDeltaSeconds = Number.isFinite(deltaSeconds) ? Math.max(deltaSeconds, 0) : 0;
    const currentPace = Number.isFinite(vitalsDisplayState.pace)
      ? Math.max(vitalsDisplayState.pace, 0.05)
      : GREEN;
    const targetVelocity = 180 / currentPace;
    const blend = clamp(safeDeltaSeconds * 4.8, 0, 1);

    vitalsDisplayState.heartbeatVelocity = lerp(
      vitalsDisplayState.heartbeatVelocity,
      targetVelocity,
      blend,
    );
    vitalsDisplayState.heartbeatOffset -= vitalsDisplayState.heartbeatVelocity * safeDeltaSeconds;

    if (vitalsDisplayState.heartbeatOffset <= -180) {
      vitalsDisplayState.heartbeatOffset %= 180;
    }

    vitalsReadout.style.setProperty('--heartbeat-offset', `${vitalsDisplayState.heartbeatOffset.toFixed(2)}px`);
  };

  const positionVitalsReadout = (x, y, radius, alpha = 1) => {
    const readoutWidth = 190;
    const readoutHeight = 56;
    const targetLeft = clamp(
      x - readoutWidth / 2,
      10,
      app.screen.width - readoutWidth - 10,
    );
    const targetTop = clamp(
      y + Math.max(34, radius * 0.96),
      10,
      app.screen.height - readoutHeight - 10,
    );
    const blend = pointer.active ? 0.18 : 0.12;

    vitalsDisplayState.readoutLeft = lerp(vitalsDisplayState.readoutLeft, targetLeft, blend);
    vitalsDisplayState.readoutTop = lerp(vitalsDisplayState.readoutTop, targetTop, blend);

    vitalsReadout.style.left = `${vitalsDisplayState.readoutLeft}px`;
    vitalsReadout.style.top = `${vitalsDisplayState.readoutTop}px`;
    vitalsReadout.style.setProperty('--readout-alpha', alpha.toFixed(3));

    return {
      left: vitalsDisplayState.readoutLeft,
      top: vitalsDisplayState.readoutTop,
    };
  };

  const getScanLiftOffset = (pointerType) => {
    if (pointerType === 'touch') {
      return Math.max(TOUCH_SCAN_LIFT_MIN, revealRadius * TOUCH_SCAN_LIFT_FACTOR);
    }

    if (pointerType === 'pen') {
      return Math.max(PEN_SCAN_LIFT_MIN, revealRadius * PEN_SCAN_LIFT_FACTOR);
    }

    return 0;
  };

  const updatePointerFromEvent = (event) => {
    if (activePointerId !== null && event.pointerId !== activePointerId) {
      return;
    }

    const nextPoint = getRendererPointFromClient(app, event.clientX, event.clientY);
    const pointerType = event.pointerType || pointer.pointerType || 'mouse';
    const liftOffset = getScanLiftOffset(pointerType);

    pointer.pointerType = pointerType;
    pointer.x = nextPoint.x;
    pointer.y = clamp(nextPoint.y - liftOffset, 0, app.screen.height);
  };

  const showInfectedAlert = () => {
    if (infectionHideTimeoutId !== null) {
      window.clearTimeout(infectionHideTimeoutId);
      infectionHideTimeoutId = null;
    }
  };

  const finishGameplay = () => {
    if (destroyed) {
      return;
    }

    if (winRevealTimeoutId !== null) {
      window.clearTimeout(winRevealTimeoutId);
      winRevealTimeoutId = null;
    }

    setFinishedState(true);
    setScanningState(false);
    releaseMask.strength = 0;
    renderEndgameSummary();
    setEndgameVisible(true);

    if (!sdk.isFinished) {
      sdk.finish();
    }
  };

  const handleWin = () => {
    if (gameWon) {
      return;
    }

    finishGameplay();
  };

  const handleInstall = (event) => {
    event?.preventDefault();
    event?.stopPropagation();
    sdk.install();
  };

  const distanceToSegmentSquared = (px, py, x1, y1, x2, y2) => {
    const segmentDx = x2 - x1;
    const segmentDy = y2 - y1;

    if (segmentDx === 0 && segmentDy === 0) {
      const pointDx = px - x1;
      const pointDy = py - y1;

      return pointDx * pointDx + pointDy * pointDy;
    }

    const t = clamp(
      ((px - x1) * segmentDx + (py - y1) * segmentDy) / (segmentDx * segmentDx + segmentDy * segmentDy),
      0,
      1,
    );
    const closestX = x1 + segmentDx * t;
    const closestY = y1 + segmentDy * t;
    const dx = px - closestX;
    const dy = py - closestY;

    return dx * dx + dy * dy;
  };

  const transformToScreenX = (matrix, x, y) => matrix.a * x + matrix.c * y + matrix.tx;
  const transformToScreenY = (matrix, x, y) => matrix.b * x + matrix.d * y + matrix.ty;

  const getInfectedScreenData = () => {
    if (
      !infectedSlot
      || !infectedAttachment
      || infectedZone.vertexIndices.length === 0
      || !infectedWorldVertices
    ) {
      return null;
    }

    infectedAttachment.computeWorldVertices(
      infectedSlot,
      0,
      infectedAttachment.worldVerticesLength,
      infectedWorldVertices,
      0,
      2,
    );

    const matrix = characterContainer.worldTransform;
    const screenVertexMap = new Map();
    const screenVertices = new Float32Array(infectedWorldVertices.length);
    let sumX = 0;
    let sumY = 0;
    const headPoints = [];

    for (let vertexIndex = 0; vertexIndex < infectedAttachment.worldVerticesLength / 2; vertexIndex += 1) {
      const x = transformToScreenX(
        matrix,
        infectedWorldVertices[vertexIndex * 2],
        infectedWorldVertices[vertexIndex * 2 + 1],
      );
      const y = transformToScreenY(
        matrix,
        infectedWorldVertices[vertexIndex * 2],
        infectedWorldVertices[vertexIndex * 2 + 1],
      );

      screenVertices[vertexIndex * 2] = x;
      screenVertices[vertexIndex * 2 + 1] = y;

      if (infectedVertexIndexSet.has(vertexIndex)) {
        screenVertexMap.set(vertexIndex, { x, y });
        sumX += x;
        sumY += y;
      }

    }

    if (vitalsHeadBone) {
      const headLength = vitalsHeadBone.data.length || 0;
      const headMatrix = vitalsHeadBone.matrix;
      const sampleSteps = [0.15, 0.3, 0.45, 0.6, 0.78, 0.95];

      for (const step of sampleSteps) {
        const sampleX = vitalsHeadBone.worldX + headMatrix.a * headLength * step;
        const sampleY = vitalsHeadBone.worldY + headMatrix.b * headLength * step;

        if (Number.isFinite(sampleX) && Number.isFinite(sampleY)) {
          headPoints.push({
            x: transformToScreenX(matrix, sampleX, sampleY),
            y: transformToScreenY(matrix, sampleX, sampleY),
          });
        }
      }
    }

    const headCenter = headPoints.length > 0
      ? {
        x: headPoints.reduce((sum, point) => sum + point.x, 0) / headPoints.length,
        y: headPoints.reduce((sum, point) => sum + point.y, 0) / headPoints.length,
      }
      : null;

    return {
      screenVertices,
      screenVertexMap,
      headCenter,
      headPoints,
      center: infectedZone.vertexIndices.length > 0
        ? {
          x: sumX / infectedZone.vertexIndices.length,
          y: sumY / infectedZone.vertexIndices.length,
        }
        : null,
    };
  };

  const getVitalsHeadScreenData = () => {
    if (!vitalsHeadBone) {
      return null;
    }

    const matrix = characterContainer.worldTransform;
    const boneLength = Math.max(vitalsHeadBone.data.length || 0, 42);
    const boneMatrix = vitalsHeadBone.matrix;
    const rootX = vitalsHeadBone.worldX;
    const rootY = vitalsHeadBone.worldY;
    const tipX = rootX + boneMatrix.a * boneLength;
    const tipY = rootY + boneMatrix.b * boneLength;

    if (
      !Number.isFinite(rootX)
      || !Number.isFinite(rootY)
      || !Number.isFinite(tipX)
      || !Number.isFinite(tipY)
    ) {
      return null;
    }

    const root = {
      x: transformToScreenX(matrix, rootX, rootY),
      y: transformToScreenY(matrix, rootX, rootY),
    };
    const tip = {
      x: transformToScreenX(matrix, tipX, tipY),
      y: transformToScreenY(matrix, tipX, tipY),
    };
    const directionX = tip.x - root.x;
    const directionY = tip.y - root.y;

    if (!Number.isFinite(directionX) || !Number.isFinite(directionY)) {
      return null;
    }

    const directionLength = Math.hypot(directionX, directionY) || 1;
    const normalX = -directionY / directionLength;
    const normalY = directionX / directionLength;
    const center = {
      x: root.x + directionX * 0.56,
      y: root.y + directionY * 0.56,
    };
    const samples = [];
    const steps = [0.14, 0.3, 0.46, 0.62, 0.78, 0.94];

    for (const step of steps) {
      const alongX = root.x + directionX * step;
      const alongY = root.y + directionY * step;
      const sideSpread = Math.max(10, directionLength * (0.2 - step * 0.05));

      if (Number.isFinite(alongX) && Number.isFinite(alongY)) {
        samples.push({ x: alongX, y: alongY });
        samples.push({
          x: alongX + normalX * sideSpread,
          y: alongY + normalY * sideSpread,
        });
        samples.push({
          x: alongX - normalX * sideSpread,
          y: alongY - normalY * sideSpread,
        });
      }
    }

    return {
      root,
      tip,
      center,
      samples,
      length: directionLength,
    };
  };

  const hasInfectedHit = () => {
    const infectedScreenData = getInfectedScreenData();

    if (!infectedScreenData) {
      return false;
    }
    const hitRadius = revealRadius + 10;
    const hitRadiusSquared = hitRadius * hitRadius;
    const { screenVertexMap } = infectedScreenData;

    for (const { x, y } of screenVertexMap.values()) {
      const dx = x - pointer.x;
      const dy = y - pointer.y;

      if (dx * dx + dy * dy <= hitRadiusSquared) {
        return true;
      }
    }

    return infectedZone.edges.some(([vertexA, vertexB]) => {
      const pointA = screenVertexMap.get(vertexA);
      const pointB = screenVertexMap.get(vertexB);

      if (!pointA || !pointB) {
        return false;
      }

      return distanceToSegmentSquared(
        pointer.x,
        pointer.y,
        pointA.x,
        pointA.y,
        pointB.x,
        pointB.y,
      ) <= hitRadiusSquared;
    });
  };

  const getDistanceToRect = (x, y, bounds) => {
    const dx = Math.max(bounds.x - x, 0, x - (bounds.x + bounds.width));
    const dy = Math.max(bounds.y - y, 0, y - (bounds.y + bounds.height));

    return Math.hypot(dx, dy);
  };

  const hasVitalsBodyContact = (scanX, scanY) => {
    const paddedBounds = {
      x: characterScreenBounds.x - revealRadius * 0.12,
      y: characterScreenBounds.y - revealRadius * 0.12,
      width: characterScreenBounds.width + revealRadius * 0.24,
      height: characterScreenBounds.height + revealRadius * 0.24,
    };

    return getDistanceToRect(scanX, scanY, paddedBounds) <= Math.max(12, revealRadius * 0.18);
  };

  const getVitalsReading = (scanX, scanY, time) => {
    if (!hasVitalsBodyContact(scanX, scanY)) {
      return {
        temperature: 0,
        bpm: 0,
        state: 'idle',
        signal: 0,
        pace: GREEN,
      };
    }

    const headScreenData = getVitalsHeadScreenData();
    const segmentDistance = headScreenData
      ? Math.sqrt(
        distanceToSegmentSquared(
          scanX,
          scanY,
          headScreenData.root.x,
          headScreenData.root.y,
          headScreenData.tip.x,
          headScreenData.tip.y,
        ),
      )
      : Infinity;
    const sampleDistance = headScreenData?.samples.length
      ? Math.min(...headScreenData.samples.map(({ x, y }) => Math.hypot(scanX - x, scanY - y)))
      : Infinity;
    const centerDistance = headScreenData?.center
      ? Math.hypot(scanX - headScreenData.center.x, scanY - headScreenData.center.y)
      : Infinity;
    const headDistance = Math.min(segmentDistance, sampleDistance, centerDistance);
    const headReach = headScreenData
      ? Math.max(revealRadius * 1.95, headScreenData.length * 0.72)
      : Math.max(revealRadius * 1.95, 1);
    const headSignal = Number.isFinite(headDistance) && Number.isFinite(headReach) && headReach > 0
      ? clamp(1 - headDistance / headReach, 0, 1)
      : 0;
    const pulseWave = 0.5 + 0.5 * Math.sin(time * (5.8 + headSignal * 3.4));
    const shimmer = Math.sin(time * 14.2) * 0.035;
    const temperature = BASE_BODY_TEMP
      + (ALERT_BODY_TEMP - BASE_BODY_TEMP) * headSignal
      + (pulseWave - 0.5) * 0.12
      + shimmer;
    const bpm = Math.round(
      BASE_HEART_RATE
      + (ALERT_HEART_RATE - BASE_HEART_RATE) * headSignal
      + Math.max(0, pulseWave - 0.45) * 5,
    );

    if (!Number.isFinite(temperature) || !Number.isFinite(bpm)) {
      return {
        temperature: BASE_BODY_TEMP,
        bpm: BASE_HEART_RATE,
        state: 'stable',
        signal: 0.12,
        pace: GREEN,
      };
    }

    if (headSignal > 0.62) {
      return {
        temperature,
        bpm,
        state: 'alert',
        signal: headSignal,
        pace: RED,
      };
    }

    if (headSignal > 0.26) {
      return {
        temperature,
        bpm,
        state: 'elevated',
        signal: headSignal,
        pace: YELLOW,
      };
    }

    return {
      temperature,
      bpm,
      state: 'stable',
      signal: 0.14 + headSignal * 0.12,
      pace: GREEN,
    };
  };

  const drawXrayOverlay = (revealX, revealY, displayRadius, fxAlpha, time) => {
    const pulse = 0.5 + 0.5 * Math.sin(time * 3.6);
    const innerPulse = displayRadius * (0.22 + pulse * 0.025);
    const sweepOffset = ((time * 120) % (displayRadius * 2 + 30)) - displayRadius - 15;

    scanFx.beginFill(0x63f0ff, (0.08 + pulse * 0.02) * fxAlpha);
    scanFx.drawCircle(revealX, revealY, Math.max(displayRadius - 2, 0));
    scanFx.endFill();

    for (let y = -displayRadius + 6; y <= displayRadius - 6; y += 8) {
      const halfWidth = Math.sqrt(Math.max(0, displayRadius * displayRadius - y * y));
      const distanceToSweep = Math.abs(y - sweepOffset);
      const alpha = 0.035 + Math.max(0, 0.2 - distanceToSweep * 0.014);

      if (alpha <= 0.04) {
        continue;
      }

      scanFx.lineStyle(distanceToSweep < 5 ? 2 : 1, 0x96fbff, Math.min(alpha, 0.24) * fxAlpha);
      scanFx.moveTo(revealX - halfWidth + 5, revealY + y);
      scanFx.lineTo(revealX + halfWidth - 5, revealY + y);
    }

    scanFx.lineStyle(1.5, 0xffffff, (0.3 + pulse * 0.18) * fxAlpha);
    scanFx.drawCircle(revealX, revealY, innerPulse);

    scanFx.lineStyle(1, 0x8efcff, 0.65 * fxAlpha);
    scanFx.moveTo(revealX - innerPulse * 0.45, revealY);
    scanFx.lineTo(revealX + innerPulse * 0.45, revealY);
    scanFx.moveTo(revealX, revealY - innerPulse * 0.45);
    scanFx.lineTo(revealX, revealY + innerPulse * 0.45);

    spotlightRing.lineStyle(2.4, 0xffd89a, 0.94 * fxAlpha);
    spotlightRing.beginFill(0xffefc2, 0.07 * fxAlpha);
    spotlightRing.drawCircle(revealX, revealY, displayRadius);
    spotlightRing.endFill();

    spotlightRing.lineStyle(1.6, 0x7ff3ff, 0.72 * fxAlpha);
    spotlightRing.arc(
      revealX,
      revealY,
      Math.max(displayRadius - 5, 0),
      time * 1.9,
      time * 1.9 + Math.PI * 0.92,
    );

    spotlightRing.lineStyle(1, 0xfff2d1, 0.44 * fxAlpha);
    spotlightRing.arc(
      revealX,
      revealY,
      Math.max(displayRadius - 11, 0),
      -time * 1.4,
      -time * 1.4 + Math.PI * 0.58,
    );
  };

  const drawVitalsOverlay = (revealX, revealY, displayRadius, fxAlpha, time, reading) => {
    const beatSpeed = (reading.bpm / 60) * Math.PI * 2;
    const beatPulse = 0.5 + 0.5 * Math.sin(time * beatSpeed);
    const heatIntensity = clamp((reading.temperature - BASE_BODY_TEMP) / (ALERT_BODY_TEMP - BASE_BODY_TEMP), 0, 1);
    const arm = Math.max(16, displayRadius * 0.42);
    const gap = Math.max(6, displayRadius * 0.14);
    const cornerOffset = Math.max(8, displayRadius * 0.2);
    const cornerReach = arm + cornerOffset;
    const sweepY = (((time * 170) % (arm * 2.1)) - arm * 1.05) * 0.6;
    const accentColor = reading.state === 'alert'
      ? 0xff5a5a
      : reading.state === 'elevated'
        ? 0xffc84d
        : 0x68ff8f;
    const mainColor = reading.state === 'alert'
      ? 0xff2323
      : reading.state === 'elevated'
        ? 0xff9a1f
        : 0x11d46b;

    scanFx.lineStyle(4.2, 0x07110a, 0.28 * fxAlpha);
    scanFx.moveTo(revealX - arm, revealY);
    scanFx.lineTo(revealX - gap, revealY);
    scanFx.moveTo(revealX + gap, revealY);
    scanFx.lineTo(revealX + arm, revealY);
    scanFx.moveTo(revealX, revealY - arm);
    scanFx.lineTo(revealX, revealY - gap);
    scanFx.moveTo(revealX, revealY + gap);
    scanFx.lineTo(revealX, revealY + arm);

    scanFx.lineStyle(2.1, accentColor, (0.82 + beatPulse * 0.16) * fxAlpha);
    scanFx.moveTo(revealX - arm, revealY);
    scanFx.lineTo(revealX - gap, revealY);
    scanFx.moveTo(revealX + gap, revealY);
    scanFx.lineTo(revealX + arm, revealY);
    scanFx.moveTo(revealX, revealY - arm);
    scanFx.lineTo(revealX, revealY - gap);
    scanFx.moveTo(revealX, revealY + gap);
    scanFx.lineTo(revealX, revealY + arm);

    spotlightRing.lineStyle(3.2, 0x07110a, 0.22 * fxAlpha);
    spotlightRing.moveTo(revealX - cornerReach, revealY - cornerReach + cornerOffset);
    spotlightRing.lineTo(revealX - cornerReach, revealY - cornerReach);
    spotlightRing.lineTo(revealX - cornerReach + cornerOffset, revealY - cornerReach);
    spotlightRing.moveTo(revealX + cornerReach - cornerOffset, revealY - cornerReach);
    spotlightRing.lineTo(revealX + cornerReach, revealY - cornerReach);
    spotlightRing.lineTo(revealX + cornerReach, revealY - cornerReach + cornerOffset);
    spotlightRing.moveTo(revealX - cornerReach, revealY + cornerReach - cornerOffset);
    spotlightRing.lineTo(revealX - cornerReach, revealY + cornerReach);
    spotlightRing.lineTo(revealX - cornerReach + cornerOffset, revealY + cornerReach);
    spotlightRing.moveTo(revealX + cornerReach - cornerOffset, revealY + cornerReach);
    spotlightRing.lineTo(revealX + cornerReach, revealY + cornerReach);
    spotlightRing.lineTo(revealX + cornerReach, revealY + cornerReach - cornerOffset);

    spotlightRing.lineStyle(1.8, mainColor, (0.72 + heatIntensity * 0.2) * fxAlpha);
    spotlightRing.moveTo(revealX - cornerReach, revealY - cornerReach + cornerOffset);
    spotlightRing.lineTo(revealX - cornerReach, revealY - cornerReach);
    spotlightRing.lineTo(revealX - cornerReach + cornerOffset, revealY - cornerReach);
    spotlightRing.moveTo(revealX + cornerReach - cornerOffset, revealY - cornerReach);
    spotlightRing.lineTo(revealX + cornerReach, revealY - cornerReach);
    spotlightRing.lineTo(revealX + cornerReach, revealY - cornerReach + cornerOffset);
    spotlightRing.moveTo(revealX - cornerReach, revealY + cornerReach - cornerOffset);
    spotlightRing.lineTo(revealX - cornerReach, revealY + cornerReach);
    spotlightRing.lineTo(revealX - cornerReach + cornerOffset, revealY + cornerReach);
    spotlightRing.moveTo(revealX + cornerReach - cornerOffset, revealY + cornerReach);
    spotlightRing.lineTo(revealX + cornerReach, revealY + cornerReach);
    spotlightRing.lineTo(revealX + cornerReach, revealY + cornerReach - cornerOffset);

    scanFx.lineStyle(1.2, reading.state === 'alert' ? 0xffd4d4 : 0xbfffd2, (0.36 + heatIntensity * 0.34) * fxAlpha);
    scanFx.moveTo(revealX - arm * 0.92, revealY + sweepY);
    scanFx.lineTo(revealX + arm * 0.92, revealY + sweepY);

    scanFx.lineStyle(2, accentColor, (0.66 + beatPulse * 0.18) * fxAlpha);
    scanFx.moveTo(revealX - 2, revealY);
    scanFx.lineTo(revealX + 2, revealY);
    scanFx.moveTo(revealX, revealY - 2);
    scanFx.lineTo(revealX, revealY + 2);

    positionVitalsReadout(revealX, revealY, displayRadius, fxAlpha);
  };

  const drawSpotlight = (time = 0) => {
    revealMask.clear();
    clothingMask.clear();
    scanFx.clear();
    spotlightRing.clear();
    setVitalsVisible(false);

    const revealStrength = pointer.active ? 1 : releaseMask.strength;
    const hasVisibleReveal = revealStrength > 0.001;
    const revealX = pointer.active ? pointer.x : releaseMask.x;
    const revealY = pointer.active ? pointer.y : releaseMask.y;
    const activeRevealTool = pointer.active ? scanningTool : releaseMask.tool;
    const revealEase = pointer.active
      ? 1
      : revealStrength * (2 - revealStrength);
    const displayRadius = revealRadius * revealEase;

    clothingMask.beginFill(0xffffff, 1);
    clothingMask.drawRect(0, 0, app.screen.width, app.screen.height);

    if (hasVisibleReveal && activeRevealTool === TOOL_XRAY) {
      revealMask.beginFill(0xffffff, 1);
      revealMask.drawCircle(revealX, revealY, displayRadius);
      revealMask.endFill();

      clothingMask.beginHole();
      clothingMask.drawCircle(revealX, revealY, displayRadius);
      clothingMask.endHole();
    }

    clothingMask.endFill();

    if (!hasVisibleReveal) {
      setHeartbeatAudioEnabled(false);
      return;
    }

    const fxAlpha = pointer.active ? 1 : revealStrength;

    if (activeRevealTool === TOOL_VITALS) {
      const vitals = smoothVitalsReading(getVitalsReading(revealX, revealY, time));

      setHeartbeatAudioEnabled(true, vitals.bpm);
      updateVitalsReadout(vitals);
      setVitalsVisible(true);
      drawVitalsOverlay(revealX, revealY, displayRadius, fxAlpha, time, vitals);
      return;
    }

    setHeartbeatAudioEnabled(false);
    drawXrayOverlay(revealX, revealY, displayRadius, fxAlpha, time);
  };

  const layout = () => {
    const currentBounds = mergeBounds(
      clothedSpine.getLocalBounds(),
      nakedSpine.getLocalBounds(),
    );
    const isPortrait = app.screen.height >= app.screen.width;
    const widthRatio = isPortrait ? 0.9 : 0.74;
    const heightRatio = isPortrait ? 0.82 : 0.84;
    const scale = Math.min(
      (app.screen.width * widthRatio) / Math.max(currentBounds.width, 1),
      (app.screen.height * heightRatio) / Math.max(currentBounds.height, 1),
    );

    characterContainer.pivot.set(
      currentBounds.x + currentBounds.width / 2,
      currentBounds.y + currentBounds.height / 2,
    );
    characterContainer.scale.set(scale);
    characterContainer.position.set(
      app.screen.width / 2,
      app.screen.height / 2,
    );
    characterScreenBounds = {
      x: characterContainer.position.x + (currentBounds.x - characterContainer.pivot.x) * scale,
      y: characterContainer.position.y + (currentBounds.y - characterContainer.pivot.y) * scale,
      width: currentBounds.width * scale,
      height: currentBounds.height * scale,
    };
    app.stage.hitArea = new Rectangle(0, 0, app.screen.width, app.screen.height);
    pointer.x = clamp(pointer.x, 0, app.screen.width);
    pointer.y = clamp(pointer.y, 0, app.screen.height);
    revealRadius = Math.max(34, Math.min(72, Math.min(app.screen.width, app.screen.height) * 0.085));
    drawSpotlight(scanClock);
  };

  const scheduleLayout = () => {
    if (layoutFrameId !== null) {
      window.cancelAnimationFrame(layoutFrameId);
    }

    layoutFrameId = window.requestAnimationFrame(() => {
      layoutFrameId = null;
      layout();
    });
  };

  const resize = (nextWidth, nextHeight) => {
    if (destroyed) {
      return;
    }

    const safeWidth = getInitialDimension(nextWidth, appElement.clientWidth || window.innerWidth);
    const safeHeight = getInitialDimension(nextHeight, appElement.clientHeight || window.innerHeight);

    app.renderer.resize(safeWidth, safeHeight);
    scheduleLayout();
  };

  const stopScanning = (event) => {
    if (activePointerId === null) {
      return;
    }

    if (event?.pointerId !== undefined && event.pointerId !== activePointerId) {
      return;
    }

    if (event?.clientX !== undefined && event?.clientY !== undefined) {
      updatePointerFromEvent(event);
    }

    const currentTool = scanningTool;
    const hasInjuryHit = !gameWon
      && currentTool === TOOL_XRAY
      && event?.type === 'pointerup'
      && hasInfectedHit();
    const finalVitals = !gameWon
      && currentTool === TOOL_VITALS
      && event?.type === 'pointerup'
      ? getVitalsReading(pointer.x, pointer.y, scanClock)
      : null;

    releaseMask.x = pointer.x;
    releaseMask.y = pointer.y;
    releaseMask.strength = 1;
    releaseMask.tool = currentTool || activeTool;
    activePointerId = null;
    scanHitArmed = false;
    setScanningState(false);
    drawSpotlight(scanClock);

    if (currentTool === TOOL_VITALS && finalVitals) {
      completeVitalsTask(finalVitals.temperature);
    }

    if (currentTool === TOOL_XRAY && event?.type === 'pointerup') {
      completeInjuryTask(hasInjuryHit);
    }

  };

  listen(window, 'pointermove', (event) => {
    if (!pointer.active) {
      return;
    }

    updatePointerFromEvent(event);
  });

  listen(window, 'pointerdown', () => {
    unlockHeartbeatAudio();
  }, { capture: true });
  listen(window, 'keydown', () => {
    unlockHeartbeatAudio();
  }, { capture: true });
  listen(window, 'pointerup', stopScanning);
  listen(window, 'pointercancel', stopScanning);
  listen(window, 'blur', () => stopScanning());

  const startScanning = (toolName, button, event) => {
    event.preventDefault();

    if (activePointerId !== null || gameWon || !inspectionStarted) {
      return;
    }

    activePointerId = event.pointerId;
    activeTool = toolName;
    releaseMask.strength = 0;
    releaseMask.tool = toolName;
    scanHitArmed = false;
    button.setPointerCapture?.(event.pointerId);
    setScanningState(true, toolName);
    if (toolName === TOOL_VITALS) {
      unlockHeartbeatAudio();
    }
    updatePointerFromEvent(event);
    drawSpotlight(scanClock);
  };

  for (const [toolName, button] of Object.entries(toolButtons)) {
    listen(button, 'contextmenu', (event) => event.preventDefault());
    listen(button, 'pointerdown', (event) => {
      startScanning(toolName, button, event);
    });
  }

  listen(passButton, 'click', handleInstall);
  listen(destroyButton, 'click', handleInstall);
  listen(startButton, 'click', async (event) => {
    event.preventDefault();

    await ensureHeartbeatAudio();
    setInspectionStarted(true);
  });

  app.ticker.add(() => {
    const deltaSeconds = app.ticker.deltaMS / 1000;
    scanClock += deltaSeconds;

    clothedSpine.update(deltaSeconds);
    nakedSpine.update(deltaSeconds);

    if (pointer.active && scanningTool === TOOL_XRAY) {
      scanHitArmed = hasInfectedHit();
    } else if (releaseMask.strength > 0) {
      releaseMask.strength = Math.max(0, releaseMask.strength - deltaSeconds * RELEASE_MASK_FADE_SPEED);
    }

    drawSpotlight(scanClock);
    updateHeartbeatWave(deltaSeconds);
    updateHeartbeatAudio();
  });

  setFinishedState(false);
  setEndgameVisible(false);
  setScanningState(false);
  setInspectionStarted(false);
  renderChecklist();
  renderEndgameSummary();
  updateToolState();
  updateVitalsReadout();
  setVitalsVisible(false);
  appElement.dataset.volume = sdk.volume <= 0 ? 'muted' : 'unmuted';
  layout();

  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];

      if (!entry) {
        return;
      }

      resize(entry.contentRect.width, entry.contentRect.height);
    });

    resizeObserver.observe(appElement);
  }

  cleanupTasks.push(() => {
    if (layoutFrameId !== null) {
      window.cancelAnimationFrame(layoutFrameId);
      layoutFrameId = null;
    }

    if (infectionHideTimeoutId !== null) {
      window.clearTimeout(infectionHideTimeoutId);
      infectionHideTimeoutId = null;
    }

    if (winRevealTimeoutId !== null) {
      window.clearTimeout(winRevealTimeoutId);
      winRevealTimeoutId = null;
    }

    resizeObserver?.disconnect();
  });

  return {
    resize,
    pause: () => {
      stopScanning();
      setHeartbeatAudioEnabled(false);

      if (app.ticker.started) {
        app.ticker.stop();
      }
    },
    resume: () => {
      if (!app.ticker.started) {
        app.ticker.start();
      }

      scheduleLayout();
    },
    finish: () => {
      finishGameplay();
    },
    volume: (level) => {
      appVolumeLevel = level;
      appElement.dataset.volume = level <= 0 ? 'muted' : 'unmuted';
      updateHeartbeatAudioGain();
    },
    reset: () => {
      if (winRevealTimeoutId !== null) {
        window.clearTimeout(winRevealTimeoutId);
        winRevealTimeoutId = null;
      }

      stopScanning();
      setHeartbeatAudioEnabled(false);
      scanAlert.classList.remove('is-visible');
      releaseMask.strength = 0;
      releaseMask.tool = activeTool;
      scanHitArmed = false;
      appElement.dataset.volume = sdk.volume <= 0 ? 'muted' : 'unmuted';
      setFinishedState(false);
      setEndgameVisible(false);
      setInspectionStarted(false);
      taskState.vitals.done = false;
      taskState.vitals.detail = 'Pending';
      taskState.vitals.temperature = null;
      taskState.injury.done = false;
      taskState.injury.detail = 'Pending';
      taskState.injury.found = null;
      renderChecklist();
      renderEndgameSummary();
      setVitalsVisible(false);
      updateVitalsReadout();
      scheduleLayout();
    },
    destroy: () => {
      if (destroyed) {
        return;
      }

      destroyed = true;
      stopScanning();
      setHeartbeatAudioEnabled(false);

      if (heartbeatAudioState.context) {
        void heartbeatAudioState.context.close();
        heartbeatAudioState.context = null;
        heartbeatAudioState.masterGain = null;
      }

      while (cleanupTasks.length > 0) {
        cleanupTasks.pop()();
      }

      app.destroy(true, {
        children: true,
        texture: false,
        baseTexture: false,
      });
    },
  };
};
