// 2D overlay: hand skeletons and pinch cursors.
const BONES = [
  [0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [17, 18], [18, 19], [19, 20], [0, 17],
];
const CYAN = '#4de1ff', PINK = '#ff5c8a';

export function drawOverlay(ctx, w, h, hands, showSkeleton) {
  ctx.clearRect(0, 0, w, h);
  for (const hand of hands) {
    if (!hand.present) continue;
    const col = hand.pinching ? PINK : CYAN;

    if (showSkeleton && hand.landmarks) {
      const lm = hand.landmarks;
      ctx.strokeStyle = 'rgba(77,225,255,0.55)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (const [a, b] of BONES) { ctx.moveTo(lm[a].x, lm[a].y); ctx.lineTo(lm[b].x, lm[b].y); }
      ctx.stroke();
      ctx.fillStyle = CYAN;
      for (const p of lm) { ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, Math.PI * 2); ctx.fill(); }
    }

    // pinch cursor
    ctx.strokeStyle = col;
    ctx.lineWidth = hand.pinching ? 4 : 2;
    ctx.beginPath();
    ctx.arc(hand.x, hand.y, hand.pinching ? 12 : 18, 0, Math.PI * 2);
    ctx.stroke();
    if (hand.pinching) { ctx.fillStyle = col; ctx.beginPath(); ctx.arc(hand.x, hand.y, 4, 0, Math.PI * 2); ctx.fill(); }
  }
}
