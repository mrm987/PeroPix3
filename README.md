<div align="center">

<img src="src-tauri/icons/128x128@2x.png" width="88" alt="PeroPix">

# PeroPix

**A desktop workbench for NovelAI image generation.**<br>
Lay scenes out on a lane, queue them once, and get the whole set.

[![Release](https://img.shields.io/github/v/release/mrm987/PeroPix3?label=download&color=5865F2)](https://github.com/mrm987/PeroPix3/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/mrm987/PeroPix3/total?color=5865F2)](https://github.com/mrm987/PeroPix3/releases)
[![License](https://img.shields.io/badge/license-AGPL--3.0-informational)](LICENSE)
![Platform](https://img.shields.io/badge/platform-Windows-lightgrey)
[![Website](https://img.shields.io/badge/website-peropix.mori--mo.com-5865F2)](https://peropix.mori-mo.com/)
[![Ko-fi](https://img.shields.io/badge/Ko--fi-support-ff5e5b?logo=ko-fi&logoColor=white)](https://ko-fi.com/morimo_)

**English** · [한국어](README.ko.md) · [日本語](README.ja.md)

Website: [peropix.mori-mo.com](https://peropix.mori-mo.com/)

</div>

---

NovelAI does the generating. PeroPix is the workbench in front of it — and one image at a
time is fine until you want twenty of the same character in different scenes. Here you
write the parts that stay the same once, line up the parts that change, and send the lot
to a queue.

- **Scene lane and queue** — each scene is a card on a lane. Fill in what differs, queue
  the lane, and keep working while it runs; every result stays attached to the scene that
  produced it.
- **Prompt blocks** — build a prompt out of labelled blocks instead of one long line.
  Toggle, reorder, and weight them without hunting through commas.
- **Card deck** — save a style or a character as a card and drop it into any scene.
  Fix the card once and every scene that uses it follows.
- **Wildcards** — pools of alternatives that pick themselves at generation time.
- **NovelAI's own tools, in the same place** — inpainting, enhance, vibe transfer and
  upscaling run on the scene you already have, with its prompt and settings carried over.
  No round trip to the website and back.
- **Censoring** — an on-device model finds the regions and covers them. Nothing leaves
  your machine; you choose the method and the strength.
- **AI assistant** — hand it a workspace and describe what you want in words; it edits
  the prompts and queues the work. It asks before anything it cannot undo.

## Requirements

- **A NovelAI subscription and a Persistent API Token.** NovelAI makes the images;
  PeroPix is the workbench in front of it. Create the token in your NovelAI account
  settings — it starts with `pst-`.
- **Generating costs Anlas.** Sizes and step counts within your plan's free limits cost
  nothing, and the generate button always shows the current price before you press it.
- **Windows 10 or 11.** The WebView2 runtime is required and is usually already there.

## Install

1. Download `PeroPix-<version>-win64.zip` from the [latest release](https://github.com/mrm987/PeroPix3/releases/latest).
2. Unzip it **somewhere you can write to** — your Documents folder, another drive.
   Not inside `Program Files`.
3. Run `PeroPix.exe`, open **Settings ▸ General**, and paste your token.

That's it. Python ships inside the package; there is nothing else to install, and nothing
is written to the registry. To move or remove PeroPix, move or delete the folder.

> You can unzip several copies and run them side by side — each folder keeps its own
> port, storage and settings. Only opening the *same* folder twice is blocked.

## Your files

Everything lives next to `PeroPix.exe`. Back these up and you have everything;
updates never touch them.

| Folder | What's in it |
|---|---|
| `workspaces/` | Your work — tabs, scenes, prompts, and the images under `output/` |
| `gallery/` | Images you chose to keep |
| `data/` | Settings and cards. **Your API token lives only in `data/secrets.json`** |
| `logs/` | One log file. Attach `logs/peropix.log` when you report a problem |

`app/` is the program itself and is replaced on every update.

## Updating

PeroPix checks quietly at startup and tells you when a new version is out — or press the
button under **Settings ▸ Update**. It downloads, then restarting applies it. Whether it
fetches a small patch or the full package is decided for you; you only see the size.

## Development

```bash
npm install
npm run tauri dev     # frontend (1420) + backend (8770) + window
```

Backend only: `python backend/server.py --port 8770`.
Dependencies are in `backend/requirements.txt`.

Building packages, cutting releases, and how auto-update chooses patch vs. full are
described in **[docs/release.md](docs/release.md)**.

## License

Copyright (C) 2026 mrm987

[AGPL-3.0-or-later](LICENSE). Bundled third-party components are listed in [THIRD-PARTY.md](THIRD-PARTY.md).
