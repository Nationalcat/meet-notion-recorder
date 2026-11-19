import { afterEach } from 'vitest';

// 任何未處理的錯誤（事件監聽器拋錯、沒人接的 Promise rejection）都讓該測試失敗，
// 而不是在測試結束後才炸掉整個 runner。
const errors = [];
process.on('unhandledRejection', (e) => errors.push(e));
if (typeof window !== 'undefined') {
  window.addEventListener('error', (e) => {
    errors.push(e.error ?? e.message);
    e.preventDefault();
  });
}

afterEach(async () => {
  await new Promise((r) => setImmediate(r));
  const errs = errors.splice(0);
  if (errs.length) throw new Error('未處理的錯誤：' + errs.map((e) => e?.message ?? String(e)).join('；'));
});
