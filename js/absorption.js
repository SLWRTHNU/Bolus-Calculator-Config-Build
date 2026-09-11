export function estimateAbsorption(meta) {
  const netCarbs  = Number(meta.netCarbs  || 0);
  const fat       = Number(meta.fat       || 0);
  const protein   = Number(meta.protein   || 0);
  const method    = String(meta.method    || '').toLowerCase();
  const texture   = String(meta.texture   || '').toLowerCase();
  const mixedMeal = !!meta.mixedMeal;
  let t = 3.0;
  if      (netCarbs >= 40) t += 0.5;
  else if (netCarbs >= 25) t += 0.25;
  if      (fat >= 15) t += 1.0;
  else if (fat >= 10) t += 0.75;
  else if (fat >= 7)  t += 0.5;
  else if (fat >= 4)  t += 0.25;
  if      (protein >= 25) t += 0.5;
  else if (protein >= 15) t += 0.25;
  switch (method) {
    case 'fried':                                           t += 0.5;  break;
    case 'baked': case 'toasted': case 'air_fryer':
    case 'pan_fried_oil':                                   t += 0.25; break;
    case 'boiled_steamed':                                  t -= 0.25; break;
  }
  switch (texture) {
    case 'liquid': case 'blended': t -= 0.5;  break;
    case 'mashed_soft':            t -= 0.25; break;
  }
  if (mixedMeal) t += 0.25;
  return Math.round(Math.max(2.0, Math.min(6.0, t)) * 2) / 2;
}