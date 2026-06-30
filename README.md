# gymplus.jp — 株式会社Gym plus 公式サイト

足利市の運動施設運営会社「株式会社Gym plus」の公式ウェブサイトとサービス基盤。

## ホスト構成

| パス | 内容 |
|---|---|
| `/` | コーポレートサイト（3事業紹介+会社情報） |
| `/coupon/` | Jumpolin 会員クーポンシステム |

## 事業

- **Jumpolin（ジャンポリン）** — トランポリンパーク
- **あしかが体操クラブ（AGC）** — 体操クラブ
- **Bullets チア教室** — チアダンス教室

## 技術

- 静的サイト（HTML / CSS / JavaScript）
- ホスティング：GitHub Pages
- ドメイン：ムームードメイン → gymplus.jp

## ローカル開発

```bash
python3 -m http.server 5210
```

→ http://localhost:5210/

## デプロイ

main ブランチへの push で自動デプロイ（GitHub Pages）。

---

© 2026 株式会社Gym plus
