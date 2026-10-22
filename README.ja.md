<div align="center">

<img src="src-tauri/icons/128x128@2x.png" width="88" alt="PeroPix">

# PeroPix

**NovelAI の画像生成のためのデスクトップ作業台。**<br>
シーンをレーンに並べて一度キューに積めば、まとめて出てきます。

[![Release](https://img.shields.io/github/v/release/mrm987/PeroPix3?label=download&color=5865F2)](https://github.com/mrm987/PeroPix3/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/mrm987/PeroPix3/total?color=5865F2)](https://github.com/mrm987/PeroPix3/releases)
[![License](https://img.shields.io/badge/license-AGPL--3.0-informational)](LICENSE)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS-lightgrey)
[![Website](https://img.shields.io/badge/website-peropix.mori--mo.com-5865F2)](https://peropix.mori-mo.com/ja/)
[![Ko-fi](https://img.shields.io/badge/Ko--fi-support-ff5e5b?logo=ko-fi&logoColor=white)](https://ko-fi.com/morimo_)

[English](README.md) · [한국어](README.ko.md) · **日本語**

サイト: [peropix.mori-mo.com](https://peropix.mori-mo.com/ja/)

</div>

---

画像を作るのは NovelAI です。PeroPix はその手前に置く作業台です — 一枚ずつ出すのは難しく
ありませんが、同じキャラクターをシーンだけ変えて二十枚となると話は別です。**変わらない
部分は一度だけ書き、変わる部分だけを並べて、まとめてキューに積みます。**

- **シーンレーンとキュー** — シーン一つがカード一枚。違うところだけ埋めてレーンごとキュー
  に積めば、回っている間に次の準備を進められます。結果はそれを生んだシーンに紐づいたまま
  残ります。
- **プロンプトブロック** — 長い一行ではなく、名前のついたブロックで組み立てます。カンマを
  数えずに、切り替え・並べ替え・重み付けができます。
- **カードデッキ** — 画風やキャラクターをカードとして保存し、どのシーンにも落とせます。
  カードを直せば、それを使うシーンがすべて追従します。
- **ワイルドカード** — 生成時に自分で選ばれる候補の束です。
- **NovelAI の機能を同じ場所で** — インペイント・強化・バイブ転送・アップスケールを、いま
  見ているシーンにそのままかけられます。プロンプトも設定も入ったままなので、公式サイトと
  行き来する必要がありません。
- **検閲** — 端末内のモデルが隠す場所を見つけて覆います。外に出るものはなく、方式と強さは
  自分で選べます。
- **AI アシスタント** — ワークスペースを預けて言葉で頼めば、プロンプトを直して処理を積んで
  くれます。取り消せないことは必ず先に尋ねます。

## 必要なもの

- **NovelAI のサブスクリプションと Persistent API Token。** 画像を作るのは NovelAI で、
  PeroPix はその手前の作業台です。トークンは NovelAI のアカウント設定で作成でき、
  `pst-` で始まります。
- **生成には Anlas がかかります。** プランの無料範囲（サイズ・ステップ数）内なら無料で、
  生成ボタンは押す前に必ず現在の値を表示します。
- **Windows 10 または 11。** WebView2 ランタイムが必要で、通常はすでに入っています。
- **または Apple シリコン搭載 Mac、macOS 14 以降**（ベータ、下記参照）。

## インストール

1. [最新リリース](https://github.com/mrm987/PeroPix3/releases/latest)から
   `PeroPix-<バージョン>-win64.zip` をダウンロードします。
2. **書き込みできる場所**に展開します — ドキュメントフォルダや別のドライブ。
   `Program Files` の中は不可です。
3. `PeroPix.exe` を起動し、**設定 ▸ 一般**でトークンを貼り付けます。

以上です。Python はパッケージに同梱されているので別途インストールは不要で、レジストリにも
何も書きません。移動や削除はフォルダごとで済みます。

> 複数展開して**並べて動かせます** — フォルダごとにポート・保存先・設定が分かれます。
> 塞いであるのは*同じ*フォルダを二重に開くことだけです。

### macOS（ベータ）

Apple シリコン搭載 Mac、macOS 14 以降向けです。Mac 版はコミュニティと一緒に保守しており、
Windows 版より確認が少なめです。おかしな点があれば教えてください。

1. [最新リリース](https://github.com/mrm987/PeroPix3/releases/latest)から `PeroPix-<バージョン>-macos-arm64.dmg` をダウンロードして開きます。
2. 開いたウィンドウで **PeroPix** を **Applications** フォルダにドラッグし、アプリケーション
   フォルダから起動します。アップデートはその場所のアプリを置き換えます。
3. Apple の公証を受けていないため、初回の起動はブロックされます。**システム設定 ▸ プライバシーと
   セキュリティ**で PeroPix の**このまま開く**を押します。

Mac ではファイルはアプリの隣ではなく `~/Library/Application Support/PeroPix` にあります。
中のフォルダは下と同じです。

## ファイルの置き場所

すべて `PeroPix.exe` の隣にあります。ここを控えておけば全部で、アップデートは触りません。

| フォルダ | 中身 |
|---|---|
| `workspaces/` | 作業物 — タブ・シーン・プロンプトと `output/` 以下の画像 |
| `gallery/` | 残すことにした画像 |
| `data/` | 設定とカード。**トークンは `data/secrets.json` にだけあります** |
| `logs/` | ログ一つ。不具合を知らせるときは `logs/peropix.log` を添えてください |

`app/` はプログラム本体で、アップデートのたびに入れ替わります。

## アップデート

起動時に静かに確認し、新しい版があれば知らせます。**設定 ▸ アップデート**から押しても
かまいません。受け取ったあと再起動すると適用されます。小さなパッチか全体かはアプリが自分
で決め、利用者に見えるのは容量だけです。

## 開発

```bash
npm install
npm run tauri dev     # フロント(1420) + バックエンド(8770) + ウィンドウ
```

バックエンドのみ: `python backend/server.py --port 8770`。
依存関係は `backend/requirements.txt` にあります。

パッケージ作成・リリース・アップデートがパッチと全体を選ぶ規則は
**[docs/release.md](docs/release.md)** にあります。

## ライセンス

Copyright (C) 2026 mrm987

[AGPL-3.0-or-later](LICENSE)。同梱の third-party 構成要素は [THIRD-PARTY.md](THIRD-PARTY.md) に記載しています。
