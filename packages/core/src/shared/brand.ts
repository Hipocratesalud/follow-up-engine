declare const brand: unique symbol;

/**
 * Nominal ("branded") type: a `T` that the compiler will not confuse with
 * another `T` carrying a different brand. A `ClinicId` cannot be passed
 * where a `PatientId` is expected, even though both are strings at runtime.
 */
export type Brand<T, TBrand extends string> = T & { readonly [brand]: TBrand };
