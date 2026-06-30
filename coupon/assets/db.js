/* データストア層
 * 現状: LocalStorage（プロトタイプ）
 * 本番: Supabase に差し替え予定（API シグネチャを維持）
 */

const DB_KEY = 'gymplus_coupon_v1';

function load() {
  const raw = localStorage.getItem(DB_KEY);
  if (raw) {
    try { return JSON.parse(raw); } catch (e) { /* fallthrough */ }
  }
  return {
    students: [],
    coupons: [],
    campaigns: [],
    referralQrs: [],
    referralRewards: [],
    redemptions: [],
    settings: {
      siteName: 'Jumpolin（トランポリンパーク）',
      referralLimitPerMonth: 2,
      referralExpireDays: 14,
      referrerRewardLabel: '次回ドリンク1杯無料',
    },
  };
}

function save(db) {
  localStorage.setItem(DB_KEY, JSON.stringify(db));
}

function uid(prefix = 'id') {
  return prefix + '_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

// ===== Students =====
function getStudents() { return load().students; }

function getStudentByToken(token) {
  return load().students.find(s => s.token === token);
}

function getStudentById(id) {
  return load().students.find(s => s.id === id);
}

function addStudent({ name, club, phoneLast4 }) {
  const db = load();
  const student = {
    id: uid('stu'),
    token: uid('tk'),
    name,
    club,
    phoneLast4,
    createdAt: new Date().toISOString(),
    verifiedDevice: false,
  };
  db.students.push(student);
  save(db);
  return student;
}

// 自己登録用: 同名+電話下4桁が既にあれば既存を返す
function upsertStudent({ name, club, phoneLast4 }) {
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
  return { student: addStudent({ name, club, phoneLast4 }), created: true };
}

function markStudentVerified(studentId) {
  const db = load();
  const s = db.students.find(x => x.id === studentId);
  if (s) { s.verifiedDevice = true; save(db); }
}

function deleteStudent(studentId) {
  const db = load();
  db.students = db.students.filter(s => s.id !== studentId);
  db.coupons = db.coupons.filter(c => c.studentId !== studentId);
  db.referralQrs = db.referralQrs.filter(r => r.issuerStudentId !== studentId);
  db.referralRewards = db.referralRewards.filter(r => r.studentId !== studentId);
  save(db);
}

// ===== Coupons =====
function getCouponsForStudent(studentId) {
  return load().coupons.filter(c => c.studentId === studentId);
}

function issueCouponToAll({ type, label, detail, expiresAt }) {
  const db = load();
  const campaign = {
    id: uid('cmp'),
    type, label, detail, expiresAt,
    createdAt: new Date().toISOString(),
  };
  if (!db.campaigns) db.campaigns = [];
  db.campaigns.push(campaign);
  const ids = [];
  db.students.forEach(s => {
    const c = {
      id: uid('cp'),
      token: uid('cpt'),
      studentId: s.id,
      campaignId: campaign.id,
      type, label, detail,
      expiresAt,
      issuedAt: new Date().toISOString(),
      usedAt: null,
      usedBy: null,
    };
    db.coupons.push(c);
    ids.push(c.id);
  });
  save(db);
  return ids.length;
}

// 新規登録した生徒に、有効期限内のキャンペーンを自動配布
function issueActiveCampaignsToStudent(studentId) {
  const db = load();
  if (!db.campaigns) db.campaigns = [];
  const now = new Date();
  const active = db.campaigns.filter(c =>
    !c.expiresAt || new Date(c.expiresAt) >= now
  );
  active.forEach(cmp => {
    const exists = db.coupons.some(c =>
      c.studentId === studentId && c.campaignId === cmp.id
    );
    if (exists) return;
    db.coupons.push({
      id: uid('cp'),
      token: uid('cpt'),
      studentId,
      campaignId: cmp.id,
      type: cmp.type,
      label: cmp.label,
      detail: cmp.detail,
      expiresAt: cmp.expiresAt,
      issuedAt: new Date().toISOString(),
      usedAt: null,
      usedBy: null,
    });
  });
  save(db);
  return active.length;
}

function getCouponByToken(token) {
  return load().coupons.find(c => c.token === token);
}

function redeemCoupon(couponId, staffNote = 'スタッフ') {
  const db = load();
  const c = db.coupons.find(x => x.id === couponId);
  if (!c) return { ok: false, reason: 'not_found' };
  if (c.usedAt) return { ok: false, reason: 'already_used', coupon: c };
  if (c.expiresAt && new Date(c.expiresAt) < new Date()) {
    return { ok: false, reason: 'expired', coupon: c };
  }
  c.usedAt = new Date().toISOString();
  c.usedBy = staffNote;
  db.redemptions.push({
    id: uid('rd'), kind: 'coupon', refId: c.id, at: c.usedAt, by: staffNote
  });
  save(db);
  return { ok: true, coupon: c };
}

// ===== Referral QRs =====
function getReferralQrsForStudent(studentId) {
  return load().referralQrs.filter(r => r.issuerStudentId === studentId);
}

function countReferralIssuedThisMonth(studentId) {
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth();
  return load().referralQrs.filter(r => {
    if (r.issuerStudentId !== studentId) return false;
    const d = new Date(r.issuedAt);
    return d.getFullYear() === y && d.getMonth() === m;
  }).length;
}

function issueReferralQr(studentId) {
  const db = load();
  const s = db.students.find(x => x.id === studentId);
  if (!s) return { ok: false, reason: 'student_not_found' };
  const monthCount = countReferralIssuedThisMonth(studentId);
  if (monthCount >= db.settings.referralLimitPerMonth) {
    return { ok: false, reason: 'monthly_limit',
             limit: db.settings.referralLimitPerMonth };
  }
  const expireDays = db.settings.referralExpireDays;
  const expiresAt = new Date(Date.now() + expireDays * 86400 * 1000).toISOString();
  const r = {
    id: uid('rf'),
    token: uid('rft'),
    issuerStudentId: studentId,
    issuerName: s.name,
    issuedAt: new Date().toISOString(),
    expiresAt,
    usedAt: null,
    usedByName: null,
  };
  db.referralQrs.push(r);
  save(db);
  return { ok: true, referral: r };
}

function getReferralByToken(token) {
  return load().referralQrs.find(r => r.token === token);
}

function redeemReferralQr(referralId, friendName, staffNote = 'スタッフ') {
  const db = load();
  const r = db.referralQrs.find(x => x.id === referralId);
  if (!r) return { ok: false, reason: 'not_found' };
  if (r.usedAt) return { ok: false, reason: 'already_used', referral: r };
  if (new Date(r.expiresAt) < new Date()) {
    return { ok: false, reason: 'expired', referral: r };
  }
  r.usedAt = new Date().toISOString();
  r.usedByName = friendName || '（記名なし）';
  db.redemptions.push({
    id: uid('rd'), kind: 'referral', refId: r.id, at: r.usedAt, by: staffNote
  });
  // 紹介者へのリファラル特典を自動付与
  const reward = {
    id: uid('rw'),
    token: uid('rwt'),
    studentId: r.issuerStudentId,
    sourceReferralId: r.id,
    label: db.settings.referrerRewardLabel,
    issuedAt: new Date().toISOString(),
    usedAt: null,
  };
  db.referralRewards.push(reward);
  // 同時にcouponsにも転記して同じ画面で扱えるように
  const friendlyCoupon = {
    id: uid('cp'),
    token: reward.token, // 同じトークンでも区別可
    studentId: r.issuerStudentId,
    type: 'referral_reward',
    label: '紹介ありがとう特典',
    detail: db.settings.referrerRewardLabel + '（' + r.usedByName + 'さんを紹介）',
    expiresAt: new Date(Date.now() + 60 * 86400 * 1000).toISOString(),
    issuedAt: reward.issuedAt,
    usedAt: null,
    usedBy: null,
  };
  db.coupons.push(friendlyCoupon);
  save(db);
  return { ok: true, referral: r, reward: friendlyCoupon };
}

// ===== Settings =====
function getSettings() { return load().settings; }
function updateSettings(patch) {
  const db = load();
  db.settings = { ...db.settings, ...patch };
  save(db);
}

// ===== ユーティリティ =====
function resetAll() { localStorage.removeItem(DB_KEY); }

function seedDemoData() {
  const db = load();
  if (db.students.length > 0) return false;
  const demos = [
    { name: '佐藤 ひかり', club: '体操クラブ', phoneLast4: '1234' },
    { name: '田中 あおい', club: 'Bullets チア', phoneLast4: '5678' },
    { name: '鈴木 けんと', club: '体操クラブ', phoneLast4: '9012' },
  ];
  demos.forEach(d => addStudent(d));
  issueCouponToAll({
    type: '誕生月特典',
    label: '6月生まれ特典：入場料20%OFF',
    detail: '誕生月の方限定。1回のみ利用可',
    expiresAt: '2026-06-30T23:59:59',
  });
  issueCouponToAll({
    type: '割引券',
    label: '夏休み先取りキャンペーン：500円OFF',
    detail: '通常入場料から500円引き',
    expiresAt: '2026-07-31T23:59:59',
  });
  issueCouponToAll({
    type: 'オマケ',
    label: '初夏のドリンクサービス',
    detail: 'お好きなソフトドリンク1杯プレゼント',
    expiresAt: '2026-07-15T23:59:59',
  });
  return true;
}

window.DB = {
  load, save,
  getStudents, getStudentByToken, getStudentById,
  addStudent, upsertStudent, markStudentVerified, deleteStudent,
  getCouponsForStudent, issueCouponToAll, issueActiveCampaignsToStudent,
  getCouponByToken, redeemCoupon,
  getReferralQrsForStudent, issueReferralQr, getReferralByToken,
  redeemReferralQr, countReferralIssuedThisMonth,
  getSettings, updateSettings,
  resetAll, seedDemoData,
};
