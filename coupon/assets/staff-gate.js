/* 運営の端末かどうかを確かめる（admin.html / staff.html で使用）
 *
 * 2026-11-10：パスコード方式（admin-gate.js）を廃止。
 * 端末を運営として登録するには、管理者が発行した「登録用URL」をその端末で1回開く
 * （setup.html）か、下の入力欄に登録用URLを貼り付ける。
 * 本当の守りは firestore.rules 側。ここは画面の案内だけ。
 *
 * 使い方：const role = await StaffGate.check({ need: 'admin', block: true });
 */
(function () {
  const ROLE_NAME = { admin: '管理者', staff: '受付スタッフ' };

  function enough(role, need) {
    if (need === 'admin') return role === 'admin';
    return role === 'admin' || role === 'staff';
  }

  function extractSecret(text) {
    const m = String(text || '').match(/[#&?]k=([A-Za-z0-9_-]+)/);
    return m ? m[1] : String(text || '').trim();
  }

  function render(need, block) {
    const box = document.createElement('div');
    box.id = 'gp-staff-gate';
    box.style.cssText = block
      ? 'position:fixed; inset:0; z-index:999999; background:linear-gradient(135deg,#1e3a8a 0%,#2563eb 100%); display:flex; align-items:center; justify-content:center; padding:16px;'
      : 'position:sticky; top:0; z-index:999; background:#fee2e2; border-bottom:2px solid #dc2626; padding:12px 16px;';
    const inner = block
      ? 'background:#fff; border-radius:16px; padding:28px 24px; width:100%; max-width:420px; box-shadow:0 20px 60px rgba(0,0,0,0.3); text-align:center;'
      : 'max-width:720px; margin:0 auto; font-size:13px; line-height:1.7; color:#7f1d1d;';
    box.innerHTML = `
      <div style="${inner}">
        <div style="font-size:${block ? '20px' : '14px'}; font-weight:800; color:${block ? '#1e293b' : '#991b1b'}; margin-bottom:6px;">
          🔒 この端末は、まだ${ROLE_NAME[need]}として登録されていません
        </div>
        <div style="font-size:13px; color:${block ? '#64748b' : '#7f1d1d'}; margin-bottom:12px;">
          管理者から届いた<strong>「登録用URL」</strong>を、この画面と同じブラウザで1回開いてください。<br>
          または、下の欄に登録用URLを貼り付けて「登録」を押してください。
        </div>
        <div style="display:flex; gap:8px;">
          <input id="gp-gate-code" type="text" autocomplete="off" placeholder="登録用URLを貼り付け"
                 style="flex:1; min-width:0; padding:10px 12px; font-size:14px; border:2px solid #cbd5e1; border-radius:10px;">
          <button id="gp-gate-btn" type="button"
                  style="padding:10px 16px; background:#2563eb; color:#fff; border:0; border-radius:10px; font-weight:700; cursor:pointer;">登録</button>
        </div>
        <div id="gp-gate-msg" style="min-height:18px; margin-top:8px; font-size:12px; color:#dc2626;"></div>
      </div>
    `;
    document.body.insertBefore(box, document.body.firstChild);
    const input = box.querySelector('#gp-gate-code');
    const msg = box.querySelector('#gp-gate-msg');
    async function tryClaim() {
      const secret = extractSecret(input.value);
      if (!secret) return;
      msg.textContent = '確認中…';
      const r = await window.DB.claimStaffInvite(secret);
      if (r.ok) {
        msg.style.color = '#16a34a';
        msg.textContent = '登録しました。画面を読み込み直します…';
        setTimeout(() => location.reload(), 800);
      } else {
        msg.style.color = '#dc2626';
        msg.textContent = r.reason === 'expired'
          ? 'この登録用URLは期限切れです。管理者に新しいURLをもらってください。'
          : 'この登録用URLは使えません（使用済み・期限切れ・入力ミスのどれかです）。';
      }
    }
    box.querySelector('#gp-gate-btn').addEventListener('click', tryClaim);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') tryClaim(); });
  }

  async function check({ need, block }) {
    const role = await window.DB.getMyRole();
    if (enough(role, need)) return role;
    const show = () => render(need, block);
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', show);
    else show();
    return null;
  }

  window.StaffGate = { check, ROLE_NAME };
})();
