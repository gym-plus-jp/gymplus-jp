/* Jumpolin クーポンシステム — Supabase 実装
 *
 * 既存 LocalStorage 版 db.js と同一の API（window.DB.*）を提供。
 * window.GYMPLUS_CONFIG.SUPABASE_URL / SUPABASE_ANON_KEY が設定されているときに
 * このファイルが優先ロードされる想定。
 *
 * 全クライアント側 fetch で完結（Supabase REST API + PostgREST）。
 */

(function () {
  const cfg = window.GYMPLUS_CONFIG || {};
  if (!cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY) return; // 設定なし → LocalStorage版にフォールバック

  const SB_URL = cfg.SUPABASE_URL.replace(/\/$/, '');
  const SB_KEY = cfg.SUPABASE_ANON_KEY;
  const REST = SB_URL + '/rest/v1';

  const headers = (extra = {}) => ({
    'apikey': SB_KEY,
    'Authorization': 'Bearer ' + SB_KEY,
    'Content-Type': 'application/json',
    ...extra,
  });

  // ===== Low-level helpers =====
  async function _select(table, query = '') {
    const res = await fetch(`${REST}/${table}?${query}`, { headers: headers() });
    if (!res.ok) throw new Error(`select ${table} failed: ${res.status}`);
    return res.json();
  }
  async function _insert(table, row) {
    const res = await fetch(`${REST}/${table}`, {
      method: 'POST',
      headers: headers({ 'Prefer': 'return=representation' }),
      body: JSON.stringify(row),
    });
    if (!res.ok) throw new Error(`insert ${table} failed: ${res.status} ${await res.text()}`);
    const arr = await res.json();
    return Array.isArray(arr) ? arr[0] : arr;
  }
  async function _update(table, query, patch) {
    const res = await fetch(`${REST}/${table}?${query}`, {
      method: 'PATCH',
      headers: headers({ 'Prefer': 'return=representation' }),
      body: JSON.stringify(patch),
    });
    if (!res.ok) throw new Error(`update ${table} failed: ${res.status}`);
    const arr = await res.json();
    return Array.isArray(arr) ? arr[0] : arr;
  }
  async function _delete(table, query) {
    const res = await fetch(`${REST}/${table}?${query}`, {
      method: 'DELETE',
      headers: headers(),
    });
    if (!res.ok) throw new Error(`delete ${table} failed: ${res.status}`);
  }

  // Snake ↔ Camel 変換
  function toCamel(row) {
    if (!row || typeof row !== 'object') return row;
    const out = {};
    for (const k in row) {
      const ck = k.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
      out[ck] = row[k];
    }
    return out;
  }
  function toSnake(row) {
    if (!row || typeof row !== 'object') return row;
    const out = {};
    for (const k in row) {
      const sk = k.replace(/([A-Z])/g, '_$1').toLowerCase();
      out[sk] = row[k];
    }
    return out;
  }

  function uid(prefix = 'id') {
    return prefix + '_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  }

  // ===== Students =====
  async function getStudents() {
    return (await _select('students', 'order=created_at.asc')).map(toCamel);
  }
  async function getStudentByToken(token) {
    const rows = await _select('students', `token=eq.${encodeURIComponent(token)}&limit=1`);
    return rows[0] ? toCamel(rows[0]) : null;
  }
  async function getStudentById(id) {
    const rows = await _select('students', `id=eq.${id}&limit=1`);
    return rows[0] ? toCamel(rows[0]) : null;
  }
  async function addStudent({ name, club, phoneLast4 }) {
    const row = await _insert('students', {
      token: uid('tk'),
      name, club, phone_last4: phoneLast4,
    });
    return toCamel(row);
  }
  async function upsertStudent({ name, club, phoneLast4 }) {
    const normalized = name.replace(/\s+/g, '');
    const existing = (await _select('students', `phone_last4=eq.${phoneLast4}`)).find(
      s => s.name.replace(/\s+/g, '') === normalized
    );
    if (existing) {
      if (club && existing.club !== club) {
        await _update('students', `id=eq.${existing.id}`, { club });
        existing.club = club;
      }
      return { student: toCamel(existing), created: false };
    }
    const created = await addStudent({ name, club, phoneLast4 });
    return { student: created, created: true };
  }
  async function markStudentVerified(studentId) {
    await _update('students', `id=eq.${studentId}`, { verified_device: true });
  }
  async function deleteStudent(studentId) {
    await _delete('students', `id=eq.${studentId}`); // CASCADE で関連も削除
  }

  // ===== Coupons =====
  async function getCouponsForStudent(studentId) {
    return (await _select('coupons', `student_id=eq.${studentId}&order=issued_at.desc`)).map(toCamel);
  }
  async function getCouponByToken(token) {
    const rows = await _select('coupons', `token=eq.${encodeURIComponent(token)}&limit=1`);
    return rows[0] ? toCamel(rows[0]) : null;
  }
  async function issueCouponToAll({ type, label, detail, expiresAt }) {
    const campaign = await _insert('campaigns', { type, label, detail, expires_at: expiresAt });
    const students = await _select('students', 'select=id');
    if (!students.length) return 0;
    const rows = students.map(s => ({
      token: uid('cpt'),
      student_id: s.id,
      campaign_id: campaign.id,
      type, label, detail, expires_at: expiresAt,
    }));
    await _insert('coupons', rows);
    return rows.length;
  }
  async function issueActiveCampaignsToStudent(studentId) {
    const now = new Date().toISOString();
    const active = await _select('campaigns', `or=(expires_at.is.null,expires_at.gte.${now})`);
    let count = 0;
    for (const cmp of active) {
      const existing = await _select('coupons', `student_id=eq.${studentId}&campaign_id=eq.${cmp.id}&limit=1`);
      if (existing.length) continue;
      await _insert('coupons', {
        token: uid('cpt'),
        student_id: studentId,
        campaign_id: cmp.id,
        type: cmp.type, label: cmp.label, detail: cmp.detail,
        expires_at: cmp.expires_at,
      });
      count++;
    }
    return count;
  }
  async function redeemCoupon(couponId, staffNote = '受付') {
    const c = (await _select('coupons', `id=eq.${couponId}&limit=1`))[0];
    if (!c) return { ok: false, reason: 'not_found' };
    if (c.used_at) return { ok: false, reason: 'already_used', coupon: toCamel(c) };
    if (c.expires_at && new Date(c.expires_at) < new Date()) {
      return { ok: false, reason: 'expired', coupon: toCamel(c) };
    }
    const updated = await _update('coupons', `id=eq.${couponId}`, {
      used_at: new Date().toISOString(),
      used_by: staffNote,
    });
    await _insert('redemptions', { kind: 'coupon', ref_id: couponId, redeemed_by: staffNote });
    return { ok: true, coupon: toCamel(updated) };
  }

  // ===== Referral QRs =====
  async function getReferralQrsForStudent(studentId) {
    return (await _select('referral_qrs', `issuer_student_id=eq.${studentId}&order=issued_at.desc`)).map(toCamel);
  }
  async function countReferralIssuedThisMonth(studentId) {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const rows = await _select(
      'referral_qrs',
      `issuer_student_id=eq.${studentId}&issued_at=gte.${monthStart}&select=id`
    );
    return rows.length;
  }
  async function issueReferralQr(studentId) {
    const student = await getStudentById(studentId);
    if (!student) return { ok: false, reason: 'student_not_found' };
    const settings = await getSettings();
    const monthCount = await countReferralIssuedThisMonth(studentId);
    if (monthCount >= settings.referralLimitPerMonth) {
      return { ok: false, reason: 'monthly_limit', limit: settings.referralLimitPerMonth };
    }
    const expireMs = settings.referralExpireDays * 86400 * 1000;
    const r = await _insert('referral_qrs', {
      token: uid('rft'),
      issuer_student_id: studentId,
      issuer_name: student.name,
      expires_at: new Date(Date.now() + expireMs).toISOString(),
    });
    return { ok: true, referral: toCamel(r) };
  }
  async function getReferralByToken(token) {
    const rows = await _select('referral_qrs', `token=eq.${encodeURIComponent(token)}&limit=1`);
    return rows[0] ? toCamel(rows[0]) : null;
  }
  async function redeemReferralQr(referralId, friendName, staffNote = '受付') {
    const r = (await _select('referral_qrs', `id=eq.${referralId}&limit=1`))[0];
    if (!r) return { ok: false, reason: 'not_found' };
    if (r.used_at) return { ok: false, reason: 'already_used', referral: toCamel(r) };
    if (new Date(r.expires_at) < new Date()) {
      return { ok: false, reason: 'expired', referral: toCamel(r) };
    }
    const updated = await _update('referral_qrs', `id=eq.${referralId}`, {
      used_at: new Date().toISOString(),
      used_by_name: friendName || '（記名なし）',
    });
    await _insert('redemptions', { kind: 'referral', ref_id: referralId, redeemed_by: staffNote });

    const settings = await getSettings();
    // 紹介者リワード（コイン代わりに coupons にも転記）
    const rewardToken = uid('rwt');
    await _insert('referral_rewards', {
      token: rewardToken,
      student_id: r.issuer_student_id,
      source_referral_id: referralId,
      label: settings.referrerRewardLabel,
    });
    const friendlyCoupon = await _insert('coupons', {
      token: rewardToken,
      student_id: r.issuer_student_id,
      type: 'referral_reward',
      label: '紹介ありがとう特典',
      detail: settings.referrerRewardLabel + '（' + (friendName || '記名なし') + 'さんを紹介）',
      expires_at: new Date(Date.now() + 60 * 86400 * 1000).toISOString(),
    });
    return { ok: true, referral: toCamel(updated), reward: toCamel(friendlyCoupon) };
  }

  // ===== Settings =====
  async function getSettings() {
    const rows = await _select('settings');
    const out = {};
    rows.forEach(r => {
      const ck = r.key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
      out[ck] = r.value;
    });
    // デフォルト値
    return {
      siteName: out.siteName || 'Jumpolin（トランポリンパーク）',
      referralLimitPerMonth: out.referralLimitPerMonth || 2,
      referralExpireDays: out.referralExpireDays || 14,
      referrerRewardLabel: out.referrerRewardLabel || '次回ドリンク1杯無料',
    };
  }
  async function updateSettings(patch) {
    for (const [k, v] of Object.entries(patch)) {
      const sk = k.replace(/([A-Z])/g, '_$1').toLowerCase();
      await fetch(`${REST}/settings?key=eq.${sk}`, {
        method: 'PATCH',
        headers: headers(),
        body: JSON.stringify({ value: v }),
      });
    }
  }

  // ===== Utility =====
  async function seedDemoData() {
    const existing = await getStudents();
    if (existing.length > 0) return false;
    const demos = [
      { name: '佐藤 ひかり', club: 'AGC',    phoneLast4: '1234' },
      { name: '田中 あおい', club: 'Bullets',phoneLast4: '5678' },
      { name: '鈴木 けんと', club: 'AGC',    phoneLast4: '9012' },
    ];
    for (const d of demos) await addStudent(d);
    await issueCouponToAll({
      type: '誕生月特典',
      label: '6月生まれ特典：入場料20%OFF',
      detail: '誕生月の方限定。1回のみ利用可',
      expiresAt: '2026-06-30T23:59:59',
    });
    await issueCouponToAll({
      type: '割引券',
      label: '夏休み先取りキャンペーン：500円OFF',
      detail: '通常入場料から500円引き',
      expiresAt: '2026-07-31T23:59:59',
    });
    await issueCouponToAll({
      type: 'オマケ',
      label: '初夏のドリンクサービス',
      detail: 'お好きなソフトドリンク1杯プレゼント',
      expiresAt: '2026-07-15T23:59:59',
    });
    return true;
  }

  async function resetAll() {
    if (!confirm('本番DBの全データを削除します。よろしいですか？')) return;
    await _delete('redemptions', 'id=neq.00000000-0000-0000-0000-000000000000');
    await _delete('referral_rewards', 'id=neq.00000000-0000-0000-0000-000000000000');
    await _delete('referral_qrs', 'id=neq.00000000-0000-0000-0000-000000000000');
    await _delete('coupons', 'id=neq.00000000-0000-0000-0000-000000000000');
    await _delete('campaigns', 'id=neq.00000000-0000-0000-0000-000000000000');
    await _delete('students', 'id=neq.00000000-0000-0000-0000-000000000000');
  }

  // window.DB を上書き（LocalStorage 版より優先）
  window.DB = {
    isSupabase: true,
    getStudents, getStudentByToken, getStudentById,
    addStudent, upsertStudent, markStudentVerified, deleteStudent,
    getCouponsForStudent, issueCouponToAll, issueActiveCampaignsToStudent,
    getCouponByToken, redeemCoupon,
    getReferralQrsForStudent, issueReferralQr, getReferralByToken,
    redeemReferralQr, countReferralIssuedThisMonth,
    getSettings, updateSettings,
    resetAll, seedDemoData,
  };
  console.log('[Gymplus] Supabase 接続モードで起動');
})();
