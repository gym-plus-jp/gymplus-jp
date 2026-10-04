/* Jumpolin クーポンシステム — Firestore 実装
 *
 * 既存 db.js / db-supabase.js と同一の API（window.DB.*）を提供。
 * config.js に FIREBASE_CONFIG が設定されているとき、このファイルが優先ロードされる。
 * Firebase JS SDK (compat) を <script> 経由で読み込んでから使用する。
 *
 * 全操作は Firestore の 7 コレクションで完結：
 *   students / campaigns / coupons / referral_qrs / referral_rewards / redemptions / settings
 */
(function () {
  const cfg = window.GYMPLUS_CONFIG || {};
  if (!cfg.FIREBASE_CONFIG) return; // Firebase 未設定 → LocalStorage版にフォールバック
  if (!window.firebase || !window.firebase.initializeApp) {
    console.warn('[Gymplus] Firebase SDK が未ロードです。db-firebase.js はスキップ');
    return;
  }

  // Firebase 初期化（1回のみ）
  if (!window.firebase.apps.length) {
    window.firebase.initializeApp(cfg.FIREBASE_CONFIG);
  }
  const db = window.firebase.firestore();

  // ===== 共通ヘルパー =====
  function uid(prefix) {
    return (prefix || 'id') + '_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  }
  function nowIso() { return new Date().toISOString(); }
  // Firestore Timestamp / Date / string → ISO string
  function toIso(v) {
    if (!v) return null;
    if (typeof v === 'string') return v;
    if (v && typeof v.toDate === 'function') return v.toDate().toISOString();
    if (v instanceof Date) return v.toISOString();
    return String(v);
  }
  // ドキュメントから安全に返す形（各フィールドを Iso 化）
  function mapStudent(id, d) {
    return {
      id, token: d.token,
      name: d.name, club: d.club, phoneLast4: d.phoneLast4,
      createdAt: toIso(d.createdAt),
      verifiedDevice: !!d.verifiedDevice,
    };
  }
  function mapCampaign(id, d) {
    return {
      id, type: d.type, label: d.label, detail: d.detail,
      expiresAt: toIso(d.expiresAt),
      createdAt: toIso(d.createdAt),
    };
  }
  function mapCoupon(id, d) {
    return {
      id, token: d.token,
      studentId: d.studentId, campaignId: d.campaignId,
      type: d.type, label: d.label, detail: d.detail,
      expiresAt: toIso(d.expiresAt),
      issuedAt: toIso(d.issuedAt),
      usedAt: toIso(d.usedAt),
      usedBy: d.usedBy || null,
    };
  }
  function mapReferralQr(id, d) {
    return {
      id, token: d.token,
      issuerStudentId: d.issuerStudentId, issuerName: d.issuerName,
      issuedAt: toIso(d.issuedAt),
      expiresAt: toIso(d.expiresAt),
      usedAt: toIso(d.usedAt),
      usedByName: d.usedByName || null,
    };
  }
  function mapReward(id, d) {
    return {
      id, token: d.token,
      studentId: d.studentId, sourceReferralId: d.sourceReferralId,
      label: d.label,
      issuedAt: toIso(d.issuedAt),
      usedAt: toIso(d.usedAt),
    };
  }
  function mapRedemption(id, d) {
    return {
      id, kind: d.kind, refId: d.refId,
      at: toIso(d.at), by: d.by || null,
    };
  }
  async function snapshotDocs(colRef, mapper) {
    const snap = await colRef.get();
    return snap.docs.map(doc => mapper(doc.id, doc.data()));
  }

  // ===== Students =====
  async function getStudents() {
    // 単一コレクション + orderByのみは単一フィールドインデックスで動くはずだが、
    // 保険として JS 側でソートに統一
    const arr = await snapshotDocs(db.collection('students'), mapStudent);
    return arr.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
  }
  async function getStudentByToken(token) {
    const snap = await db.collection('students').where('token', '==', token).limit(1).get();
    if (snap.empty) return null;
    const d = snap.docs[0];
    return mapStudent(d.id, d.data());
  }
  async function getStudentById(id) {
    const doc = await db.collection('students').doc(id).get();
    if (!doc.exists) return null;
    return mapStudent(doc.id, doc.data());
  }
  async function addStudent({ name, club, phoneLast4 }) {
    const id = uid('stu');
    const token = uid('tk');
    const data = { token, name, club, phoneLast4, createdAt: nowIso(), verifiedDevice: false };
    await db.collection('students').doc(id).set(data);
    return { id, ...data };
  }
  async function upsertStudent({ name, club, phoneLast4 }) {
    const normalized = name.replace(/\s+/g, '');
    const snap = await db.collection('students').where('phoneLast4', '==', phoneLast4).get();
    const existingDoc = snap.docs.find(d => (d.data().name || '').replace(/\s+/g, '') === normalized);
    if (existingDoc) {
      const cur = existingDoc.data();
      if (club && cur.club !== club) {
        await existingDoc.ref.update({ club });
        cur.club = club;
      }
      return { student: mapStudent(existingDoc.id, cur), created: false };
    }
    const created = await addStudent({ name, club, phoneLast4 });
    return { student: created, created: true };
  }
  async function markStudentVerified(studentId) {
    await db.collection('students').doc(studentId).update({ verifiedDevice: true });
  }
  async function deleteStudent(studentId) {
    // 関連レコードも削除（Firestore はカスケード無し、手動）
    const batch = db.batch();
    batch.delete(db.collection('students').doc(studentId));
    const coupons = await db.collection('coupons').where('studentId', '==', studentId).get();
    coupons.forEach(d => batch.delete(d.ref));
    const refs = await db.collection('referral_qrs').where('issuerStudentId', '==', studentId).get();
    refs.forEach(d => batch.delete(d.ref));
    const rewards = await db.collection('referral_rewards').where('studentId', '==', studentId).get();
    rewards.forEach(d => batch.delete(d.ref));
    await batch.commit();
  }

  // ===== Coupons =====
  async function getCouponsForStudent(studentId) {
    // 複合インデックス不要にするため where のみで取得→JS 側でソート
    const arr = await snapshotDocs(
      db.collection('coupons').where('studentId', '==', studentId),
      mapCoupon
    );
    return arr.sort((a, b) => (b.issuedAt || '').localeCompare(a.issuedAt || ''));
  }
  async function getCouponByToken(token) {
    const snap = await db.collection('coupons').where('token', '==', token).limit(1).get();
    if (snap.empty) return null;
    const d = snap.docs[0];
    return mapCoupon(d.id, d.data());
  }
  async function issueCouponToAll({ type, label, detail, expiresAt }) {
    const campaignId = uid('cmp');
    const createdAt = nowIso();
    await db.collection('campaigns').doc(campaignId).set({
      type, label, detail, expiresAt, createdAt,
    });
    const studentsSnap = await db.collection('students').get();
    if (studentsSnap.empty) return 0;
    // 500 doc単位のbatch制約を超えないように分割
    let count = 0;
    const chunks = [];
    let batch = db.batch();
    studentsSnap.forEach(sdoc => {
      const cid = uid('cp');
      batch.set(db.collection('coupons').doc(cid), {
        token: uid('cpt'),
        studentId: sdoc.id,
        campaignId,
        type, label, detail, expiresAt,
        issuedAt: nowIso(),
        usedAt: null, usedBy: null,
      });
      count++;
      if (count % 400 === 0) { chunks.push(batch); batch = db.batch(); }
    });
    chunks.push(batch);
    for (const b of chunks) await b.commit();
    return count;
  }
  async function issueActiveCampaignsToStudent(studentId) {
    const now = nowIso();
    const snap = await db.collection('campaigns').get();
    let count = 0;
    for (const cmpDoc of snap.docs) {
      const cmp = cmpDoc.data();
      if (cmp.expiresAt && cmp.expiresAt < now) continue; // 期限切れはスキップ
      const existing = await db.collection('coupons')
        .where('studentId', '==', studentId)
        .where('campaignId', '==', cmpDoc.id).limit(1).get();
      if (!existing.empty) continue;
      await db.collection('coupons').doc(uid('cp')).set({
        token: uid('cpt'),
        studentId, campaignId: cmpDoc.id,
        type: cmp.type, label: cmp.label, detail: cmp.detail,
        expiresAt: cmp.expiresAt || null,
        issuedAt: nowIso(),
        usedAt: null, usedBy: null,
      });
      count++;
    }
    return count;
  }
  async function redeemCoupon(couponId, staffNote = '受付') {
    const ref = db.collection('coupons').doc(couponId);
    const doc = await ref.get();
    if (!doc.exists) return { ok: false, reason: 'not_found' };
    const c = doc.data();
    if (c.usedAt) return { ok: false, reason: 'already_used', coupon: mapCoupon(doc.id, c) };
    if (c.expiresAt && new Date(c.expiresAt) < new Date()) {
      return { ok: false, reason: 'expired', coupon: mapCoupon(doc.id, c) };
    }
    const usedAt = nowIso();
    await ref.update({ usedAt, usedBy: staffNote });
    await db.collection('redemptions').doc(uid('rd')).set({
      kind: 'coupon', refId: couponId, at: usedAt, by: staffNote,
    });
    const updated = { ...c, usedAt, usedBy: staffNote };
    return { ok: true, coupon: mapCoupon(doc.id, updated) };
  }

  // ===== Referral QRs =====
  async function getReferralQrsForStudent(studentId) {
    // 複合インデックス不要にするため where のみで取得→JS 側でソート
    const arr = await snapshotDocs(
      db.collection('referral_qrs').where('issuerStudentId', '==', studentId),
      mapReferralQr
    );
    return arr.sort((a, b) => (b.issuedAt || '').localeCompare(a.issuedAt || ''));
  }
  async function countReferralIssuedThisMonth(studentId) {
    // 複合インデックス不要にするため where は issuerStudentId のみ→JS 側で月絞り
    const snap = await db.collection('referral_qrs')
      .where('issuerStudentId', '==', studentId).get();
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    let n = 0;
    snap.forEach(d => { if ((d.data().issuedAt || '') >= monthStart) n++; });
    return n;
  }
  async function issueReferralQr(studentId) {
    const student = await getStudentById(studentId);
    if (!student) return { ok: false, reason: 'student_not_found' };
    const settings = await getSettings();
    const monthCount = await countReferralIssuedThisMonth(studentId);
    if (monthCount >= settings.referralLimitPerMonth) {
      return { ok: false, reason: 'monthly_limit', limit: settings.referralLimitPerMonth };
    }
    const id = uid('rf');
    const token = uid('rft');
    const issuedAt = nowIso();
    const expiresAt = new Date(Date.now() + settings.referralExpireDays * 86400 * 1000).toISOString();
    const data = {
      token, issuerStudentId: studentId, issuerName: student.name,
      issuedAt, expiresAt, usedAt: null, usedByName: null,
    };
    await db.collection('referral_qrs').doc(id).set(data);
    return { ok: true, referral: { id, ...data } };
  }
  async function getReferralByToken(token) {
    const snap = await db.collection('referral_qrs').where('token', '==', token).limit(1).get();
    if (snap.empty) return null;
    const d = snap.docs[0];
    return mapReferralQr(d.id, d.data());
  }
  async function redeemReferralQr(referralId, friendName, staffNote = '受付') {
    const ref = db.collection('referral_qrs').doc(referralId);
    const doc = await ref.get();
    if (!doc.exists) return { ok: false, reason: 'not_found' };
    const r = doc.data();
    if (r.usedAt) return { ok: false, reason: 'already_used', referral: mapReferralQr(doc.id, r) };
    if (new Date(r.expiresAt) < new Date()) {
      return { ok: false, reason: 'expired', referral: mapReferralQr(doc.id, r) };
    }
    const usedAt = nowIso();
    const usedByName = friendName || '(記名なし)';
    await ref.update({ usedAt, usedByName });
    await db.collection('redemptions').doc(uid('rd')).set({
      kind: 'referral', refId: referralId, at: usedAt, by: staffNote,
    });

    const settings = await getSettings();
    const rewardId = uid('rw');
    const rewardToken = uid('rwt');
    await db.collection('referral_rewards').doc(rewardId).set({
      token: rewardToken,
      studentId: r.issuerStudentId,
      sourceReferralId: referralId,
      label: settings.referrerRewardLabel,
      issuedAt: usedAt, usedAt: null,
    });
    const friendlyCouponId = uid('cp');
    const friendlyExpires = new Date(Date.now() + 60 * 86400 * 1000).toISOString();
    const friendlyCoupon = {
      token: rewardToken,
      studentId: r.issuerStudentId,
      campaignId: null,
      type: 'referral_reward',
      label: '紹介ありがとう特典',
      detail: settings.referrerRewardLabel + '(' + usedByName + 'さんを紹介)',
      expiresAt: friendlyExpires,
      issuedAt: usedAt, usedAt: null, usedBy: null,
    };
    await db.collection('coupons').doc(friendlyCouponId).set(friendlyCoupon);

    return {
      ok: true,
      referral: mapReferralQr(doc.id, { ...r, usedAt, usedByName }),
      reward: mapCoupon(friendlyCouponId, friendlyCoupon),
    };
  }

  // ===== 全体クエリ =====
  async function getAllCoupons() {
    return snapshotDocs(db.collection('coupons'), mapCoupon);
  }
  async function getAllReferralQrs() {
    return snapshotDocs(db.collection('referral_qrs'), mapReferralQr);
  }
  async function getRedemptions() {
    const arr = await snapshotDocs(db.collection('redemptions'), mapRedemption);
    return arr.sort((a, b) => (b.at || '').localeCompare(a.at || ''));
  }

  // ===== Settings =====
  const DEFAULT_SETTINGS = {
    siteName: 'Jumpolin(トランポリンパーク)',
    referralLimitPerMonth: 2,
    referralExpireDays: 14,
    referrerRewardLabel: '次回ドリンク1本無料',
  };
  async function getSettings() {
    const doc = await db.collection('settings').doc('global').get();
    if (!doc.exists) {
      await db.collection('settings').doc('global').set(DEFAULT_SETTINGS);
      return { ...DEFAULT_SETTINGS };
    }
    return { ...DEFAULT_SETTINGS, ...doc.data() };
  }
  async function updateSettings(patch) {
    await db.collection('settings').doc('global').set(patch, { merge: true });
  }

  // ===== Reset / Demo =====
  async function resetAll() {
    const collections = ['students','coupons','campaigns','referral_qrs','referral_rewards','redemptions','settings'];
    for (const col of collections) {
      let snap;
      do {
        snap = await db.collection(col).limit(400).get();
        if (snap.empty) break;
        const batch = db.batch();
        snap.forEach(d => batch.delete(d.ref));
        await batch.commit();
      } while (snap.size === 400);
    }
  }
  async function seedDemoData() {
    const existing = await db.collection('students').limit(1).get();
    if (!existing.empty) return false;
    const demos = [
      { name: '佐藤 ひかり', club: 'AGC',     phoneLast4: '1234' },
      { name: '田中 あおい', club: 'Bullets', phoneLast4: '5678' },
      { name: '鈴木 けんと', club: 'AGC',     phoneLast4: '9012' },
    ];
    for (const d of demos) await addStudent(d);
    await issueCouponToAll({
      type: '誕生月特典', label: '誕生月300円引き',
      detail: '誕生月中1回まで利用料300円引き', expiresAt: '2026-12-31T23:59:59',
    });
    await issueCouponToAll({
      type: '割引券', label: '利用料500円OFF',
      detail: '通常利用料から500円引き。1回のみ利用可', expiresAt: '2026-07-31T23:59:59',
    });
    await issueCouponToAll({
      type: 'オマケ', label: 'ドリンク1本無料',
      detail: 'お好きなソフトドリンクを1本無料でプレゼント', expiresAt: '2026-07-15T23:59:59',
    });
    return true;
  }

  window.DB = {
    isFirebase: true,
    getStudents, getStudentByToken, getStudentById,
    addStudent, upsertStudent, markStudentVerified, deleteStudent,
    getCouponsForStudent, issueCouponToAll, issueActiveCampaignsToStudent,
    getCouponByToken, redeemCoupon,
    getReferralQrsForStudent, issueReferralQr, getReferralByToken,
    redeemReferralQr, countReferralIssuedThisMonth,
    getAllCoupons, getAllReferralQrs, getRedemptions,
    getSettings, updateSettings,
    resetAll, seedDemoData,
  };
  console.log('[Gymplus] Firebase モードで起動 (project: ' + cfg.FIREBASE_CONFIG.projectId + ')');
})();
