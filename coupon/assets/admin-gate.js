/* 管理画面パスコードゲート
 * admin.html / for-staff.html の <head> で読み込む。
 * localStorage に認証記録が無ければ、ページ本体を非表示にしてパス入力オーバーレイを表示する。
 * 認証成功で localStorage に記録 → 以降そのブラウザは自動突破。
 * ハッシュはSHA-256（変更時は下の ADMIN_PASS_HASH を差し替え）。
 */
(function () {
  const ADMIN_PASS_HASH = 'fe8532ed501cca6efe64ffdac03e51adff51b1a281cda6b38576237edd4aad0e'; // 'gymplus2026'
  const LS_KEY = 'gymplus_admin_ok_v1';

  // 認証済みなら何もしない
  if (localStorage.getItem(LS_KEY) === ADMIN_PASS_HASH) return;

  // body を隠すため style を head に注入（DOMContentLoaded 前でも効くように）
  const style = document.createElement('style');
  style.textContent = `
    body { visibility: hidden !important; }
    #gp-gate-overlay {
      position: fixed; inset: 0; z-index: 999999;
      background: linear-gradient(135deg, #1e3a8a 0%, #2563eb 100%);
      display: flex; align-items: center; justify-content: center;
      visibility: visible !important;
      font-family: -apple-system, BlinkMacSystemFont, 'Hiragino Kaku Gothic ProN', 'Yu Gothic', sans-serif;
    }
    #gp-gate-card {
      background: #fff; border-radius: 16px; padding: 32px 28px;
      width: 90%; max-width: 380px; box-shadow: 0 20px 60px rgba(0,0,0,0.3);
      text-align: center;
    }
    #gp-gate-card h2 { margin: 0 0 8px; font-size: 20px; color: #1e293b; }
    #gp-gate-card p  { margin: 0 0 20px; font-size: 13px; color: #64748b; line-height: 1.6; }
    #gp-gate-input {
      width: 100%; box-sizing: border-box;
      padding: 14px 16px; font-size: 18px; text-align: center;
      border: 2px solid #cbd5e1; border-radius: 10px; outline: none;
      letter-spacing: 2px; font-family: inherit;
    }
    #gp-gate-input:focus { border-color: #2563eb; }
    #gp-gate-btn {
      margin-top: 14px; width: 100%; padding: 14px;
      background: #2563eb; color: #fff; border: 0; border-radius: 10px;
      font-size: 16px; font-weight: 600; cursor: pointer;
    }
    #gp-gate-btn:hover { background: #1d4ed8; }
    #gp-gate-msg { min-height: 18px; margin-top: 10px; font-size: 12px; color: #dc2626; }
  `;
  document.head.appendChild(style);

  async function sha256(str) {
    const buf = new TextEncoder().encode(str);
    const hash = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  function mount() {
    const overlay = document.createElement('div');
    overlay.id = 'gp-gate-overlay';
    overlay.innerHTML = `
      <div id="gp-gate-card">
        <h2>🔒 スタッフ専用ページ</h2>
        <p>Gym plus 管理者パスコードを入力してください。<br>一度認証すると、この端末では次回以降スキップされます。</p>
        <input id="gp-gate-input" type="password" inputmode="text" autocomplete="off"
               placeholder="パスコード" autofocus>
        <button id="gp-gate-btn" type="button">認証</button>
        <div id="gp-gate-msg"></div>
      </div>
    `;
    document.body.appendChild(overlay);

    const input = overlay.querySelector('#gp-gate-input');
    const btn   = overlay.querySelector('#gp-gate-btn');
    const msg   = overlay.querySelector('#gp-gate-msg');

    async function tryAuth() {
      const val = input.value.trim();
      if (!val) return;
      const h = await sha256(val);
      if (h === ADMIN_PASS_HASH) {
        localStorage.setItem(LS_KEY, ADMIN_PASS_HASH);
        overlay.remove();
        style.remove(); // hidden!important を除去
      } else {
        msg.textContent = 'パスコードが違います';
        input.value = ''; input.focus();
      }
    }

    btn.addEventListener('click', tryAuth);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') tryAuth(); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();
