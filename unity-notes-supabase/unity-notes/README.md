# つまずきログ — Unity Field Notes

GitHub Pagesに置く静的Webアプリと、Supabaseの中央保存・本人認証の設定一式です。

**まず `SETUP.md` を開いてください。** あなたのSupabaseプロジェクト作成と公開用設定値の入力が必要です。GitHubへの公開や本番接続はまだ行っていません。

## 同梱内容

- `site/`：配信するHTML / CSS / JavaScript。ビルド不要、CDN依存なし。
- `supabase/schema.sql`：データ構造、検索索引、RLS、更新用トランザクション。
- `supabase/owner.sql`：編集を許可する本人UIDの設定。
- `supabase/security-smoke.sql`：Supabaseで実行する、ロール別の権限確認スクリプト。
- `.github/workflows/pages.yml`：site/だけをGitHub Pagesへ配信。
- `SETUP.md`：具体的な設定、公開、運用、JSON移行の手順。
- `docs/ARCHITECTURE.md`：実装判断・データ仕様・制約。
- `docs/TEST-REPORT.md`：実施した検証と未検証の範囲。
- `docs/test-results.json`：自動ブラウザテストの結果。
- `docs/screenshots/`：画面確認用の画像。
- `examples.json`：架空のサンプル8件。実際のNotionの記録ではありません。
- `tests/`：ローカルSQLite保存サーバーとPlaywright統合テスト。公開しないこと。

## 実装した機能

タイムライン、Markdown本文、検索、自由なジャンルと名称変更、タグ、追加・編集・削除、全体／ジャンル内の並べ替え、JSON入出力、本人認証、競合検出、レスポンシブUI。

ブラウザに記録の正本を保存しません。配信ファイルに秘密鍵も含めません。ログインセッションはタブのメモリ内だけで、再読み込み後の編集には再ログインします。

## 検証について

ローカルの中央保存サーバー＋独立したChromiumセッションで、追加と並べ替えの保存・再読み込み等を検証しています。ただしローカルサーバーはSupabase APIのテスト代替物です。本物のSupabase / PostgreSQL RLS / GitHub Pagesへの接続は、あなたのセットアップ後に確認が必要です。詳しくは検証報告を参照してください。

## 第三者ライセンス

Markdown表示にmarkdown-it 14.3.0（MIT）を同梱。`site/vendor/markdown-it.LICENSE` を参照。外部フォント・外部画像・分析トラッカーは使用しません。
