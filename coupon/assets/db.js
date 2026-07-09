/* データストア層（LocalStorage版フォールバック）
 * config.js で Supabase URL/Key が設定されていれば db-supabase.js が window.DB を先に登録するため
 * このファイルは Supabase 未設定時のみ有効化される。
 * 全関数 async にしてSupabase版とAPI互換。
 */

(function () {
  // Supabase 版が先にロードされていればスキップ
  if (window.DB && window.DB.isSupabase) return;

  const DB_KEY = 'gymplus_coupon_v1';

  function load() {
    const raw = localStorage.getItem(DB_KEY);
    if (raw) {
      try { return JSON.parse(raw); } catch (e) {}
    }
    return {
      students: [], coupons: [], campaigns: [],
      referralQrs: [], referralRewards: [], redemptions: [],
      settings: {
        siteName: 'Jumpolin(トランポリンパーク)',
        referralLimitPerMonth: 2,
        referralExpireDays: 14,
        referrerRewardLabel: '次回ドリンク1本無料',
      },
    };
  }
  function save(db) { localStorage.setItem(DB_KEY, JSON.stringify(db)); }
  function uid(prefix = 'id') {
    return prefix + '_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  }

  async function getStudents() { return load().students; }
  async function getStudentByToken(token) { return load().students.find(s => s.token === token); }
  async function getStudentById(id) { return load().students.find(s => s.id === id); }

  async function addStudent({ name, club, phoneLast4 }) {
    const db = load();
    const student = {
      id: uid('stu'), token: uid('tk'),
      name, club, phoneLast4,
      createdAt: new Date().toISOString(), verifiedDevice: false,
    };
    db.students.push(student);
    save(db);
    return student;
  }

  async function upsertStudent({ name, club, phoneLast4 }) {
    const normalized = name.replace(/\s+/g, '');
    const db = load();
    const existing = db.students.find(s =>
      s.name.replace(/\s+/g, '') === normalized && s.phoneLast4 === phoneLast4
    );
    if (existing) {
      let updated = false;
      if (club && existing.club !== club) { existing.club = club; updated = true; }
      if (updated) save(db);
      return { student: existing, created: false };
    }
    return { student: await addStudent({ name, club, phoneLast4 }), created: true };
  }

  async function markStudentVerified(studentId) {
    const db = load();
    const s = db.students.find(x => x.id === studentId);
    if (s) { s.verifiedDevice = true; save(db); }
  }

  async function deleteStudent(studentId) {
    const db = load();
    db.students = db.students.filter(s => s.id !== studentId);
    db.coupons = db.coupons.filter(c => c.studentId !== studentId);
    db.referralQrs = db.referralQrs.filter(r => r.issuerStudentId !== studentId);
    db.referralRewards = db.referralRewards.filter(r => r.studentId !== studentId);
    save(db);
  }

  async function getCouponsForStudent(studentId) {
    return load().coupons.filter(c => c.studentId === studentId);
  }

  async function issueCouponToAll({ type, label, detail, expiresAt }) {
    const db = load();
    const campaign = {
      id: uid('cmp'), type, label, detail, expiresAt,
      createdAt: new Date().toISOString(),
    };
    if (!db.campaigns) db.campaigns = [];
    db.campaigns.push(campaign);
    let count = 0;
    db.students.forEach(s => {
      db.coupons.push({
        id: uid('cp'), token: uid('cpt'),
        studentId: s.id, campaignId: campaign.id,
        type, label, detail, expiresAt,
        issuedAt: new Date().toISOString(),
        usedAt: null, usedBy: null,
      });
      count++;
    });
    save(db);
    return count;
  }

  async function issueActiveCampaignsToStudent(studentId) {
    const db = load();
    if (!db.campaigns) db.campaigns = [];
    const now = new Date();
    const active = db.campaigns.filter(c => !c.expiresAt || new Date(c.expiresAt) >= now);
    let count = 0;
    active.forEach(cmp => {
      const exists = db.coupons.some(c => c.studentId === studentId && c.campaignId === cmp.id);
      if (exists) return;
      db.coupons.push({
        id: uid('cp'), token: uid('cpt'),
        studentId, campaignId: cmp.id,
        type: cmp.type, label: cmp.label, detail: cmp.detail,
        expiresAt: cmp.expiresAt,
        issuedAt: new Date().toISOString(),
        usedAt: null, usedBy: null,
      });
      count++;
    });
    save(db);
    return count;
  }

  async function getCouponByToken(token) {
    return load().coupons.find(c => c.token === token);
  }

  async function redeemCoupon(couponId, staffNote = 'スタッフ') {
    const db = load();
    const c = db.coupons.find(x => x.id === couponId);
    if (!c) return { ok: false, reason: 'not_found' };
    if (c.usedAt) return { ok: false, reason: 'already_used', coupon: c };
    if (c.expiresAt && new Date(c.expiresAt) < new Date()) {
      return { ok: false, reason: 'expired', coupon: c };
    }
    c.usedAt = new Date().toISOString();
    c.usedBy = staffNote;
    db.redemptions.push({ id: uid('rd'), kind: 'coupon', refId: c.id, at: c.usedAt, by: staffNote });
    save(db);
    return { ok: true, coupon: c };
  }

  async function getReferralQrsForStudent(studentId) {
    return load().referralQrs.filter(r => r.issuerStudentId === studentId);
  }

  async function countReferralIssuedThisMonth(studentId) {
    const now = new Date();
    const y = now.getFullYear(), m = now.getMonth();
    return load().referralQrs.filter(r => {
      if (r.issuerStudentId !== studentId) return false;
      const d = new Date(r.issuedAt);
      return d.getFullYear() === y && d.getMonth() === m;
    }).length;
  }

  async function issueReferralQr(studentId) {
    const db = load();
    const s = db.students.find(x => x.id === studentId);
    if (!s) return { ok: false, reason: 'student_not_found' };
    const monthCount = await countReferralIssuedThisMonth(studentId);
    if (monthCount >= db.settings.referralLimitPerMonth) {
      return { ok: false, reason: 'monthly_limit', limit: db.settings.referralLimitPerMonth };
    }
    const expireDays = db.settings.referralExpireDays;
    const r = {
      id: uid('rf'), token: uid('rft'),
      issuerStudentId: studentId, issuerName: s.name,
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + expireDays * 86400 * 1000).toISOString(),
      usedAt: null, usedByName: null,
    };
    db.referralQrs.push(r);
    save(db);
    return { ok: true, referral: r };
  }

  async function getReferralByToken(token) {
    return load().referralQrs.find(r => r.token === token);
  }

  async function redeemReferralQr(referralId, friendName, staffNote = 'スタッフ') {
    const db = load();
    const r = db.referralQrs.find(x => x.id === referralId);
    if (!r) return { ok: false, reason: 'not_found' };
    if (r.usedAt) return { ok: false, reason: 'already_used', referral: r };
    if (new Date(r.expiresAt) < new Date()) {
      return { ok: false, reason: 'expired', referral: r };
    }
    r.usedAt = new Date().toISOString();
    r.usedByName = friendName || '(記名なし)';
    db.redemptions.push({ id: uid('rd'), kind: 'referral', refId: r.id, at: r.usedAt, by: staffNote });
    const reward = {
      id: uid('rw'), token: uid('rwt'),
      studentId: r.issuerStudentId, sourceReferralId: r.id,
      label: db.settings.referrerRewardLabel,
      issuedAt: new Date().toISOString(), usedAt: null,
    };
    db.referralRewards.push(reward);
    const friendlyCoupon = {
      id: uid('cp'), token: reward.token,
      studentId: r.issuerStudentId,
      type: 'referral_reward',
      label: '紹介ありがとう特典',
      detail: db.settings.referrerRewardLabel + '(' + r.usedByName + 'さんを紹介)',
      expiresAt: new Date(Date.now() + 60 * 86400 * 1000).toISOString(),
      issuedAt: reward.issuedAt, usedAt: null, usedBy: null,
    };
    db.coupons.push(friendlyCoupon);
    save(db);
    return { ok: true, referral: r, reward: friendlyCoupon };
  }

  async function getAllCoupons() { return load().coupons; }
  async function getAllReferralQrs() { return load().referralQrs; }
  async function getRedemptions() {
    return [...load().redemptions].sort((a,b) => b.at.localeCompare(a.at));
  }

  async function getSettings() { return load().settings; }
  async function updateSettings(patch) {
    const db = load();
    db.settings = { ...db.settings, ...patch };
    save(db);
  }

  async function resetAll() { localStorage.removeItem(DB_KEY); }

  async function seedDemoData() {
    const db = load();
    if (db.students.length > 0) return false;
    const demos = [
      { name: '佐藤 ひかり', club: 'AGC', phoneLast4: '1234' },
      { name: '田中 あおい', club: 'Bullets', phoneLast4: '5678' },
      { name: '鈴木 けんと', club: 'AGC', phoneLast4: '9012' },
    ];
    for (const d of demos) await addStudent(d);
    await issueCouponToAll({
      type: '誕生月特典', label: '6月生まれ特典:利用料20%OFF',
      detail: '誕生月の方限定。1回のみ利用可', expiresAt: '2026-06-30T23:59:59',
    });
    await issueCouponToAll({
      type: '割引券', label: '夏休み先取りキャンペーン:500円OFF',
      detail: '通常利用料から500円引き', expiresAt: '2026-07-31T23:59:59',
    });
    await issueCouponToAll({
      type: 'オマケ', label: '初夏のドリンクサービス',
      detail: 'お好きなソフトドリンク1本プレゼント', expiresAt: '2026-07-15T23:59:59',
    });
    return true;
  }

  window.DB = {
    isSupabase: false,
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
  console.log('[Gymplus] LocalStorage モードで起動');
})();
