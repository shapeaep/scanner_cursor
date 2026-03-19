#!/usr/bin/env python3
# -*- coding: utf-8 -*-

from __future__ import annotations

import argparse
from pathlib import Path
from typing import Iterable

from PIL import Image


PNG_EXTENSIONS = {".png"}


def iter_png_files(root: Path, recursive: bool = False) -> Iterable[Path]:
    if recursive:
        yield from (p for p in root.rglob("*") if p.suffix.lower() in PNG_EXTENSIONS)
    else:
        yield from (p for p in root.glob("*") if p.suffix.lower() in PNG_EXTENSIONS)


def has_alpha(img: Image.Image) -> bool:
    if img.mode in ("RGBA", "LA"):
        return True

    if img.mode == "P":
        return "transparency" in img.info

    return False


def extract_alpha_mask(img: Image.Image) -> Image.Image | None:
    if not has_alpha(img):
        return None

    if img.mode in ("RGBA", "LA"):
        alpha = img.getchannel("A")
    else:
        # PNG в palette mode с transparency
        alpha = img.convert("RGBA").getchannel("A")

    # L = grayscale, где 0 = черный, 255 = белый
    return alpha.convert("L")


def composite_to_rgb(img: Image.Image, background: tuple[int, int, int]) -> Image.Image:
    if has_alpha(img):
        rgba = img.convert("RGBA")
        bg = Image.new("RGBA", rgba.size, background + (255,))
        merged = Image.alpha_composite(bg, rgba)
        return merged.convert("RGB")

    return img.convert("RGB")


def save_jpeg(
    img: Image.Image,
    out_path: Path,
    quality: int = 88,
    subsampling: int | str = 0,
) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)

    img.save(
        out_path,
        format="JPEG",
        quality=quality,
        optimize=True,
        progressive=True,
        subsampling=subsampling,
    )


def process_png(
    png_path: Path,
    output_dir: Path,
    masks_dir: Path,
    quality: int,
    background: tuple[int, int, int],
) -> None:
    with Image.open(png_path) as img:
        stem = png_path.stem

        # 1. Сохраняем alpha mask в JPG, если альфа есть
        alpha_mask = extract_alpha_mask(img)
        if alpha_mask is not None:
            mask_output_path = masks_dir / f"{stem}_alpha_mask.jpg"
            save_jpeg(alpha_mask, mask_output_path, quality=95, subsampling=0)
            print(f"[MASK] {png_path.name} -> {mask_output_path}")

        # 2. Конвертируем исходник в JPG
        rgb = composite_to_rgb(img, background=background)
        jpg_output_path = output_dir / f"{stem}.jpg"
        save_jpeg(rgb, jpg_output_path, quality=quality, subsampling=0)
        print(f"[JPG ] {png_path.name} -> {jpg_output_path}")


def parse_background(value: str) -> tuple[int, int, int]:
    value = value.strip().lower()

    presets = {
        "white": (255, 255, 255),
        "black": (0, 0, 0),
    }
    if value in presets:
        return presets[value]

    parts = value.split(",")
    if len(parts) != 3:
        raise argparse.ArgumentTypeError(
            "Фон должен быть 'white', 'black' или в формате R,G,B например 255,255,255"
        )

    try:
        rgb = tuple(int(x) for x in parts)
    except ValueError as e:
        raise argparse.ArgumentTypeError("R,G,B должны быть целыми числами") from e

    if any(not (0 <= x <= 255) for x in rgb):
        raise argparse.ArgumentTypeError("Каждое значение R,G,B должно быть от 0 до 255")

    return rgb  # type: ignore[return-value]


def main() -> None:
    parser = argparse.ArgumentParser(
        description=(
            "Берет PNG из директории, сохраняет alpha mask как черно-белый JPG, "
            "а исходный PNG конвертирует в JPG."
        )
    )
    parser.add_argument(
        "input_dir",
        type=Path,
        help="Папка с PNG-файлами",
    )
    parser.add_argument(
        "--recursive",
        action="store_true",
        help="Искать PNG рекурсивно во всех подпапках",
    )
    parser.add_argument(
        "--quality",
        type=int,
        default=88,
        help="Качество JPEG для исходных изображений (по умолчанию: 88)",
    )
    parser.add_argument(
        "--background",
        type=parse_background,
        default="white",
        help="Фон для PNG с альфой: white, black или R,G,B. Пример: 255,255,255",
    )
    parser.add_argument(
        "--jpg-dir",
        type=Path,
        default=None,
        help="Куда сохранять JPG-версии исходников (по умолчанию: <input_dir>/jpg)",
    )
    parser.add_argument(
        "--mask-dir",
        type=Path,
        default=None,
        help="Куда сохранять alpha mask JPG (по умолчанию: <input_dir>/alpha_masks)",
    )

    args = parser.parse_args()

    input_dir: Path = args.input_dir
    if not input_dir.exists() or not input_dir.is_dir():
        raise SystemExit(f"Папка не найдена: {input_dir}")

    quality = max(1, min(100, args.quality))
    background = args.background

    jpg_dir = args.jpg_dir or (input_dir / "jpg")
    mask_dir = args.mask_dir or (input_dir / "alpha_masks")

    png_files = list(iter_png_files(input_dir, recursive=args.recursive))
    if not png_files:
        print("PNG-файлы не найдены.")
        return

    print(f"Найдено PNG: {len(png_files)}")
    print(f"JPG будут сохранены в: {jpg_dir}")
    print(f"Alpha masks будут сохранены в: {mask_dir}")
    print()

    for png_path in png_files:
        try:
            process_png(
                png_path=png_path,
                output_dir=jpg_dir,
                masks_dir=mask_dir,
                quality=quality,
                background=background,
            )
        except Exception as e:
            print(f"[ERR ] {png_path} -> {e}")


if __name__ == "__main__":
    main()