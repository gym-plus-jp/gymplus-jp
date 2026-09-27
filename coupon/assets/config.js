/* Jumpolin クーポンシステム 設定
 * 2026-09-27: Supabase → Firebase (Firestore) に移行。
 * apiKey は Web公開前提のブラウザ用鍵。Firestore ルールで保護している。
 * Firebase プロジェクト: gymplus-coupon-cfd5d（株式会社Gym plus 専用、gymplus0601@gmail.com 所有）
 */
window.GYMPLUS_CONFIG = {
  FIREBASE_CONFIG: {
    projectId: "gymplus-coupon-cfd5d",
    appId: "1:432119379934:web:f8574c68503b8f424fcf4f",
    storageBucket: "gymplus-coupon-cfd5d.firebasestorage.app",
    apiKey: "AIzaSyDTyI8sdMGkWUv095x_3kp5CJH2IgKTW4E",
    authDomain: "gymplus-coupon-cfd5d.firebaseapp.com",
    messagingSenderId: "432119379934",
  },
};
