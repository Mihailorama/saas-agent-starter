/**
 * Currency minor units (ISO 4217 exponent): JPY 0 decimals, KWD 3, most others 2. Provider APIs
 * take integer minor units; config/plans.json writes decimal major units. Twin: worker/billing.py.
 */
const EXPONENT: Record<string, number> = {
  JPY: 0,
  KRW: 0,
  VND: 0,
  CLP: 0,
  ISK: 0,
  KWD: 3,
  BHD: 3,
  JOD: 3,
  OMR: 3,
  TND: 3,
};
export const minorUnits = (currency: string) => EXPONENT[currency.toUpperCase()] ?? 2;
/** "29.00" USD -> 2900; "3000" JPY -> 3000. Rounded to the nearest minor unit. */
export const toMinor = (amount: string | number, currency: string) =>
  Math.round(Number(amount) * 10 ** minorUnits(currency));
/** 2900 USD -> 29; 3000 JPY -> 3000. */
export const fromMinor = (minor: number, currency: string) => minor / 10 ** minorUnits(currency);
