#!/usr/bin/env python3
"""Generate the static case manifest from local video files.

Examples:
  python3 scripts/generate_cases_manifest.py
  python3 scripts/generate_cases_manifest.py assets/long assets/short
  python3 scripts/generate_cases_manifest.py assets/long assets/short assets/long/shots
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path


VIDEO_TYPES = {
    ".m4v": "video/mp4",
    ".mov": "video/quicktime",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
}
POSTER_EXTENSIONS = (".jpg", ".jpeg", ".png", ".webp")
DEFAULT_SCAN_PATHS = ("assets/long", "assets/short")
GROUP_LABELS = {
    "long": "Long Video Cases",
    "short": "Short Clip Cases",
}


def repo_root_from_script() -> Path:
    return Path(__file__).resolve().parents[1]


def natural_key(value: str) -> list[object]:
    return [int(part) if part.isdigit() else part.lower() for part in re.split(r"(\d+)", value)]


def title_from_filename(path: Path) -> str:
    words = re.sub(r"[_-]+", " ", path.stem)
    words = re.sub(r"\s+", " ", words).strip()
    return words.title()


def to_web_path(path: Path) -> str:
    return f"./{path.as_posix()}"


def group_key_for_path(relative_path: Path) -> str:
    parts = relative_path.parts
    if len(parts) >= 2 and parts[0] == "assets":
        return parts[1]
    return relative_path.name


def description_for_group(group_key: str, root_path: Path) -> str:
    label = GROUP_LABELS.get(group_key, title_from_filename(Path(group_key)))
    return f"{label} from {root_path.as_posix()}."


def find_poster(video_path: Path) -> Path | None:
    for extension in POSTER_EXTENSIONS:
        poster = video_path.with_suffix(extension)
        if poster.exists():
            return poster
    return None


def iter_videos(root: Path) -> list[Path]:
    videos = [
        path
        for path in root.rglob("*")
        if path.is_file()
        and not any(part.startswith(".") for part in path.parts)
        and path.suffix.lower() in VIDEO_TYPES
    ]
    return sorted(videos, key=lambda path: natural_key(path.as_posix()))


def build_item(repo_root: Path, scan_root: Path, group_key: str, video_path: Path) -> dict[str, str]:
    relative_video = video_path.relative_to(repo_root)
    relative_scan_root = scan_root.relative_to(repo_root)
    poster = find_poster(video_path)
    relative_poster = poster.relative_to(repo_root) if poster else None

    return {
        "title": title_from_filename(video_path),
        "description": description_for_group(group_key, relative_scan_root),
        "src": to_web_path(relative_video),
        "poster": to_web_path(relative_poster) if relative_poster else "",
        "type": VIDEO_TYPES[video_path.suffix.lower()],
    }


def build_manifest(repo_root: Path, scan_paths: list[str]) -> dict[str, object]:
    groups: dict[str, list[dict[str, str]]] = {}

    for scan_path in scan_paths:
        relative_scan_root = Path(scan_path)
        if relative_scan_root.is_absolute():
            raise ValueError(f"Use a repo-relative path, not an absolute path: {scan_path}")

        scan_root = (repo_root / relative_scan_root).resolve()
        if not scan_root.exists():
            groups.setdefault(group_key_for_path(relative_scan_root), [])
            continue
        if not scan_root.is_dir():
            raise ValueError(f"Scan path is not a directory: {scan_path}")

        group_key = group_key_for_path(relative_scan_root)
        groups.setdefault(group_key, [])
        groups[group_key].extend(
            build_item(repo_root, scan_root, group_key, video_path) for video_path in iter_videos(scan_root)
        )

    for group_items in groups.values():
        group_items.sort(key=lambda item: natural_key(item["src"]))

    return {
        "schemaVersion": 1,
        "groups": groups,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Scan repo-relative video folders and write assets/cases-manifest.json.",
    )
    parser.add_argument(
        "scan_paths",
        nargs="*",
        default=list(DEFAULT_SCAN_PATHS),
        help="Repo-relative directories to scan. Default: assets/long assets/short",
    )
    parser.add_argument(
        "-o",
        "--output",
        default="assets/cases-manifest.json",
        help="Repo-relative output JSON path. Default: assets/cases-manifest.json",
    )
    parser.add_argument(
        "--js-output",
        default="assets/cases-data.js",
        help="Repo-relative browser data path. Default: assets/cases-data.js",
    )
    parser.add_argument(
        "--stdout",
        action="store_true",
        help="Print the generated manifest instead of writing files.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    repo_root = repo_root_from_script()
    manifest = build_manifest(repo_root, args.scan_paths)
    output = json.dumps(manifest, indent=2, ensure_ascii=False) + "\n"

    if args.stdout:
        print(output, end="")
        return

    output_path = Path(args.output)
    if output_path.is_absolute():
        raise ValueError(f"Use a repo-relative output path, not an absolute path: {args.output}")

    target = repo_root / output_path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(output, encoding="utf-8")

    js_output_path = Path(args.js_output)
    if js_output_path.is_absolute():
        raise ValueError(f"Use a repo-relative JS output path, not an absolute path: {args.js_output}")

    js_target = repo_root / js_output_path
    js_target.parent.mkdir(parents=True, exist_ok=True)
    js_target.write_text(
        "window.ECHO_CASE_MANIFEST = "
        + json.dumps(manifest, indent=2, ensure_ascii=False)
        + ";\n",
        encoding="utf-8",
    )

    total = sum(len(items) for items in manifest["groups"].values())
    print(f"Wrote {output_path.as_posix()} and {js_output_path.as_posix()} with {total} video(s).")


if __name__ == "__main__":
    main()
