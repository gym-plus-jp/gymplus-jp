-- =====================================================
-- Jumpolin 会員クーポンシステム データベーススキーマ
-- 株式会社Gym plus
-- =====================================================
-- 実行方法: Supabase Dashboard → SQL Editor で全文を貼り付けて Run
-- =====================================================

-- 念のため既存テーブルを削除（初回は無視されます）
DROP TABLE IF EXISTS redemptions CASCADE;
DROP TABLE IF EXISTS referral_rewards CASCADE;
DROP TABLE IF EXISTS referral_qrs CASCADE;
DROP TABLE IF EXISTS coupons CASCADE;
DROP TABLE IF EXISTS campaigns CASCADE;
DROP TABLE IF EXISTS students CASCADE;
DROP TABLE IF EXISTS settings CASCADE;

-- =====================================================
-- 1. 生徒（クラブ会員）
-- =====================================================
CREATE TABLE students (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token TEXT UNIQUE NOT NULL,                    -- マイページURL用
  name TEXT NOT NULL,
  club TEXT NOT NULL,                            -- AGC / Bullets / AGC+Bullets
  phone_last4 TEXT NOT NULL,
  verified_device BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_students_token ON students(token);
CREATE INDEX idx_students_phone ON students(phone_last4);

-- =====================================================
-- 2. キャンペーン（クーポンの種類マスター）
-- =====================================================
CREATE TABLE campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type TEXT NOT NULL,                            -- 割引券/オマケ/誕生月特典など
  label TEXT NOT NULL,                           -- 表示名
  detail TEXT,                                   -- 詳細説明
  expires_at TIMESTAMPTZ,                        -- キャンペーン全体の期限
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_campaigns_expires ON campaigns(expires_at);

-- =====================================================
-- 3. クーポン（生徒×キャンペーン）
-- =====================================================
CREATE TABLE coupons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token TEXT UNIQUE NOT NULL,                    -- QRコードのトークン
  student_id UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  campaign_id UUID REFERENCES campaigns(id) ON DELETE SET NULL,
  type TEXT NOT NULL,
  label TEXT NOT NULL,
  detail TEXT,
  expires_at TIMESTAMPTZ,
  issued_at TIMESTAMPTZ DEFAULT NOW(),
  used_at TIMESTAMPTZ,
  used_by TEXT                                   -- スタッフ識別
);
CREATE INDEX idx_coupons_token ON coupons(token);
CREATE INDEX idx_coupons_student ON coupons(student_id);
CREATE INDEX idx_coupons_used ON coupons(used_at);
CREATE UNIQUE INDEX idx_coupons_student_campaign ON coupons(student_id, campaign_id) WHERE campaign_id IS NOT NULL;

-- =====================================================
-- 4. 友達招待QR
-- =====================================================
CREATE TABLE referral_qrs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token TEXT UNIQUE NOT NULL,
  issuer_student_id UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  issuer_name TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  used_by_name TEXT,
  issued_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_referral_qrs_token ON referral_qrs(token);
CREATE INDEX idx_referral_qrs_issuer ON referral_qrs(issuer_student_id);

-- =====================================================
-- 5. 紹介者特典（リファラル成立時に自動付与）
-- =====================================================
CREATE TABLE referral_rewards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token TEXT UNIQUE NOT NULL,
  student_id UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  source_referral_id UUID REFERENCES referral_qrs(id) ON DELETE SET NULL,
  label TEXT NOT NULL,
  used_at TIMESTAMPTZ,
  issued_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_referral_rewards_student ON referral_rewards(student_id);

-- =====================================================
-- 6. 使用履歴（監査ログ）
-- =====================================================
CREATE TABLE redemptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind TEXT NOT NULL,                            -- 'coupon' / 'referral'
  ref_id UUID NOT NULL,                          -- coupons.id か referral_qrs.id
  redeemed_by TEXT,                              -- スタッフ識別
  at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_redemptions_at ON redemptions(at DESC);

-- =====================================================
-- 7. 設定（運用パラメータ）
-- =====================================================
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 初期設定
INSERT INTO settings (key, value) VALUES
  ('site_name', '"Jumpolin（トランポリンパーク）"'),
  ('referral_limit_per_month', '2'),
  ('referral_expire_days', '14'),
  ('referrer_reward_label', '"次回ドリンク1杯無料"');

-- =====================================================
-- Row Level Security（RLS）ポリシー
-- =====================================================
-- プロトタイプ段階では anon キーで読み書きを許可。
-- 本番でスタッフ認証等を入れる際はポリシーを厳格化する。

ALTER TABLE students ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE coupons ENABLE ROW LEVEL SECURITY;
ALTER TABLE referral_qrs ENABLE ROW LEVEL SECURITY;
ALTER TABLE referral_rewards ENABLE ROW LEVEL SECURITY;
ALTER TABLE redemptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE settings ENABLE ROW LEVEL SECURITY;

-- anon ロールに全テーブルでの全操作を許可（プロト用）
CREATE POLICY anon_all_students      ON students      FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY anon_all_campaigns     ON campaigns     FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY anon_all_coupons       ON coupons       FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY anon_all_referral_qrs  ON referral_qrs  FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY anon_all_referral_rew  ON referral_rewards FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY anon_all_redemptions   ON redemptions   FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY anon_all_settings      ON settings      FOR ALL TO anon USING (true) WITH CHECK (true);

-- =====================================================
-- 完了
-- =====================================================
-- 次のステップ:
-- 1. Supabase Dashboard → Project Settings → API
-- 2. 「Project URL」と「anon (public) key」をコピー
-- 3. coupon/assets/config.js に貼り付け
-- =====================================================
