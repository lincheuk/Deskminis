/** Public model specifications. Missing values are unknown, not unsupported.
 * These describe catalog data, not verified capabilities of a configured endpoint. */
export interface ModelCatalogEntry {
  name?: string;
  contextWindow?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  thinking?: boolean;
  toolCall?: boolean;
  structuredOutput?: boolean;
  inputModalities?: string[];
  outputModalities?: string[];
  /** models.dev reasoning_options, normalized. Only kept on a vendor's own record (never aggregated):
   *  an empty object means the record lists no adjustable reasoning parameter; undefined means not stated. */
  reasoningControl?: ReasoningControl;
  /** models.dev cost, normalized (F02). Only kept on a vendor's own record (never aggregated, same rule as reasoningControl):
   *  a relay must not borrow another vendor's price for a same-named model. */
  price?: ModelPrice;
}

/** USD per million tokens, as listed by one vendor for its own endpoint. A listed 0 is not "free": most zero prices in the
 *  catalog are placeholders for subscription / plan billing, so input 0 + output 0 is treated as unknown cost (shared/usage.ts). */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  /** Separate price for reasoning tokens, when the vendor lists one. */
  reasoning?: number;
  /** The record declares context-length price tiers (cost.tiers / cost.context_over_200k): a flat estimate would be wrong. */
  tiered?: true;
}

export interface ReasoningControl {
  /** `toggle`: reasoning can only be switched on or off. */
  toggle?: boolean;
  /** `effort`: accepted effort values, e.g. ['low', 'medium', 'high']. */
  efforts?: string[];
  /** `budget_tokens`: accepted thinking budget range. */
  budget?: { min?: number; max?: number };
}

export type ModelMetadataSource = 'models.dev' | 'basellm' | 'builtin' | 'unknown';

export interface ModelMetadata extends ModelCatalogEntry {
  source: ModelMetadataSource;
  fetchedAt?: number;
  providerId?: string;
  match: 'provider' | 'aggregate' | 'builtin' | 'unknown';
}

export interface ModelCatalogStatus {
  primarySource: 'models.dev';
  apiUrl: string;
  source: ModelMetadataSource;
  fetchedAt?: number;
  stale: boolean;
  modelCount: number;
}
