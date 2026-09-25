/**
 * Jev's list price per million input tokens in USD (output tokens are free), as published
 * at https://docs.typesafe.ai/models. Used only for cost estimates in stats.
 */
export const JEV_USD_PER_MILLION_INPUT_TOKENS = 0.042;

export function estimateCostUsd(inputTokens: number, usdPerMillion = JEV_USD_PER_MILLION_INPUT_TOKENS): number {
  return (inputTokens / 1_000_000) * usdPerMillion;
}
