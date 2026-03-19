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
const RELEASE_MASK_FADE_SPEED = 5.6;
const ENDGAME_REVEAL_DELAY_MS = 900;
const CTA_TITLE = 'SCAN COMPLETE';
const CTA_SUBTITLE = 'Infection confirmed. Start treatment now.';
const CTA_BUTTON_LABEL = 'INSTALL NOW';
const TOUCH_SCAN_LIFT_FACTOR = 1.35;
const TOUCH_SCAN_LIFT_MIN = 88;
const PEN_SCAN_LIFT_FACTOR = 0.8;
const PEN_SCAN_LIFT_MIN = 42;

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
    colorPixels[pixelIndex + 3] = Math.round(
      (alphaPixels[pixelIndex] + alphaPixels[pixelIndex + 1] + alphaPixels[pixelIndex + 2]) / 3,
    );
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

const createScannerButton = (iconUrl) => {
  const scannerButton = document.createElement('button');

  scannerButton.className = 'scanner-button';
  scannerButton.type = 'button';
  scannerButton.setAttribute('aria-label', 'Hold scanner to scan');
  scannerButton.innerHTML = `
    <span class="scanner-button__shine"></span>
    <img class="scanner-button__img" src="${iconUrl}" alt="" draggable="false" />
    <span class="scanner-button__label">Scanner</span>
    <span class="scanner-button__hint">Hold and drag</span>
  `;

  return scannerButton;
};

const createScanAlert = () => {
  const scanAlert = document.createElement('div');

  scanAlert.className = 'scan-alert';
  scanAlert.textContent = 'INFECTED';

  return scanAlert;
};

