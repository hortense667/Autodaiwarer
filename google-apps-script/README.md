# Google Drive 同期セットアップ（Apps Script）

この手順は **通常は不要** です。  
普段は `share` パラメータなしでローカル編集する運用を推奨します。

**どうしても共有で共同編集したい場合のみ**、このセットアップを実施してください。

---

## 0) 何ができるようになるか

このフォルダの `Code.gs` は、AutoDaiwarer の共有同期バックエンドです。  
Google Drive に `share` ごとの JSON を保存し、次を提供します。

- 自動保存（フロントから数秒ごと POST）
- 自動再取得（フロントから数秒ごと GET）
- 競合検知（`baseVersion` が古いと `conflict: true` で最新を返す）

---

## 1) 自分で使う場合（最短手順）

1. [Google Apps Script](https://script.google.com/) を開く
2. 新規プロジェクトを作成
3. 既存 `Code.gs` を全置換し、`google-apps-script/Code.gs` を貼り付けて保存
4. 右上 `デプロイ` → `新しいデプロイ` → `ウェブアプリ`
5. 設定:
   - `次のユーザーとして実行`: **自分**
   - `アクセスできるユーザー`: **全員**（匿名アクセス可）
6. デプロイして `/exec` URL を控える
7. アプリURLに次を付けて開く:
   - `share=<共有ID>`
   - `syncEndpoint=<上記 /exec URL>`

例:

```text
https://autodaiwarer.pages.dev/?share=book-202605-a&syncEndpoint=https%3A%2F%2Fscript.google.com%2Fmacros%2Fs%2Fxxx%2Fexec
```

---

## 2) 他ユーザーが「自分のDrive」で使う場合

Googleの権限仕様上、ここは自動化できません。  
**本人が1回だけ** 次を実施する必要があります。

1. 本人がApps Scriptを新規作成
2. 本人アカウントで `Code.gs` を貼り付け
3. 本人アカウントでWebアプリデプロイ
4. 本人の `/exec` URL を取得
5. そのURLを `syncEndpoint` に指定して利用

要するに、保存先Driveは `syncEndpoint` の所有者に紐づきます。

---

## 3) つまずきやすい点（重要）

- `アクセスできるユーザー` が `Googleアカウント所有者のみ` だと失敗することがあります。
- 変更後は必ず再デプロイしてください。
- `syncEndpoint` はクォートなしで渡してください。
- URL生成時は `encodeURIComponent(execURL)` を使ってください。

---

## 4) 保存先

- Drive 直下に `autodaiwarer-sync` フォルダを自動作成
- `share.json` 形式で保存（例: `book-202605-a.json`）
- 同じ `share` は同じファイルを更新、別 `share` は別ファイル作成

---

## 5) API仕様（参考）

### GET `?share=<id>`

返却例:

```json
{
  "ok": true,
  "share": "book-202605",
  "version": 12,
  "text": "//台割ファイル名\t...",
  "updatedAt": "2026-04-30T12:00:00.000Z",
  "updatedBy": "user@example.com | client-xxxx | ja"
}
```

### POST（bodyはJSON文字列）

入力例:

```json
{
  "share": "book-202605",
  "text": "//台割ファイル名\t...",
  "baseVersion": 12,
  "clientId": "client-xxxx",
  "locale": "ja"
}
```

競合時の返却例:

```json
{
  "ok": true,
  "share": "book-202605",
  "conflict": true,
  "version": 13,
  "text": "//最新テキスト...",
  "updatedAt": "2026-04-30T12:00:05.000Z",
  "updatedBy": "..."
}
```

---

## 6) ヘルプ画面のバグレポート送信（追加）

`Code.gs` には、同期 API と同じ Web アプリ URL で使えるバグレポート受け口も含まれています。  
フロントから次の JSON を `POST` すると、Google スプレッドシートへ 1 行追加されます。

```json
{
  "type": "bugReport",
  "email": "user@example.com",
  "message": "不具合内容（2000文字以内）",
  "locale": "ja",
  "clientId": "bug-xxxx",
  "appVersion": "1.0.0",
  "pageUrl": "https://autodaiwarer.pages.dev/",
  "userAgent": "Mozilla/5.0 ..."
}
```

初回送信時に、Drive 上へ次を自動作成します。

- フォルダ: `autodaiwarer-bug-reports`
- スプレッドシート: `autodaiwarer_bug_reports`
- シート: `reports`

### 送信ガード（Code.gs 側）

- 内容は最大 2000 文字
- 同一送信元キーの連投を最短 20 秒で制限
- 同一内容の短時間重複（10分）を制限
- 同一送信元キーの 1 時間あたり上限（5件）

### フロントへの渡し方

- Cloudflare Pages の環境変数 `BUG_REPORT_ENDPOINT` に GAS の `exec` URL を設定し、`/api/session` から返却して利用します。
