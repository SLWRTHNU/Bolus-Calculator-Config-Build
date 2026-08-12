export function calcNetCarbs(weightG, carbFactor) {
  if (!weightG || !carbFactor) return 0;
  return Math.round(weightG * carbFactor * 10) / 10;
}

export function calcWeightFromCarbs(carbs, carbFactor) {
  if (!carbs || !carbFactor) return 0;
  return Math.round((carbs / carbFactor) * 10) / 10;
}

export function calcCompositeCF(totalCarbs, totalWeight) {
  if (!totalWeight || totalWeight === 0) return 0;
  return Math.round((totalCarbs / totalWeight) * 10000) / 10000;
}

export function calcBolus({ foods, currentBG, targetBG, icr, isf, iob }) {
  const totalNetCarbs = foods.reduce((sum, f) => sum + calcNetCarbs(f.weightG, f.carbFactor), 0);

  const mealBolus = (icr && icr > 0) ? totalNetCarbs / icr : 0;

  let correctionBolus = 0;
  if (isf && isf > 0 && currentBG != null && targetBG != null) {
    correctionBolus = (currentBG - targetBG) / isf;
  }

  const iobOffset = iob || 0;
  const totalBolus = Math.max(0, Math.round((mealBolus + correctionBolus - iobOffset) * 100) / 100);

  return {
    totalNetCarbs: Math.round(totalNetCarbs * 10) / 10,
    mealBolus: Math.round(mealBolus * 100) / 100,
    correctionBolus: Math.round(correctionBolus * 100) / 100,
    iobOffset: Math.round(iobOffset * 100) / 100,
    totalBolus
  };
}

export function mgdlToMmol(mgdl) { return Math.round((mgdl / 18.0) * 10) / 10; }
export function mmolToMgdl(mmol) { return Math.round(mmol * 18.0); }

export function formatBG(value, units) {
  if (value == null) return '--';
  if (units === 'mmol') return (Math.round(value * 10) / 10).toFixed(1);
  return Math.round(value).toString();
}