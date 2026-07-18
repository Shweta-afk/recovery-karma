// Green → amber → red interpolation for a 1..N leaderboard rank badge.

function lerp(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t);
}

/** Background + text color for `rank` out of `total` (1 = best, green; total = worst, red). */
export function rankColor(rank: number, total: number): { bg: string; fg: string } {
  if (total <= 1) return { bg: "#22c55e", fg: "#ffffff" };
  const t = (rank - 1) / (total - 1); // 0 = best .. 1 = worst

  // green (34,197,94) -> amber (245,158,11) -> red (239,68,68)
  const stops = [
    { at: 0,   c: [34, 197, 94] },
    { at: 0.5, c: [245, 158, 11] },
    { at: 1,   c: [239, 68, 68] },
  ];
  let lo = stops[0], hi = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i++) {
    if (t >= stops[i].at && t <= stops[i + 1].at) { lo = stops[i]; hi = stops[i + 1]; break; }
  }
  const span = hi.at - lo.at || 1;
  const localT = (t - lo.at) / span;
  const [r, g, b] = [
    lerp(lo.c[0], hi.c[0], localT),
    lerp(lo.c[1], hi.c[1], localT),
    lerp(lo.c[2], hi.c[2], localT),
  ];
  return { bg: `rgb(${r}, ${g}, ${b})`, fg: "#ffffff" };
}
