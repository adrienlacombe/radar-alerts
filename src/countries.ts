export const countries = {
  CI: "Côte d’Ivoire",
  SN: "Sénégal",
  ML: "Mali",
  BF: "Burkina Faso",
  BJ: "Bénin",
} as const;
export type CountryCode = keyof typeof countries;

export function configuredCountries(value: string): CountryCode[] {
  const codes = value.split(",").map(v => v.trim());
  if (!codes.length || codes.some(code => !Object.hasOwn(countries, code)) || new Set(codes).size !== codes.length)
    throw new Error("Invalid or duplicate country configuration");
  return codes as CountryCode[];
}

export async function checkCountries(codes: CountryCode[], check: (code: CountryCode) => Promise<void>): Promise<void> {
  // Await every country even if another country's data request fails.
  const results = await Promise.allSettled(codes.map(async code => await check(code)));
  const failed = codes.filter((_code, i) => results[i].status === "rejected");
  if (failed.length) throw new Error(`Country checks failed: ${failed.join(", ")}`);
}
