import './style.css';
import { Application, Assets, Container, Graphics, Rectangle } from 'pixi.js';
import { TextureAtlas } from '@pixi-spine/base';
import { AtlasAttachmentLoader, SkeletonJson, Spine } from '@pixi-spine/runtime-3.8';
import skeletonSource from '../skeleton.json';

const imageModules = import.meta.glob('../images/*.png', {
  eager: true,
  import: 'default',
});

const appElement = document.querySelector('#app');

appElement.innerHTML = '<div class="loading">Loading Pixi + Spine scene...</div>';

const hud = document.createElement('div');
hud.className = 'hud';
appElement.appendChild(hud);

const imageEntries = Object.entries(imageModules).map(([filePath, assetUrl]) => ({
  assetUrl,
  fileName: filePath.split('/').at(-1),
}));

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
    imageEntries.map(async ({ assetUrl, fileName }) => {
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

const renderHud = ({ animationName, boneCount, slotCount, imageCount, revealRadius }) => {
  hud.innerHTML = `
    <strong>Spine Preview</strong>
    <span>animation: ${animationName ?? 'setup pose'}</span>
    <span>bones: ${boneCount}</span>
    <span>slots: ${slotCount}</span>
    <span>textures: ${imageCount}</span>
    <span>reveal radius: ${Math.round(revealRadius)}px</span>
    <span>move cursor to reveal naked layer</span>
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
  appElement.append(app.view, hud);

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

  const modelBounds = mergeBounds(
    clothedSpine.getLocalBounds(),
    nakedSpine.getLocalBounds(),
  );

  const characterContainer = new Container();
  const clothedLayer = new Container();
  const clothingMask = new Graphics();
  const spotlightRing = new Graphics();
  const pointer = {
    x: window.innerWidth / 2,
    y: window.innerHeight / 2,
    active: true,
  };
  let revealRadius = 110;

  clothedLayer.addChild(clothedSpine);
  clothedLayer.mask = clothingMask;

  characterContainer.addChild(nakedSpine);
  characterContainer.addChild(clothedLayer);

  app.stage.addChild(characterContainer);
  app.stage.addChild(clothingMask);
  app.stage.addChild(spotlightRing);

  const drawSpotlight = () => {
    clothingMask.clear();
    spotlightRing.clear();

    clothingMask.beginFill(0xffffff, 1);
    clothingMask.drawRect(0, 0, app.screen.width, app.screen.height);

    if (pointer.active) {
      clothingMask.beginHole();
      clothingMask.drawCircle(pointer.x, pointer.y, revealRadius);
      clothingMask.endHole();
    }

    clothingMask.endFill();

    if (!pointer.active) {
      return;
    }

    spotlightRing.lineStyle(2, 0xffd89a, 0.95);
    spotlightRing.beginFill(0xffefc2, 0.08);
    spotlightRing.drawCircle(pointer.x, pointer.y, revealRadius);
    spotlightRing.endFill();
  };

  const layout = () => {
    const safeWidth = Math.max(modelBounds.width, 1);
    const safeHeight = Math.max(modelBounds.height, 1);
    const scale = Math.min(
      (app.screen.width * 0.7) / safeWidth,
      (app.screen.height * 0.82) / safeHeight,
    );

    characterContainer.scale.set(scale);
    characterContainer.position.set(
      app.screen.width / 2 - (modelBounds.x + modelBounds.width / 2) * scale,
      app.screen.height / 2 - (modelBounds.y + modelBounds.height / 2) * scale,
    );

    app.stage.hitArea = new Rectangle(0, 0, app.screen.width, app.screen.height);
    revealRadius = Math.max(25, Math.min(140, Math.min(app.screen.width, app.screen.height) * 0.13));
    drawSpotlight();
    renderHud({
      animationName,
      boneCount: clothedSpineData.bones.length,
      slotCount: clothedSpineData.slots.length,
      imageCount: Object.keys(textureSets.clothed).length,
      revealRadius,
    });
  };

  app.stage.eventMode = 'static';
  app.stage.hitArea = new Rectangle(0, 0, app.screen.width, app.screen.height);
  app.stage.on('pointermove', (event) => {
    pointer.x = event.global.x;
    pointer.y = event.global.y;
    pointer.active = true;
    drawSpotlight();
  });

  app.view.addEventListener('pointerleave', () => {
    pointer.active = false;
    drawSpotlight();
  });

  app.view.addEventListener('pointerenter', () => {
    pointer.active = true;
    drawSpotlight();
  });

  app.ticker.add(() => {
    const deltaSeconds = app.ticker.deltaMS / 1000;

    clothedSpine.update(deltaSeconds);
    nakedSpine.update(deltaSeconds);
  });

  layout();
  window.addEventListener('resize', layout);
};

main().catch((error) => {
  console.error(error);
  appElement.innerHTML = `<div class="error">Failed to start Pixi/Spine preview.<br />${error.message}</div>`;
});
