import './style.css';
import { Application, Assets, Container, Graphics, Rectangle } from 'pixi.js';
import { TextureAtlas } from '@pixi-spine/base';
import { AtlasAttachmentLoader, SkeletonJson, Spine } from '@pixi-spine/runtime-3.8';
import skeletonSource from '../skeleton.json';
import scannerIconUrl from '../images/scanner.png';

const imageModules = import.meta.glob('../images/*.png', {
  eager: true,
  import: 'default',
});

const appElement = document.querySelector('#app');

appElement.innerHTML = '<div class="loading">Loading Pixi + Spine scene...</div>';

const hud = document.createElement('div');
hud.className = 'hud';
appElement.appendChild(hud);

const scannerButton = document.createElement('button');
scannerButton.className = 'scanner-button';
scannerButton.type = 'button';
scannerButton.setAttribute('aria-label', 'Hold scanner to scan');
scannerButton.innerHTML = `
  <span class="scanner-button__shine"></span>
  <img class="scanner-button__img" src="${scannerIconUrl}" alt="" draggable="false" />
  <span class="scanner-button__label">Scanner</span>
  <span class="scanner-button__hint">Hold and drag</span>
`;

const scanAlert = document.createElement('div');
scanAlert.className = 'scan-alert';
scanAlert.textContent = 'INFECTED';

const imageEntries = Object.entries(imageModules).map(([filePath, assetUrl]) => ({
  assetUrl,
  fileName: filePath.split('/').at(-1),
}));
const textureEntries = imageEntries.filter(({ fileName }) => fileName !== 'scanner.png');

// Edit this list to choose which bones define the infected scan zone.
const DETECTION_BONE_NAMES = ['cloth7'];
const DETECTION_SLOT_NAME = 'cloth';
const DETECTION_WEIGHT_THRESHOLD = 0.18;
const RELEASE_MASK_FADE_SPEED = 5.6;

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
    textureEntries.map(async ({ assetUrl, fileName }) => {
      const texture = await Assets.load(assetUrl);
      const baseName = fileName.replace(/\.png$/i, '');

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

const renderHud = ({ animationName, boneCount, slotCount, imageCount, revealRadius }) => {
  hud.innerHTML = `
    <strong>Spine Preview</strong>
    <span>animation: ${animationName ?? 'setup pose'}</span>
    <span>bones: ${boneCount}</span>
    <span>slots: ${slotCount}</span>
    <span>textures: ${imageCount}</span>
    <span>reveal radius: ${Math.round(revealRadius)}px</span>
    <span>hold scanner and drag to reveal</span>
  `;
};

const main = async () => {
  const app = new Application({
    antialias: true,
    autoDensity: true,
    backgroundAlpha: 0,
    resizeTo: window,
  });

  appElement.innerHTML = '';
  appElement.append(app.view, hud, scannerButton, scanAlert);

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
    x: window.innerWidth / 2,
    y: window.innerHeight / 2,
    active: false,
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
  let layoutFrameId = null;

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

  const updatePointerFromEvent = (event) => {
    if (activePointerId !== null && event.pointerId !== activePointerId) {
      return;
    }

    pointer.x = event.clientX;
    pointer.y = event.clientY;
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
    renderHud({
      animationName,
      boneCount: clothedSpineData.bones.length,
      slotCount: clothedSpineData.slots.length,
      imageCount: Object.keys(textureSets.clothed).length,
      revealRadius,
    });
  };

  const scheduleLayout = () => {
    if (layoutFrameId !== null) {
      window.cancelAnimationFrame(layoutFrameId);
    }

    layoutFrameId = window.requestAnimationFrame(() => {
      layoutFrameId = window.requestAnimationFrame(() => {
        layoutFrameId = null;
        layout();
      });
    });
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

    if (event?.type === 'pointerup' && (scanHitArmed || hasInfectedHit())) {
      showInfectedAlert();
    }

    releaseMask.x = pointer.x;
    releaseMask.y = pointer.y;
    releaseMask.strength = 1;
    activePointerId = null;
    scanHitArmed = false;
    setScanningState(false);
    drawSpotlight(scanClock);
  };

  scannerButton.addEventListener('pointerdown', (event) => {
    event.preventDefault();

    if (activePointerId !== null) {
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

  window.addEventListener('pointermove', (event) => {
    if (!pointer.active) {
      return;
    }

    updatePointerFromEvent(event);
  });

  window.addEventListener('pointerup', stopScanning);
  window.addEventListener('pointercancel', stopScanning);
  window.addEventListener('blur', () => stopScanning());
  scannerButton.addEventListener('contextmenu', (event) => event.preventDefault());

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

  setScanningState(false);
  layout();
  window.addEventListener('resize', scheduleLayout);
  window.addEventListener('orientationchange', scheduleLayout);
  window.visualViewport?.addEventListener('resize', scheduleLayout);
};

main().catch((error) => {
  console.error(error);
  appElement.innerHTML = `<div class="error">Failed to start Pixi/Spine preview.<br />${error.message}</div>`;
});
