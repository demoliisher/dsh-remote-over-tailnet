# DSH Remote over Tailscale

Tailscale 経由で、スマートフォンからコンピューター上の実行中の DeepSeek Harness セッションに接続します。ストリーミング出力に対応し、公開ゲートウェイは不要です。

## 主な機能

- コンピューターにインストール済みの Tailscale を利用します。固定 IP アドレス、ポート転送、サードパーティー中継は不要です。
- ループバックアドレスでローカル中継サーバーを起動し、`tailscale serve` を使って HTTPS アドレスとして公開します。
- プラグインのパネルに DSH Go のサーバーアドレス、アカウント、パスワードを表示し、Tailscale、中継、HTTPS アドレス、ホスト認証の 4 段階の状態を確認できます。
- 実行中の DSH Desktop セッションに接続し、ストリーミング出力を利用できます。dsh-go は変更しません。

## はじめ方

1. DSH Desktop にプラグインをインストールして有効にし、Desktop を再起動します。
2. 「プラグイン → DSH Remote over Tailscale → リモート設定」を開き、4 段階の状態が完了するまで待ちます。
3. dsh-go でカスタムサーバーを追加し、パネルに表示された HTTPS アドレスとアカウント情報を入力します。

前提条件：スマートフォンとコンピューターが同じ tailnet にあり、コンピューターで Tailscale にログイン済みで、tailnet の HTTPS Certificates が有効であること。

本プロジェクトは MIT プロジェクト ds-harness-remote のフォークであり、Tailscale Inc. および DeepSeek とは提携していません。