const createEndgameOverlay = () => {
  const endgameOverlay = document.createElement('div');

  endgameOverlay.className = 'endgame';
  endgameOverlay.innerHTML = `
    <div class="endgame__backdrop"></div>
    <div class="endgame__panel">
      <div class="endgame__eyebrow">Mission Complete</div>
      <h2 class="endgame__title">${CTA_TITLE}</h2>
      <p class="endgame__subtitle">${CTA_SUBTITLE}</p>
      <button class="endgame__cta" type="button">${CTA_BUTTON_LABEL}</button>
    </div>
  `;

  const ctaButton = endgameOverlay.querySelector('.endgame__cta');

  if (!(ctaButton instanceof HTMLButtonElement)) {
    throw new Error('Failed to create CTA button.');
  }

  return {
    endgameOverlay,
    ctaButton,
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
  const scannerButtonIconUrl = await loadUiAssetUrl(scannerIconUrl, scannerAlphaMaskUrl);
  const scannerButton = createScannerButton(scannerButtonIconUrl);
  const scanAlert = createScanAlert();
  const { endgameOverlay, ctaButton } = createEndgameOverlay();
  const cleanupTasks = [];

  const listen = (target, eventName, handler, options) => {
    target.addEventListener(eventName, handler, options);
    cleanupTasks.push(() => target.removeEventListener(eventName, handler, options));
  };

  appElement.innerHTML = '';
  appElement.append(app.view, scannerButton, scanAlert, endgameOverlay);

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
  const infectedBoneIndices = new Set(
    DETECTION_BONE_NAMES
      .map((boneName) => clothedSpine.skeleton.findBone(boneName)?.data?.index)
      .filter((boneIndex) => Number.isInteger(boneIndex)),
  );

  const characterContainer = new Container();
  const clothedLayer = new Container();
  const clothingMask = new Graphics();
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
  };
  let revealRadius = 64;
  let activePointerId = null;
  let scanClock = 0;
  let scanHitArmed = false;
  let infectionHideTimeoutId = null;
  let winRevealTimeoutId = null;
  let layoutFrameId = null;
  let resizeObserver = null;
  let destroyed = false;
  let gameWon = false;
  let endgameVisible = false;
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
  const infectedWorldVertices = infectedAttachment
    ? new Float32Array(infectedAttachment.worldVerticesLength)
    : null;

  clothedLayer.addChild(clothedSpine);
  clothedLayer.mask = clothingMask;

  characterContainer.addChild(nakedSpine);
  characterContainer.addChild(clothedLayer);

  app.stage.addChild(characterContainer);
  app.stage.addChild(clothingMask);
  app.stage.addChild(scanFx);
  app.stage.addChild(spotlightRing);

  const setScanningState = (isActive) => {
    pointer.active = isActive;
    scannerButton.classList.toggle('is-active', isActive);
    appElement.classList.toggle('is-scanning', isActive);
  };

  const setFinishedState = (isFinished) => {
    gameWon = isFinished;
    scannerButton.disabled = isFinished;
    scannerButton.classList.toggle('is-hidden', isFinished);
    appElement.classList.toggle('is-finished', isFinished);
  };

  const setEndgameVisible = (isVisible) => {
    endgameVisible = isVisible;
    endgameOverlay.classList.toggle('is-visible', isVisible);
    appElement.classList.toggle('has-endgame', isVisible);
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
    }

    scanAlert.classList.remove('is-visible');
    void scanAlert.offsetWidth;
    scanAlert.classList.add('is-visible');

    infectionHideTimeoutId = window.setTimeout(() => {
      scanAlert.classList.remove('is-visible');
      infectionHideTimeoutId = null;
    }, 1600);
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
    setEndgameVisible(true);

    if (!sdk.isFinished) {
      sdk.finish();
    }
  };

  const handleWin = () => {
    if (gameWon) {
      return;
    }

    showInfectedAlert();
    setFinishedState(true);

    if (winRevealTimeoutId !== null) {
      window.clearTimeout(winRevealTimeoutId);
    }

    winRevealTimeoutId = window.setTimeout(() => {
      winRevealTimeoutId = null;
      finishGameplay();
    }, ENDGAME_REVEAL_DELAY_MS);
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

  const hasInfectedHit = () => {
    if (
      !infectedSlot
      || !infectedAttachment
      || infectedZone.vertexIndices.length === 0
      || !infectedWorldVertices
    ) {
      return false;
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
    const hitRadius = revealRadius + 10;
    const hitRadiusSquared = hitRadius * hitRadius;

    const screenVertexMap = new Map();

    for (const vertexIndex of infectedZone.vertexIndices) {
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

      screenVertexMap.set(vertexIndex, { x, y });

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

  const drawSpotlight = (time = 0) => {
    clothingMask.clear();
    scanFx.clear();
    spotlightRing.clear();

    const revealStrength = pointer.active ? 1 : releaseMask.strength;
    const hasVisibleReveal = revealStrength > 0.001;
    const revealX = pointer.active ? pointer.x : releaseMask.x;
    const revealY = pointer.active ? pointer.y : releaseMask.y;
    const revealEase = pointer.active
      ? 1
      : revealStrength * (2 - revealStrength);
    const displayRadius = revealRadius * revealEase;

    clothingMask.beginFill(0xffffff, 1);
    clothingMask.drawRect(0, 0, app.screen.width, app.screen.height);

    if (hasVisibleReveal) {
      clothingMask.beginHole();
      clothingMask.drawCircle(revealX, revealY, displayRadius);
      clothingMask.endHole();
    }

    clothingMask.endFill();

    if (!hasVisibleReveal) {
      return;
    }

    const pulse = 0.5 + 0.5 * Math.sin(time * 3.6);
    const fxAlpha = pointer.active ? 1 : revealStrength;
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

    const shouldTriggerWin = !gameWon
      && event?.type === 'pointerup'
      && (scanHitArmed || hasInfectedHit());

    if (event?.pointerId !== undefined && event.pointerId !== activePointerId) {
      return;
    }

    if (event?.clientX !== undefined && event?.clientY !== undefined) {
      updatePointerFromEvent(event);
    }

    releaseMask.x = pointer.x;
    releaseMask.y = pointer.y;
    releaseMask.strength = 1;
    activePointerId = null;
    scanHitArmed = false;
    setScanningState(false);
    drawSpotlight(scanClock);

    if (shouldTriggerWin) {
      handleWin();
    }
  };

  listen(window, 'pointermove', (event) => {
    if (!pointer.active) {
      return;
    }

    updatePointerFromEvent(event);
  });

  listen(window, 'pointerup', stopScanning);
  listen(window, 'pointercancel', stopScanning);
  listen(window, 'blur', () => stopScanning());
  listen(scannerButton, 'contextmenu', (event) => event.preventDefault());
  listen(scannerButton, 'pointerdown', (event) => {
    event.preventDefault();

    if (activePointerId !== null || gameWon) {
      return;
    }

    activePointerId = event.pointerId;
    releaseMask.strength = 0;
    scanHitArmed = false;
    scannerButton.setPointerCapture?.(event.pointerId);
    setScanningState(true);
    updatePointerFromEvent(event);
    drawSpotlight(scanClock);
  });
  listen(ctaButton, 'click', handleInstall);
  listen(endgameOverlay, 'click', (event) => {
    if (
      event.target === endgameOverlay
      || (event.target instanceof Element && event.target.classList.contains('endgame__backdrop'))
    ) {
      handleInstall(event);
    }
  });

  app.ticker.add(() => {
    const deltaSeconds = app.ticker.deltaMS / 1000;
    scanClock += deltaSeconds;

    clothedSpine.update(deltaSeconds);
    nakedSpine.update(deltaSeconds);

    if (pointer.active) {
      scanHitArmed = scanHitArmed || hasInfectedHit();
    } else if (releaseMask.strength > 0) {
      releaseMask.strength = Math.max(0, releaseMask.strength - deltaSeconds * RELEASE_MASK_FADE_SPEED);
    }

    drawSpotlight(scanClock);
  });

  setFinishedState(false);
  setEndgameVisible(false);
  setScanningState(false);
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
      appElement.dataset.volume = level <= 0 ? 'muted' : 'unmuted';
    },
    reset: () => {
      if (winRevealTimeoutId !== null) {
        window.clearTimeout(winRevealTimeoutId);
        winRevealTimeoutId = null;
      }

      stopScanning();
      scanAlert.classList.remove('is-visible');
      releaseMask.strength = 0;
      scanHitArmed = false;
      appElement.dataset.volume = sdk.volume <= 0 ? 'muted' : 'unmuted';
      setFinishedState(false);
      setEndgameVisible(false);
      scheduleLayout();
    },
    destroy: () => {
      if (destroyed) {
        return;
      }

      destroyed = true;
      stopScanning();

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
