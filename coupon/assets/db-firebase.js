/* Jumpolin クーポンシステム — Firestore 実装
 *
 * 既存 db.js / db-supabase.js と同一の API（window.DB.*）を提供。
 * config.js に FIREBASE_CONFIG が設定されているとき、このファイルが優先ロードされる。
 * Firebase JS SDK (compat: app / auth / firestore) を <script> 経由で読み込んでから使用する。
 *
 * 2026-11-10 セキュリティ改訂：
 *   - どの端末も Firebase の匿名ログインを使う（会員はログイン画面なしのまま）。
 *   - 会員の記録はマイページURLの token を知っている端末だけが読める
 *     （student_tokens で会員IDを引き、links/{uid} に結びつけてから読む）。
 *   - 運営の操作（一覧・使用済み化・設定・削除）は staffs/{uid} に登録された端末だけ。
 *   - 権限の最終判断は firestore.rules。ここでの分岐は画面の出し分けのため。
 *
 * コレクション：
 *   students / campaigns / coupons / referral_qrs / referral_rewards / redemptions / settings
 *   student_tokens / student_keys / links / staffs / staff_claims / staff_invites
 */
(function () {
  const cfg = window.GYMPLUS_CONFIG || {};
  if (!cfg.FIREBASE_CONFIG) return; // Firebase 未設定 → LocalStorage版にフォールバック
  if (!window.firebase || !window.firebase.initializeApp || !window.firebase.auth) {
    console.warn('[Gymplus] Firebase SDK が未ロードです。db-firebase.js はスキップ');
    return;
  }

  // Firebase 初期化（1回のみ）
  if (!window.firebase.apps.length) {
    window.firebase.initializeApp(cfg.FIREBASE_CONFIG);
  }
  const db = window.firebase.firestore();
  const auth = window.firebase.auth();

  // 匿名ログイン（前回のログインが残っていればそれを使う）
  const ready = new Promise(resolve => {
    let tried = false;
    auth.onAuthStateChanged(async user => {
      if (user) return resolve(user);
      if (tried) return;
      tried = true;
      try { await auth.signInAnonymously(); }
      catch (e) { console.error('[Gymplus] 匿名ログインに失敗', e); resolve(null); }
    });
  });
  function myUid() { return auth.currentUser ? auth.currentUser.uid : null; }

  // ===== 共通ヘルパー =====
  // 推測できない文字列（crypto 由来）
  function randomToken(len) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const bytes = new Uint8Array(len);
    crypto.getRandomValues(bytes);
    let s = '';
    for (const b of bytes) s += chars[b % 62];
    return s;
  }
  function uid(prefix) { return (prefix || 'id') + '_' + randomToken(12); }
  function newToken(prefix) { return (prefix || 'tk') + '_' + randomToken(24); }
  function isTokenLike(s) { return typeof s === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(s); }
  async function sha256Hex(str) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  }
  // 重複登録の確認キー（名前の空白を除き、電話下4桁と合わせたハッシュ）
  function normalizeName(name) { return String(name || '').normalize('NFKC').replace(/\s+/g, ''); }
  function dupKeyOf(name, phoneLast4) {
    return sha256Hex('gymplus-coupon-v1|' + normalizeName(name) + '|' + phoneLast4);
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
  function isDenied(e) { return e && (e.code === 'permission-denied' || /permission/i.test(e.message || '')); }

  // ドキュメントから安全に返す形（各フィールドを Iso 化）
  function mapStudent(id, d) {
    return {
      id, token: d.token,
      name: d.name, club: d.club, phoneLast4: d.phoneLast4,
      createdAt: toIso(d.createdAt),
      verifiedDevice: !!d.verifiedDevice,
      dupKey: d.dupKey || null,
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
  function mapRedemption(id, d) {
    return {
      id, kind: d.kind, refId: d.refId,
      at: toIso(d.at), by: d.by || null,
    };
  }
  async function snapshotDocs(query, mapper) {
    const snap = await query.get();
    return snap.docs.map(doc => mapper(doc.id, doc.data()));
  }

  // ===== 運営の端末 =====
  // 戻り値：'admin' / 'staff' / null（未登録）
  async function getMyRole() {
    const id = myUid();
    if (!id) return null;
    try {
      const doc = await db.collection('staffs').doc(id).get();
      if (!doc.exists) return null;
      const role = doc.data().role || null;
      // 最終利用日時（1時間に1回だけ記録）
      const k = 'gymplus_staff_seen_' + id;
      if (Date.now() - Number(localStorage.getItem(k) || 0) > 3600 * 1000) {
        localStorage.setItem(k, String(Date.now()));
        doc.ref.update({ lastSeenAt: nowIso() }).catch(() => {});
      }
      return role;
    } catch (e) {
      return null;
    }
  }
  // 登録URLの秘密の文字列で、この端末を運営として登録する
  async function claimStaffInvite(secret) {
    const id = myUid();
    if (!id) return { ok: false, reason: 'no_auth' };
    secret = String(secret || '').trim();
    if (secret.length < 20) return { ok: false, reason: 'invalid' };
    const h = await sha256Hex(secret);
    let inv;
    try {
      const doc = await db.collection('staff_invites').doc(h).get();
      if (!doc.exists) return { ok: false, reason: 'used_or_missing' };
      inv = doc.data();
    } catch (e) {
      return { ok: false, reason: 'used_or_missing' };
    }
    if (inv.expiresAt && inv.expiresAt.toDate() < new Date()) return { ok: false, reason: 'expired' };
    const batch = db.batch();
    batch.set(db.collection('staff_claims').doc(id), { secret });
    batch.set(db.collection('staffs').doc(id), {
      role: inv.role, label: inv.label, createdAt: nowIso(), inviteId: h, lastSeenAt: nowIso(),
    });
    batch.delete(db.collection('staff_invites').doc(h));
    try {
      await batch.commit();
    } catch (e) {
      console.error(e);
      return { ok: false, reason: 'denied' };
    }
    return { ok: true, role: inv.role, label: inv.label };
  }
  // 管理者用：登録URLを発行する（7日間有効・1回だけ使える）
  async function createStaffInvite({ role, label }) {
    const secret = randomToken(32);
    const h = await sha256Hex(secret);
    await db.collection('staff_invites').doc(h).set({
      role, label, createdAt: nowIso(),
      expiresAt: window.firebase.firestore.Timestamp.fromDate(new Date(Date.now() + 7 * 86400 * 1000)),
    });
    const base = location.href.replace(/\/[^/]*$/, '');
    return { id: h, url: base + '/setup.html#k=' + secret };
  }
  async function getStaffs() {
    const arr = await snapshotDocs(db.collection('staffs'), (id, d) => ({
      id, role: d.role, label: d.label, createdAt: toIso(d.createdAt), lastSeenAt: toIso(d.lastSeenAt),
      isMe: id === myUid(),
    }));
    return arr.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
  }
  async function getStaffInvites() {
    const arr = await snapshotDocs(db.collection('staff_invites'), (id, d) => ({
      id, role: d.role, label: d.label, createdAt: toIso(d.createdAt), expiresAt: toIso(d.expiresAt),
    }));
    return arr.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  }
  async function deleteStaff(staffUid) {
    await db.collection('staffs').doc(staffUid).delete();
    await db.collection('staff_claims').doc(staffUid).delete().catch(() => {});
  }
  async function deleteStaffInvite(id) {
    await db.collection('staff_invites').doc(id).delete();
  }

  // ===== Students =====
  async function getStudents() {
    // 単一コレクション + orderByのみは単一フィールドインデックスで動くはずだが、
    // 保険として JS 側でソートに統一
    const arr = await snapshotDocs(db.collection('students'), mapStudent);
    return arr.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
  }
  // マイページ：token から会員を引き、この端末をその会員に結びつける
  async function getStudentByToken(token, opts) {
    const link = !(opts && opts.link === false);
    if (!isTokenLike(token)) return null;
    let sid;
    try {
      const t = await db.collection('student_tokens').doc(token).get();
      if (!t.exists) return null;
      sid = t.data().sid;
    } catch (e) {
      return null;
    }
    if (link) {
      const ref = db.collection('links').doc(myUid());
      const cur = await ref.get().catch(() => null);
      if (!cur || !cur.exists || cur.data().sid !== sid) await ref.set({ sid, token });
    }
    return getStudentById(sid);
  }
  async function getStudentById(id) {
    if (!id) return null;
    try {
      const doc = await db.collection('students').doc(id).get();
      if (!doc.exists) return null;
      return mapStudent(doc.id, doc.data());
    } catch (e) {
      if (isDenied(e)) return null; // 未登録の端末では会員情報は読めない
      throw e;
    }
  }
  // 会員の作成：会員本体・token の引き当て表・重複確認の鍵を一度に書く。
  // 同じ名前＋電話下4桁が既にあると鍵の作成が拒否され、全体が失敗する（= 登録済み）
  async function createStudent({ name, club, phoneLast4 }, linkToMe) {
    name = String(name || '').trim();
    const id = uid('stu');
    const token = newToken('tk');
    const dupKey = await dupKeyOf(name, phoneLast4);
    const data = { token, name, club, phoneLast4, createdAt: nowIso(), verifiedDevice: !!linkToMe, dupKey };
    const batch = db.batch();
    batch.set(db.collection('students').doc(id), data);
    batch.set(db.collection('student_tokens').doc(token), { sid: id });
    batch.set(db.collection('student_keys').doc(dupKey), { sid: id });
    if (linkToMe) batch.set(db.collection('links').doc(myUid()), { sid: id, token });
    try {
      await batch.commit();
    } catch (e) {
      if (isDenied(e)) return { duplicate: true };
      throw e;
    }
    return { student: mapStudent(id, data), created: true };
  }
  async function addStudent({ name, club, phoneLast4 }) {
    const r = await createStudent({ name, club, phoneLast4 }, false);
    if (r.duplicate) {
      const err = new Error('duplicate');
      err.code = 'duplicate';
      throw err;
    }
    return r.student;
  }
  // 会員の自己登録（join.html）。登録済みなら { duplicate: true } を返す。
  // 他人のマイページを開けてしまわないよう、登録済みの会員の情報は返さない。
  async function upsertStudent({ name, club, phoneLast4 }) {
    return createStudent({ name, club, phoneLast4 }, true);
  }
  async function markStudentVerified(studentId) {
    await db.collection('students').doc(studentId).update({ verifiedDevice: true });
  }
  async function deleteStudent(studentId) {
    // 関連レコードも削除（Firestore はカスケード無し、手動）
    const sdoc = await db.collection('students').doc(studentId).get();
    const batch = db.batch();
    batch.delete(db.collection('students').doc(studentId));
    if (sdoc.exists) {
      const s = sdoc.data();
      if (s.token) batch.delete(db.collection('student_tokens').doc(s.token));
      if (s.dupKey) batch.delete(db.collection('student_keys').doc(s.dupKey));
    }
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
      batch.set(db.collection('coupons').doc(sdoc.id + '_' + campaignId), {
        token: newToken('cpt'),
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
      // ドキュメントIDを「会員ID_キャンペーンID」に固定して二重発行を防ぐ
      await db.collection('coupons').doc(studentId + '_' + cmpDoc.id).set({
        token: newToken('cpt'),
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
    const batch = db.batch();
    batch.update(ref, { usedAt, usedBy: staffNote });
    batch.set(db.collection('redemptions').doc(uid('rd')), {
      kind: 'coupon', refId: couponId, at: usedAt, by: staffNote,
    });
    await batch.commit();
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
    const token = newToken('rft');
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
    // 名前欄にタグや引用符・％は入れない（ルールで拒否されるため）
    const usedByName = (String(friendName || '').replace(/[<>&"'`%％]/g, '').slice(0, 40)) || '(記名なし)';
    const settings = await getSettings();
    const rewardToken = newToken('rwt');
    const friendlyCouponId = uid('cp');
    const friendlyExpires = new Date(Date.now() + 60 * 86400 * 1000).toISOString();
    const friendlyCoupon = {
      token: rewardToken,
      studentId: r.issuerStudentId,
      campaignId: null,
      type: 'referral_reward',
      label: '紹介ありがとう特典',
      detail: (settings.referrerRewardLabel + '(' + usedByName + 'さんを紹介)').slice(0, 200),
      expiresAt: friendlyExpires,
      issuedAt: usedAt, usedAt: null, usedBy: null,
    };
    const batch = db.batch();
    batch.update(ref, { usedAt, usedByName });
    batch.set(db.collection('redemptions').doc(uid('rd')), {
      kind: 'referral', refId: referralId, at: usedAt, by: staffNote,
    });
    batch.set(db.collection('referral_rewards').doc(uid('rw')), {
      token: rewardToken,
      studentId: r.issuerStudentId,
      sourceReferralId: referralId,
      label: settings.referrerRewardLabel,
      issuedAt: usedAt, usedAt: null,
    });
    batch.set(db.collection('coupons').doc(friendlyCouponId), friendlyCoupon);
    await batch.commit();

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
    if (!doc.exists) return { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS, ...doc.data() };
  }
  async function updateSettings(patch) {
    await db.collection('settings').doc('global').set(patch, { merge: true });
  }

  // ===== Reset / Demo（管理者のみ・ルールで制限） =====
  async function resetAll() {
    const collections = ['students','student_tokens','student_keys','coupons','campaigns','referral_qrs','referral_rewards','redemptions','settings'];
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
      detail: '誕生月中1回まで利用料300円引き', expiresAt: null, // 無期限（毎年の誕生月に使えるように）
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

  // すべての操作はログイン完了を待ってから行う
  const api = {
    getStudents, getStudentByToken, getStudentById,
    addStudent, upsertStudent, markStudentVerified, deleteStudent,
    getCouponsForStudent, issueCouponToAll, issueActiveCampaignsToStudent,
    getCouponByToken, redeemCoupon,
    getReferralQrsForStudent, issueReferralQr, getReferralByToken,
    redeemReferralQr, countReferralIssuedThisMonth,
    getAllCoupons, getAllReferralQrs, getRedemptions,
    getSettings, updateSettings,
    resetAll, seedDemoData,
    getMyRole, claimStaffInvite, createStaffInvite, getStaffs, getStaffInvites, deleteStaff, deleteStaffInvite,
  };
  window.DB = { isFirebase: true, ready, isDenied, myUid };
  Object.keys(api).forEach(k => {
    window.DB[k] = async (...args) => { await ready; return api[k](...args); };
  });
  console.log('[Gymplus] Firebase モードで起動 (project: ' + cfg.FIREBASE_CONFIG.projectId + ')');
})();
